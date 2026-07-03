# Micro Rework Spec

Status: **design approved, not started**. Micro is currently unused in production. It stays in the library, but it does not get promoted or documented for consumers until every item in this spec lands. This is the correction pass, specced as its own piece of work.

## Why a rework and not patches

A deep review verified 12 bugs in `src/micro/` (3 critical), each independently confirmed with a runnable repro. They are not 12 separate accidents. They cluster around four missing pieces of design:

1. **No change identity.** Commits and broadcasts carry no change id, so nobody can tell "my own echo" from "someone else's change," and retries can't be deduped.
2. **No resync story.** There is no gap detection, no reconnect catch-up, and compaction breaks the one transform path that exists.
3. **No durability contract.** The in-flight (sending) layer lives only in memory, and several failure paths silently discard persisted edits.
4. **No concurrency contract on the server.** The fallback commit path is a read-modify-write with no serialization, documented as "safe for single-server deployments." It isn't.

Patch any one bug and the neighbors still corrupt the doc. Fix the four design gaps and all 12 bugs fall out. That is what this spec does.

## Invariants (the contract micro must hold)

- **Convergence**: after quiescence, every replica that saw the same commits has identical state, regardless of message ordering (HTTP response vs WS broadcast) or disconnect windows.
- **Idempotency**: retrying any commit, and receiving any broadcast any number of times, changes nothing after the first application.
- **Durability**: an edit accepted by `update()` survives crash, app close, and offline restarts until the server acks it.
- **Server authority**: the server's transformed result is the truth. Clients never trust their own untransformed ops as the committed value.

Every change below exists to serve one of these four.

## Design changes

### 1. Change identity end to end

- Every flush mints a `changeId` (crypto-id), persisted with the sending layer.
- `POST /docs/:id/changes` carries `{ changeId, rev, fields }`. The commit result and the WS broadcast both carry it back.
- The server keeps recently committed change ids per doc with a TTL, using the same mechanism specced for LWWServer (see `docs/last-write-wins.md` idempotency section). A retried commit whose id was seen returns the current committed fields for the touched paths, without re-applying. This is what makes `+` and `~` retry-safe; they are not idempotent ops on their own.
- `MicroDoc.applyRemote` drops any message whose `changeId` matches its own in-flight send (that is a confirm, handled by the confirm path) and any message with `rev <= this.rev` (stale echo). Fixes #43.

### 2. Confirm and echo flow

- `_confirmSend(result)` composes `result.fields` — the server-transformed values — into `confirmed`. The raw `_sending` delta is never composed into confirmed state. Fixes #46.
- If `result.rev > this.rev + 1`, concurrent commits happened that local pending ops were never transformed against: trigger a resync (below) before confirming. Fixes the other half of #46.
- Broadcasts are origin-tagged by `changeId`; the server may still send them to the origin (simpler fan-out), because the client-side guards make them no-ops.

### 3. Resync protocol

One endpoint, used everywhere state might have diverged: `GET /docs/:id/changes?since=rev` returning `{ rev, fields, textLog }` (this matches the README; the client's undocumented `/sync` URL goes away — fixes half of #48).

Resync triggers:

- WS `onopen` (reconnect), for every open doc: fetch since `doc.rev`. Fixes #45.
- Broadcast gap: `msg.rev > doc.rev + 1` → resync instead of applying. Fixes #45.
- Confirm gap (above). Fixes #46.
- Compaction rejection (below). Fixes #53.

Reconcile rule: replace `confirmed` fields with the returned fields (never compose — composing doubles text), then rebase pending/sending `#` deltas via `transformPendingTxt` against the returned `textLog`. Non-text pending ops need no transform.

On `open()`, if the incremental fetch fails, **keep pending ops**. Non-text ops commit safely as-is; text deltas are OT-transformed by the server against its log since `change.rev`. The current behavior (clear `pending` whenever remote rev advanced) silently destroys offline work and is the reason #48 is a data-loss bug rather than a papercut.

### 4. Durability

- `_idbSave` persists `consolidateOps(sending ?? {}, pending)` plus the `sendingId`, not just confirmed + pending. A restarted client re-sends the same `changeId`; the server's id dedup makes that safe.
- Save on every `update()` (via `_onUpdate`), after `_flush()` moves ops into sending, and after `_failSend` rolls them back. Today the only save is after a successful confirm, which is exactly when durability no longer matters. Fixes #44.

### 5. Server commit atomicity

- `commitChanges` is serialized per doc id with the same per-doc promise-queue pattern used elsewhere in the library (`docs/concurrency.md`).
- The non-atomic `_commit` fallback validates `expectedRev` under that lock and retries on mismatch, instead of blindly writing `expectedRev + 1`.
- Docs stop claiming the fallback is "safe for single-server deployments" until both of the above are true; then the claim is accurate. Fixes #47.

### 6. Text log compaction

- A compacted entry records its range: `{ startRev, rev, delta }`.
- A commit or catch-up whose base rev falls strictly inside a compacted range cannot be transformed (the log no longer has the individual frames). The server rejects with a resync signal; the client reconciles from the snapshot per section 3. Fixes #53.

### 7. ObjectStore refs

Refs never escape the server. Every read path hydrates: `commitChanges`' `existing` lookup (before `#` compose and LWW/`^` comparison), `getDoc`, and `getChangesSince` resolve `{ __ref }` stubs via `ObjectStore.get` before use. Today nothing ever calls `get`, which is how a 64KB text plus one keystroke becomes a 1-character document. Fixes #49.

If hydrate-on-every-read proves too chatty for the hot path, the alternative is refs at the `DbBackend` boundary only (fields always hold real values in memory). Either is acceptable; stubs visible to `commitChanges` or clients are not.

### 8. Ops semantics

Three corrections in `ops.ts`, mirrored on the server where duplicated:

- `^` (max) with no existing value: incoming wins. Not `max(0, incoming)`, which silently drops negative numbers and strings and then crashes `buildState` on the client. Fixes #50.
- `consolidateOps` merging a combinable op onto a differently-typed pending op keeps the pending op's type and applies the operation to its value: `set(5)` then `inc(1)` is `{ op: '=', val: 6 }`, never `{ op: '+', val: 6 }`. The LWW implementation (`src/algorithms/lww/consolidateOps.ts`) already does this correctly; micro copies it. Fixes #51.
- `=` / `!` on a parent path tombstones all `parent.*` child fields (LWW ts-respecting), on client and server, and the deletions ride along in `resultFields` so replicas converge. `buildState` clones values before nesting so stored fields are never mutated by reference. Fixes #52.

## Finding disposition

| #   | Severity | Fixed by section |
| --- | -------- | ---------------- |
| 43  | critical | 1, 2             |
| 44  | high     | 4                |
| 45  | critical | 3                |
| 46  | high     | 2, 3             |
| 47  | high     | 5                |
| 48  | high     | 3                |
| 49  | critical | 7                |
| 50  | medium   | 8                |
| 51  | high     | 8                |
| 52  | high     | 8                |
| 53  | high     | 6                |
| —   | protocol | 1 (id dedup TTL) |

## Test plan

Micro currently has **zero tests**. The rework is not done until these exist and pass:

**Unit** (`tests/micro/ops.spec.ts`, `doc.spec.ts`, `server.spec.ts`):

- ops: every suffix type × (fresh field, existing same-type, existing `=`, existing `!`), parent-set pruning, buildState no-aliasing
- doc: confirm with transformed fields, stale-rev/own-id broadcast drops, sending-layer persistence round-trip
- server: per-doc serialization under concurrent commits, id dedup + echo of current fields on retry, expectedRev validation in the fallback, ref hydration on all three read paths, compaction range rejection

**Integration** (`tests/micro/integration.spec.ts`, real client + server over in-memory transports):

- single online client types; converges with no duplication in both echo orderings (the #43 repro, pinned)
- two clients concurrent text + increments; convergence after quiescence
- disconnect, miss N broadcasts, reconnect; convergence (the #45 repro, pinned)
- HTTP-confirm-before-broadcast race (the #46 repro, pinned)
- crash mid-send (drop the in-memory client, reopen from IDB); edit survives and re-sends idempotently
- offline edits + failed incremental fetch on open; pending survives and commits
- 64KB+ text through ObjectStore; append does not erase (the #49 repro, pinned)

The review's runnable repros live in the session scratchpad and should be converted into these tests rather than rewritten from scratch.

## Work plan

Order matters; later items depend on earlier contracts:

1. Change identity + confirm/echo flow (sections 1, 2) — unblocks everything, kills the worst online-path bug
2. Durability (section 4) — small, independent
3. Resync (section 3) — depends on 1 for id-safe re-sends
4. Server atomicity + compaction + refs (sections 5, 6, 7) — server-only, independent of client work
5. Ops semantics (section 8) — independent, can go first if convenient
6. Test suite fills in with each step; integration suite last
7. README rewrite to match the actual protocol (endpoint names, wiring example including `getChangesSince`)

Estimated shape: the whole module is ~1,200 lines; expect the rework to touch most of it and roughly double it with tests.

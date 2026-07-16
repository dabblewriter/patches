# Poison-pill ejection & quarantine

One terminally-rejected pending change must not block a doc's sync forever. When the
server rejects a commit and _names the culprit change_, PatchesSync can eject that change
into a persistent quarantine, let the rest of the pending work sync past it, and surface
the ejected content back to the app, never silently dropping it.

## Wire contract

A rejection targets ejection only when it is a 4xx `StatusError` carrying:

```ts
data: {
  changeId: string; // the offending change's id
  scope: 'change'; // "this change is the problem; a different change would pass"
}
```

`scope: 'doc'` means the doc/history is the problem (e.g. corrupt committed history); the
client's change is NOT the culprit and is never ejected. Servers must attach
`changeId`/`scope: 'change'` only to change-intrinsic faults, never to predicate failures
(auth, doc-wide state) that would reject every change identically.

`StatusError.data` rides the JSON-RPC error frame over WebSocket and a top-level `data`
key in REST error bodies; both transports rehydrate it onto `StatusError.data` client-side.
Note the REST half is the consuming server's job: its error handler must serialize
`StatusError.data` into the response body or rejections arrive data-less and ejection
never triggers.

## Safety gates

The server's attribution is a suspicion, not a verdict:

1. **Local corroboration.** A named change is auto-ejected only when it ALSO fails a local
   strict-apply probe in its own frame (`verifyPendingChange` — committed-only state for
   LWW, committed + predecessors for OT). A change the server rejected but that applies
   cleanly locally (e.g. a server-side policy rejection) stays put: the doc latches at
   `'error'` with `data.changeId` on the surfaced error, and the app decides: ask the user,
   then call `patches.ejectPendingChange(docId, changeId)`. The probe is re-run atomically
   with the ejection itself (`opts.onlyIfUnappliable`): a server rebase between probe and
   eject can make the change valid again, and ejecting it then would quarantine committable
   work.
2. **Circuit breaker.** At most 3 auto-ejections per doc per session; past that the doc
   latches like any definitive failure, so a systematic mis-attribution can't serially
   drain an offline queue into quarantine.
3. **Atomic quarantine.** The quarantine write and the pending-queue removal are one store
   transaction; a crash between them cannot lose the change.
4. **Never auto-discarded.** Quarantined changes persist until the app calls
   `discardQuarantinedChange` (the user's decision). Untracking a doc preserves its
   quarantined changes (untracking is cache eviction, not a discard decision); only
   deleting the doc removes them along with everything else.

## Client API

```ts
patches.onChangeQuarantined((docId, entry: QuarantinedChange) => { ... });
await patches.ejectPendingChange(docId, changeId, reason?);   // app-consent path
await patches.listQuarantinedChanges(docId?);
await patches.discardQuarantinedChange(docId, changeId);
```

`QuarantinedChange` is `{ docId, changeId, change, reason, quarantinedAt }`; `change.ops`
carries the rejected content (e.g. `@txt` deltas hold the inserted text) for recovery UX.

`onChangeQuarantined` fires on ejection and re-fires persisted entries on a doc's first
sync attempt each session, whether or not that sync succeeds, so an app restart can't
strand a quarantined change un-surfaced. Delivery is at-least-once: key handling on
`docId` + `changeId`.

Persistence: quarantined changes live in the shared `quarantinedChanges` IndexedDB store
(key `[docId, changeId]`), created by `upgradeSharedStores`. Managed-mode databases
self-migrate; external-mode hosts must bump their own DB version so `upgradePatchesDB`
runs, and add `quarantinedChanges` to any store-name registries (export/import tooling).
Until the host does, the store logs a console error at open and quarantine is inert
(`listQuarantinedChanges` returns `[]`; ejection THROWS — auto-eject callers catch and
latch, and the consent path surfaces "could not eject" instead of misreading a null as
resolved), but
previously-working operations keep working.

## Algorithm support

Both algorithms implement ejection.

**LWW.** Its only server-addressable pending identity is the single in-flight sending change,
so ejection clears the sending slot into quarantine; `pendingOps` minted since capture
survive and flush next. No rebasing; LWW pending is path-keyed.

**OT.** An OT pending queue is a _sequential program_ — each change's ops are expressed in the
frame the changes before it produce — so ejecting one change from the middle can't be a plain
splice: its successors were built on top of it and must be rebased into the frame that skips
it. `computePendingEjection` (`src/algorithms/ot/shared/ejectPendingChange.ts`) inverts the
ejected change against the state it applied to (committed + predecessors) and walks that
inverse through the successors with the same one-sided diamond `rebaseChanges` runs for an
incoming server change — the ejected change genuinely preceded them, so its inverse is the
"already-happened" side their position ties yield to. Predecessors are untouched; survivors
are renumbered contiguously off `committedRev`, preserving the pending invariant (all
`baseRev === committedRev`, sequential revs). The server accepts the result as a valid
poison-free queue and both sides converge on it; exact tie-resolution follows the same
one-sided transform as any OT rebase, so at concurrent same-offset ties it is _a_ queue as
if the change were never minted, not provably the unique one. If the ejected change can't be
inverted — including when it no longer applies cleanly to its own frame, where an inverse
would be fabricated from values the change never saw — ejection THROWS and the doc stays
latched rather than risking a half-rebased queue. The throw is deliberately distinct from
the benign null ("nothing matched"): an app running the consent flow must be able to tell a
resolved eject from a doc still wedged behind the change. In practice this means an
un-appliable poison with successors cannot be ejected (only quarantined-at-tail poisons
skip the invert); a queue in that state needs snapshot-reload recovery instead.
`verifyPendingChange` probes the named change in its own frame (committed + predecessors),
not committed-only.

Caveat on the "never silently drops content" guarantee below: it covers the ejected change
(preserved in quarantine). A _successor_ whose edits were scoped to structure the ejected
change created (it added `/a`; the successor set `/a/b`) transforms away to nothing under the
inverse and is dropped — its content is lost, because it edited something the ejection
removes. Dependents of the ejected change are not separately preserved.

Who emits change-scoped OT rejections: the OT _server_ transforms rather than rejects (its few
commit rejections carry `data.scope`, plus `data.changeId` for the root-op guard), but the
consuming app server can reject on policy — e.g. Dabble's Pup rejects a content write from a
role that may not make it, attaching `{ changeId, scope: 'change' }`. Such a change applies
cleanly locally, so `verifyPendingChange` returns true and PatchesSync does NOT auto-eject: the
doc latches with `data.changeId` surfaced for the app to eject on consent.

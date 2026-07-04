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
   strict-apply probe against committed-only state (`verifyPendingChange`). A change the
   server rejected but that applies cleanly locally (e.g. a server-side policy rejection)
   stays put: the doc latches at `'error'` with `data.changeId` on the surfaced error, and
   the app decides: ask the user, then call `patches.ejectPendingChange(docId, changeId)`.
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
(`listQuarantinedChanges` returns `[]`, ejection fails safe to the error latch), but
previously-working operations keep working.

## Algorithm support (v1: LWW only)

LWW's only server-addressable pending identity is the single in-flight sending change, so
ejection clears the sending slot into quarantine; `pendingOps` minted since capture
survive and flush next. No rebasing; LWW pending is path-keyed.

OT ejection (invert + rebase of successors) is deliberately deferred: the OT server
transforms rather than rejects, so there is no live emitter of change-scoped OT
rejections. The OT server's few commit rejections now throw `StatusError` with
`data.scope` (and `data.changeId` for the root-op guard) so clients classify them
correctly, but OT docs latch rather than eject until telemetry proves a real trigger.

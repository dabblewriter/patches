# Algorithm Functions

The core sync logic lives in `src/algorithms/`. This is where [Operational Transformation](operational-transformation.md) and [Last-Write-Wins](last-write-wins.md) actually happen - pure functions that transform, rebase, and reconcile changes.

Why separate algorithms from classes? Because testability isn't optional. Pure functions with no side effects are trivial to unit test. The main orchestration classes ([PatchesSync](PatchesSync.md), [PatchesDoc](PatchesDoc.md), [OTServer](OTServer.md), [LWWServer](LWWServer.md)) coordinate _when_ these functions run. The algorithms handle _what_ happens.

**Table of Contents**

- [Architecture](#architecture)
- [Directory Structure](#directory-structure)
- [Client Algorithms](#client-algorithms)
- [Shared Algorithms](#shared-algorithms)
- [LWW Algorithms](#lww-algorithms)
- [Server Algorithms](#server-algorithms)
- [The Algorithm Layer](#the-algorithm-layer)
- [How It Fits Together](#how-it-fits-together)

## Architecture

The separation of concerns:

| Layer             | Components                                           | Responsibility                  |
| ----------------- | ---------------------------------------------------- | ------------------------------- |
| **Orchestration** | `PatchesSync`, `PatchesDoc`, `OTServer`, `LWWServer` | Coordination and event handling |
| **Algorithm**     | `OTAlgorithm`, `LWWAlgorithm`                        | Algorithm-specific coordination |
| **Pure Functions**| Pure functions in `src/algorithms/`                  | The actual OT/LWW logic         |
| **Storage**       | `IndexedDBStore`, `InMemoryStore`, etc.              | Data persistence only           |
| **Transport**     | WebSocket, WebRTC                                    | Message delivery                |

Stores are intentionally "dumb" - they save and load data, nothing more. Algorithm implementations invoke pure algorithm functions and handle coordination. This keeps each layer focused and testable.

## Directory Structure

```
src/algorithms/
├── client/                        # Client-side algorithms
│   ├── applyCommittedChanges.ts   # Merge server changes with local state
│   ├── createStateFromSnapshot.ts # Build state from snapshot + pending
│   └── makeChange.ts              # Create changes from mutations
├── lww/                           # LWW-specific algorithms
│   ├── consolidateOps.ts          # Op consolidation with timestamp comparison
│   ├── mergeServerWithLocal.ts    # Merge server changes with pending local ops
│   └── index.ts                   # Exports
├── server/                        # Server-side algorithms
│   ├── commitChanges.ts           # Complete change commit workflow
│   ├── createVersion.ts           # Version creation with persistence
│   ├── getSnapshotAtRevision.ts   # Server snapshot retrieval
│   ├── getStateAtRevision.ts      # Server state retrieval
│   ├── handleOfflineSessionsAndBatches.ts # Offline sync handling
│   └── transformIncomingChanges.ts # Core OT transformation logic
└── shared/                        # Used by client and server
    ├── applyChanges.ts            # Apply changes to state
    ├── changeBatching.ts          # Split/batch changes for network
    ├── lz.ts                      # LZ-String compression utilities
    └── rebaseChanges.ts           # Core OT rebasing
```

## Client Algorithms

These handle client-side state management. Used by [PatchesDoc](PatchesDoc.md) and client algorithm implementations.

### applyCommittedChanges

```typescript
function applyCommittedChanges(snapshot: PatchesSnapshot, committedChangesFromServer: Change[]): PatchesSnapshot;
```

The workhorse of client sync. When the server sends confirmed changes:

1. Filters out changes already reflected in the snapshot
2. Applies new server changes to the committed state
3. Rebases pending local changes against the server changes (using `rebaseChanges`)
4. Returns updated snapshot with new state, revision, and rebased pending changes

Handles a special case: root-level replace (`path: ''`) is allowed to skip revisions. This happens when an offline client syncs with an existing document - instead of replaying thousands of historical changes, the server sends one synthetic change with the full current state.

### createStateFromSnapshot

```typescript
function createStateFromSnapshot(snapshot: PatchesSnapshot): any;
```

Computes the live document state from a snapshot. Applies pending changes to the base state. Simple, but essential for reconstructing what the user should see.

### makeChange

```typescript
function makeChange(
  snapshot: PatchesSnapshot,
  mutator: (draft: any) => void,
  changeMetadata?: object,
  maxPayloadBytes?: number
): { changes: Change[]; state: any };
```

Powers `PatchesDoc.change()`. Give it a snapshot and a mutator function, and it:

1. Creates a proxy draft of the current state
2. Runs your mutator against the draft
3. Extracts [JSON Patch](json-patch.md) operations from the mutations
4. Builds `Change` object(s) with proper metadata
5. Splits oversized changes using `breakChanges` if needed

## Shared Algorithms

Used by both client and server. The core building blocks.

### applyChanges

```typescript
function applyChanges(state: any, changes: Change[]): any;
```

Applies a sequence of changes to a state object. Each change's operations execute in order. Returns the new state. Fundamental to everything else.

### changeBatching

Three functions for handling large changes:

**`breakChanges(changes, maxBytes)`** - Splits oversized changes into smaller pieces. Tries splitting by individual ops first. If a single op is still too big (like a massive text insert), it breaks that op down further using compression-aware splitting.

**`breakChangesIntoBatches(changes, maxPayloadBytes?)`** - Groups changes into network-sized batches. Respects the byte limit while keeping changes together when possible.

**`getJSONByteSize(data)`** - Estimates the JSON-serialized size of data. Used by the batching functions to stay under limits.

### lz (compression utilities)

LZ-String compression for efficient storage and transmission:

```typescript
function compress(input: string): string;
function decompress(compressed: string): string | null;
function compressToBase64(input: string): string;
function decompressFromBase64(compressed: string): string | null;
function compressToUint8Array(input: string): Uint8Array;
function decompressFromUint8Array(compressed: Uint8Array): string | null;
```

Used internally for compressing large payloads. The Base64 variants work well for storage; Uint8Array variants for binary protocols.

### rebaseChanges

```typescript
function rebaseChanges(serverChanges: Change[], localChanges: Change[]): Change[];
```

The heart of client-side [Operational Transformation](operational-transformation.md). When the server has changes your local pending changes don't know about, this function rewrites your local changes to work _on top of_ the server's version.

The algorithm:

1. Filters out local changes already present in server changes (by ID)
2. Creates a transform patch from the remaining server changes
3. Transforms each local change's ops against that patch
4. Updates revision numbers to follow the server's latest
5. Drops any changes that become empty after transformation

This prevents your edits from overwriting someone else's work. Your pending changes get "rebased" - rewritten as if you made them after seeing the server's changes.

## LWW Algorithms

[Last-Write-Wins](last-write-wins.md) uses a simpler conflict resolution model: compare timestamps, higher wins. These algorithms live in `src/algorithms/lww/`.

### consolidateFieldOp

```typescript
function consolidateFieldOp(existing: JSONPatchOp, incoming: JSONPatchOp): JSONPatchOp | null;
```

Consolidates two ops on the same path. Returns `null` if existing wins (incoming should be dropped).

**Combinable ops** (`@inc`, `@bit`, `@max`, `@min`) merge intelligently:

| Op     | Behavior          |
| ------ | ----------------- |
| `@inc` | Sums the values   |
| `@bit` | Combines bitmasks |
| `@max` | Keeps the maximum |
| `@min` | Keeps the minimum |

**All other ops**: Incoming wins unless existing has a strictly newer timestamp. Ties go to incoming.

### consolidateOps

```typescript
function consolidateOps(
  existingOps: JSONPatchOp[],
  newOps: JSONPatchOp[]
): { opsToSave: JSONPatchOp[]; pathsToDelete: string[]; opsToReturn: JSONPatchOp[] };
```

The main [LWWServer](LWWServer.md) algorithm. Consolidates incoming ops against existing state:

- **Timestamp comparison**: `incoming.ts >= existing.ts` means incoming wins
- **Parent hierarchy**: Setting `/user` to a primitive deletes all ops under `/user/name`, `/user/email`, etc.
- **Invalid hierarchies**: If a parent is primitive, child ops can't apply. Returns correction ops for the client.

Returns:

- `opsToSave`: Consolidated ops to persist
- `pathsToDelete`: Child paths to remove
- `opsToReturn`: Correction ops for the client

### convertDeltaOps

```typescript
function convertDeltaOps(ops: JSONPatchOp[]): JSONPatchOp[];
```

Converts delta ops into concrete `replace` ops with computed values. Used when sending ops to clients that expect standard [JSON Patch](json-patch.md) operations.

### mergeServerWithLocal

```typescript
function mergeServerWithLocal(serverChanges: Change[], localOps: JSONPatchOp[]): Change[];
```

Client-side algorithm for combining server changes with pending local ops. Used when applying server responses:

- For paths the server touched: If local has a delta op (`@inc`, etc.), apply it to server value. Otherwise, keep server value.
- For paths the server didn't touch: Keep local ops so they still apply to state.

This ensures delta ops accumulate correctly even when the server returns intermediate values.

## Server Algorithms

Server-side state management. Used by [OTServer](OTServer.md).

### commitChanges

```typescript
function commitChanges(
  store: OTStoreBackend,
  docId: string,
  changes: Change[],
  sessionTimeoutMillis: number,
  options?: { forceCommit?: boolean }
): Promise<{ committedChanges: Change[]; newChanges: Change[] }>;
```

The complete workflow for committing client changes. Handles:

- Validation and idempotency checks
- Offline session management
- Version creation
- Operational transformation against concurrent changes
- Persistence

Returns both previously committed changes (for catchup) and newly transformed changes. Pass `forceCommit: true` to preserve changes even when they result in no state modification (useful for migrations).

This is the brain behind `OTServer.commitChanges()`.

### createVersion

```typescript
function createVersion(
  store: OTStoreBackend,
  docId: string,
  state: any,
  changes: Change[],
  metadata?: EditableVersionMetadata
): Promise<void>;
```

Creates and persists a new version snapshot. Handles ID generation, metadata setup, and storage. Used by `OTServer.captureCurrentVersion()`. See [PatchesHistoryManager](PatchesHistoryManager.md) for version management.

### transformIncomingChanges

```typescript
function transformIncomingChanges(
  changes: Change[],
  stateAtBaseRev: any,
  committedChanges: Change[],
  currentRev: number,
  forceCommit?: boolean
): Change[];
```

Server-side [Operational Transformation](operational-transformation.md). Transforms incoming client changes against any changes committed since the client's base revision. Ensures proper conflict resolution and sequential revision assignment.

When `forceCommit` is true, changes are preserved even if they result in empty ops. Core to the `commitChanges` workflow.

### getSnapshotAtRevision / getStateAtRevision

Server state reconstruction - loads the appropriate snapshot and applies changes to reconstruct state at any revision. Essential for historical queries and transformation.

### handleOfflineSessionsAndBatches

Manages offline sync complexity: processing offline sessions, multi-batch uploads, and version creation for offline work. See [persist](persist.md) for offline support details.

## The Algorithm Layer

Between orchestration classes and pure algorithm functions, **algorithm implementations** handle coordination:

- **`OTAlgorithm`**: Invokes OT algorithms like `rebaseChanges` and `applyCommittedChanges`
- **`LWWAlgorithm`**: Invokes LWW algorithms and handles field consolidation

Algorithm implementations work with their matching stores (`OTClientStore` or `LWWClientStore`) and call the right pure functions at the right time. Stores stay "dumb" (data in, data out). Algorithm implementations handle the smarts.

## How It Fits Together

Here's [PatchesSync](PatchesSync.md) applying server changes - notice how the algorithm does the heavy lifting:

```typescript
async _applyServerChangesToDoc(docId, serverChanges, sentPendingRange?) {
  const currentSnapshot = await this.store.getDoc(docId);

  // Pure function handles the OT complexity
  const { state, rev, changes: pendingChanges } = applyCommittedChanges(currentSnapshot, serverChanges);

  // Store just persists the result
  await this.store.saveCommittedChanges(docId, serverChanges, sentPendingRange);
  await this.store.replacePendingChanges(docId, pendingChanges);

  // Doc just updates its state
  const doc = this.patches.getOpenDoc(docId);
  if (doc) {
    if (doc.committedRev === serverChanges[0].rev - 1) {
      doc.applyCommittedChanges(serverChanges, pendingChanges);
    } else {
      doc.import({ state, rev, changes: pendingChanges });
    }
  }
}
```

[PatchesDoc](PatchesDoc.md) uses `makeChange` to create edits. When server updates arrive, it either imports the new snapshot or applies committed changes directly. The sync coordinator ([PatchesSync](PatchesSync.md)) tells it what happened; the doc just updates its state.

This separation pays off in three ways:

1. **Testability**: Algorithm functions are trivial to unit test in isolation
2. **Reusability**: Building your own sync layer? Import the algorithms directly
3. **Clarity**: Each layer has one job, making the codebase navigable

The algorithms directory shows you exactly how OT and LWW work. The orchestration classes show you the higher-level flow. Both are approachable because neither tries to do the other's job.

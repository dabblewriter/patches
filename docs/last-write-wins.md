# Last-Write-Wins: Simple Sync That Actually Works

Most collaborative apps don't need the complexity of Operational Transformation. If you're building settings panels, status dashboards, or any feature where users edit different parts of the data, Last-Write-Wins (LWW) gives you real-time sync with a fraction of the complexity.

**Table of Contents**

- [When to Use LWW](#when-to-use-lww)
- [Core Concepts](#core-concepts)
- [How It's Different from OT](#how-its-different-from-ot)
- [The Architecture](#the-architecture)
- [Client-Server Flow](#client-server-flow)
- [The Key Players](#the-key-players)
- [Batching Operations with LWWBatcher](#batching-operations-with-lwwbatcher)
- [Algorithm Functions](#algorithm-functions)
- [Backend Store Interface](#backend-store-interface)
- [Using LWW and OT Together](#using-lww-and-ot-together)
- [Why LWW Works](#why-lww-works)

## When to Use LWW

Here's the decision framework:

**Use LWW when:**

- Users typically modify different fields (settings, preferences, dashboards)
- "Last one wins" is the expected behavior when conflicts occur
- You want a simpler mental model and codebase
- You're storing structured data with independent properties

**Use OT when:**

- Multiple users edit the same text content simultaneously
- Conflicts need intelligent merging rather than overwriting
- You're building a document editor where concurrent changes to the same paragraph happen frequently

See [Operational Transformation](operational-transformation.md) for more on when OT is the right choice.

### Real-World Examples

| Use Case                   | Strategy | Why                                                           |
| -------------------------- | -------- | ------------------------------------------------------------- |
| Design tools (Figma-style) | LWW      | Users drag different objects; last position wins              |
| Task managers              | LWW      | Users update different task fields; conflicts are rare        |
| User settings/preferences  | LWW      | Single user editing; timestamps prevent stale writes          |
| Collaborative whiteboards  | LWW      | Each sticky note is independent; position overwrites are fine |
| Real-time dashboards       | LWW      | Status fields update independently                            |
| Document editors           | OT       | Same paragraph edited by multiple people needs merging        |
| Collaborative text         | OT       | Character-level conflicts need transformation                 |

The rule of thumb: if conflicts feel like "whoever saved last should win," use LWW. If conflicts feel like "we need to keep both changes," use OT.

## Core Concepts

### Timestamps Are Everything

Every operation in LWW carries a timestamp. When two changes hit the same field, the one with the higher timestamp wins. Simple.

```typescript
// Client makes a change using the proxy-based API
doc.change((patch, path) => {
  patch.replace(path.user.name, 'Alice');
});

// Under the hood, the operation gets timestamped:
{
  op: 'replace',
  path: '/user/name',
  value: 'Alice',
  ts: 1738761234567  // Unix timestamp in milliseconds
}
```

The server doesn't transform operations. It just compares timestamps. If the incoming timestamp is greater than or equal to the existing one, incoming wins. Otherwise, existing wins. That's the entire conflict resolution algorithm.

### Fields, Not Changes

OT stores a linear history of changes. Every edit is recorded, and you can replay the entire history to reconstruct any state.

LWW stores fields. Each path in your document maps to a single operation with a timestamp. When you update `/user/name`, it overwrites the previous value for that path. There's no history of what `/user/name` used to be.

```typescript
// OT stores: [change1, change2, change3, ...]
// LWW stores: {
//   '/user/name': { op: 'replace', value: 'Alice', ts: 123, rev: 5 },
//   '/user/email': { op: 'replace', value: 'alice@example.com', ts: 124, rev: 5 },
//   '/settings/theme': { op: 'replace', value: 'dark', ts: 100, rev: 3 }
// }
```

This is a feature, not a limitation. For most real-time data, you don't need a complete history. You need the current state to be correct.

### Parent Hierarchy

When you write to a parent path, it deletes all children. If you set `/user` to a new object, any existing ops at `/user/name` or `/user/email` get deleted.

```typescript
// Before: ops at /user/name and /user/email exist
doc.change((patch, path) => {
  patch.replace(path.user, { name: 'Bob' });
});
// After: only /user exists; /user/name and /user/email are gone
```

This makes sense if you think about it. If you replace an entire object, the previous children are meaningless.

The server also validates hierarchy consistency. If `/user/name` is a string and you try to write `/user/name/first`, the server returns a correction operation. You can't create children under primitive values.

### No Transformation Needed

OT's complexity comes from transformation functions. When two concurrent edits happen, OT has to figure out how to combine them intelligently.

LWW doesn't transform. If two people edit the same field at the same time, one wins and one loses. The higher timestamp wins. If timestamps tie, the incoming operation wins.

This means LWW is:

- Simpler to implement
- Easier to reason about
- Faster to process
- More predictable in behavior

The tradeoff is that you lose one person's edit when conflicts happen. For most non-text data, this is exactly what you want.

## How It's Different from OT

| Aspect                  | OT                                 | LWW                                   |
| ----------------------- | ---------------------------------- | ------------------------------------- |
| **Storage model**       | List of changes                    | Map of paths to ops                   |
| **Conflict resolution** | Transform operations to merge both | Higher timestamp wins                 |
| **Server processing**   | Transform, rebase, assign revision | Compare timestamps, store winner      |
| **History**             | Complete change history            | Current state only                    |
| **Complexity**          | Higher (transformation logic)      | Lower (timestamp comparison)          |
| **Best for**            | Collaborative text editing         | Settings, dashboards, structured data |

**Mental model comparison:**

- **OT**: "Both edits happened; let's merge them intelligently"
- **LWW**: "There's only one current value; the latest write determines it"

## The Architecture

### Client Side

```
Patches (coordinator)
    └── LWWStrategy (algorithm orchestration)
            ├── LWWClientStore (persistence)
            └── LWWDoc (document state)
```

**LWWStrategy** owns the algorithm logic:

- Adds timestamps to operations
- Consolidates pending ops using the `consolidateOps` algorithm
- Merges server changes with local ops using `mergeServerWithLocal`
- Coordinates between store and doc

**LWWClientStore** handles persistence (see [Persistence](persist.md)):

- Stores pending ops by path
- Manages the sending change lifecycle
- Applies server changes with timestamp comparison
- Reconstructs state from snapshot + committed ops + pending ops

**LWWDoc** manages document state (see [PatchesDoc](PatchesDoc.md)):

- Tracks current state and committed revision
- Provides the `change()` API for making edits
- Emits update events for UI

### Server Side

```
LWWServer (request handler)
    └── LWWStoreBackend (persistence)
```

**[LWWServer](LWWServer.md)** processes client requests:

- Uses `consolidateOps` algorithm for conflict resolution
- Converts delta ops to concrete values
- Returns catchup ops for out-of-sync clients
- Broadcasts committed changes to other clients

**LWWStoreBackend** persists field data:

- Stores ops by path with timestamps
- Provides snapshot compaction
- Supports sinceRev queries for catchup

## Client-Server Flow

Let's walk through a complete sync cycle.

### 1. Client Makes a Change

Alice updates her display name:

```typescript
doc.change((patch, path) => {
  patch.replace(path.user.displayName, 'Alice Smith');
});
```

**What happens:**

1. `BaseDoc.change()` captures the op via proxy
2. `LWWStrategy.handleDocChange()` receives the op via `onChange` signal
3. Strategy adds timestamp: `{ op: 'replace', path: '/user/displayName', value: 'Alice Smith', ts: 1738761234567 }`
4. Strategy calls `consolidateOps` to merge with any existing pending ops for that path
5. Strategy saves consolidated ops via `store.savePendingOps()`
6. Strategy creates a Change and calls `doc.applyChanges()` to update local state
7. Doc emits `onUpdate` for UI updates

### 2. Client Sends to Server

When `PatchesSync` is ready to send:

```typescript
// LWWStrategy.getPendingToSend() builds a change from pending ops
const change = {
  id: 'abc123',
  ops: [{ op: 'replace', path: '/user/displayName', value: 'Alice Smith', ts: 1738761234567 }],
  baseRev: 5, // Client's last known server revision
  rev: 6, // Optimistic next revision
};
```

The ops move from `pendingOps` to `sendingChange` atomically. This ensures retries send the same change.

### 3. Server Processes Changes

The server receives the change and uses `consolidateOps`:

```typescript
// LWWServer.commitChanges()
const { opsToSave, pathsToDelete, opsToReturn } = consolidateOps(existingOps, newOps);
```

The algorithm:

1. Checks for parent hierarchy issues (returns correction ops if invalid)
2. For each new op, compares with existing op at that path
3. Higher timestamp wins; combinable ops (like `@inc`) are merged
4. Returns ops to save, paths to delete (when parent overwrites children), and correction ops

If Alice's timestamp (1738761234567) beats the existing timestamp, her op wins.

### 4. Server Returns Response

```typescript
{
  id: 'abc123',
  ops: [
    // Catchup ops: anything that changed since client's baseRev (that client didn't send)
    { op: 'replace', path: '/user/avatar', value: 'new-avatar.png', ts: 1738761234000, rev: 6 },
  ],
  baseRev: 5,
  rev: 7,  // Server's new revision
  committedAt: 1738761234600
}
```

The response contains:

- Any catchup ops the client missed (other users' changes)
- The new server revision
- The commit timestamp

### 5. Client Applies Response

```typescript
// LWWStrategy.applyServerChanges()
await store.applyServerChanges(docId, serverChanges);

// Compute merged changes using the algorithm
const sendingChange = await store.getSendingChange(docId);
const pendingOps = await store.getPendingOps(docId);
const localOps = [...(sendingChange?.ops ?? []), ...pendingOps];
const mergedChanges = mergeServerWithLocal(serverChanges, localOps);

// Apply to document
doc.applyChanges(mergedChanges);
```

The `mergeServerWithLocal` algorithm handles the case where:

- Server sent ops for paths the client has pending delta ops (`@inc`, etc.)
- Server didn't touch paths the client has pending ops for

Delta ops get applied to server values. Non-delta pending ops stay pending (they'll win on next sync if their timestamp is higher).

### 6. Confirmation and Cleanup

```typescript
// After successful server response
await strategy.confirmSent(docId, changes);
// This clears sendingChange - those ops are now committed
```

The cycle is complete. The client's state reflects:

- Server-committed changes (with updated committedRev)
- Any remaining pending local changes (waiting to be sent)

## The Key Players

### LWWStrategy

The client-side coordinator. Owns the algorithm logic.

```typescript
class LWWStrategy implements ClientStrategy {
  readonly name = 'lww';
  readonly store: LWWClientStore;

  // Creates timestamped ops, consolidates with pending, saves to store
  async handleDocChange(docId, ops, doc, metadata): Promise<Change[]>;

  // Builds change from pending ops, moves to sendingChange
  async getPendingToSend(docId): Promise<Change[] | null>;

  // Applies server changes, merges with local ops
  async applyServerChanges(docId, serverChanges, doc): Promise<Change[]>;

  // Clears sendingChange after server ack
  async confirmSent(docId, changes): Promise<void>;
}
```

### LWWServer

The server-side authority. Processes changes and maintains field state. See [LWWServer documentation](LWWServer.md) for full details.

```typescript
class LWWServer implements PatchesServer {
  // Get current state (snapshot + ops)
  async getDoc(docId): Promise<PatchesState>;

  // Synthesize change from ops since revision
  async getChangesSince(docId, rev): Promise<Change[]>;

  // Main entry point: consolidate, store, return catchup
  async commitChanges(docId, changes): Promise<Change[]>;

  // Soft delete with tombstone
  async deleteDoc(docId): Promise<void>;

  // Signals for real-time broadcast
  onChangesCommitted: Signal<(docId, changes, originClientId?) => void>;
  onDocDeleted: Signal<(docId, options?, originClientId?) => void>;
}
```

### LWWClientStore

The client-side persistence interface. Stores pending ops and committed state. See [Persistence](persist.md) for implementation options.

```typescript
interface LWWClientStore extends PatchesStore {
  // Get pending ops, optionally filtered by path prefixes
  getPendingOps(docId, pathPrefixes?): Promise<JSONPatchOp[]>;

  // Save pending ops, delete consolidated paths
  savePendingOps(docId, ops, pathsToDelete?): Promise<void>;

  // Get in-flight change for retry
  getSendingChange(docId): Promise<Change | null>;

  // Atomically save sending change AND clear pending ops
  saveSendingChange(docId, change): Promise<void>;

  // Clear sendingChange after server ack
  confirmSendingChange(docId): Promise<void>;

  // Apply server changes with LWW timestamp resolution
  applyServerChanges(docId, serverChanges): Promise<void>;
}
```

**State reconstruction in `getDoc`:**

```
snapshot -> apply committedOps -> apply sendingChange.ops -> apply pendingOps -> return state
```

### Change Object

The wire format for operations:

```typescript
interface Change {
  id: string; // Unique identifier
  ops: JSONPatchOp[]; // Operations with timestamps
  baseRev: number; // Server revision client was based on
  rev: number; // Server-assigned revision after commit
  createdAt: number; // When created (client timestamp)
  committedAt: number; // When committed (server timestamp, 0 if pending)
}

interface JSONPatchOp {
  op: 'replace' | 'remove' | '@inc' | '@bit' | '@max' | '@min';
  path: string;
  value?: any;
  ts?: number; // Timestamp for LWW comparison
  rev?: number; // Revision (set by server)
}
```

## Batching Operations with LWWBatcher

When you need to accumulate many operations before sending them to the server—like in migration scripts or bulk import tools—creating individual Change objects for each operation is wasteful. That's where `LWWBatcher` comes in.

### What It Does

`LWWBatcher` accumulates operations and consolidates them using the same LWW rules the server uses. When you're ready to send, it produces a single `ChangeInput` object with all operations efficiently merged.

**Key features:**

- **Automatic consolidation**: `@inc` operations merge, `replace` operations follow last-write-wins, delta ops combine
- **Two APIs**: Add raw operations or use the familiar `change(mutator)` function
- **Memory efficient**: Stores one operation per path, not a history of changes
- **Type-safe**: Full TypeScript support with path inference

### Basic Usage

```typescript
import { LWWBatcher } from '@dabble/patches/client';

const batcher = new LWWBatcher<MyDocType>();

// Option 1: Add operations directly
batcher.add([
  { op: '@inc', path: '/pageViews', value: 1 },
  { op: '@inc', path: '/pageViews', value: 1 },
  { op: 'replace', path: '/lastViewed', value: Date.now() },
]);

// Option 2: Use the change() API
batcher.change((patch, doc) => {
  patch.increment(doc.visitCount, 1);
  patch.replace(doc.status, 'active');
  patch.max(doc.highScore, 150);
});

// Get consolidated change
const changeInput = batcher.flush();
// Returns: {
//   id: '...',
//   ops: [
//     { op: '@inc', path: '/pageViews', value: 2, ts: ... },
//     { op: 'replace', path: '/lastViewed', value: ..., ts: ... },
//     { op: '@inc', path: '/visitCount', value: 1, ts: ... },
//     { op: 'replace', path: '/status', value: 'active', ts: ... },
//     { op: '@max', path: '/highScore', value: 150, ts: ... }
//   ],
//   createdAt: ...
// }
```

### Migration Script Example

Here's a real-world migration scenario where you're converting legacy data:

```typescript
import { LWWBatcher } from '@dabble/patches/client';
import { LWWServer } from '@dabble/patches/server';

async function migrateUserStats(users: LegacyUser[], server: LWWServer) {
  for (const user of users) {
    const batcher = new LWWBatcher<UserStatsDoc>();

    // Accumulate all field updates
    batcher.change((patch, doc) => {
      patch.replace(doc.userId, user.id);
      patch.replace(doc.displayName, user.name);
      patch.replace(doc.email, user.email);
      patch.increment(doc.loginCount, user.totalLogins);
      patch.max(doc.lastLoginAt, user.lastActiveTimestamp);

      // Convert legacy flags to bitmask
      if (user.isPremium) patch.bit(doc.flags, 0, true);
      if (user.emailVerified) patch.bit(doc.flags, 1, true);
      if (user.darkMode) patch.bit(doc.flags, 2, true);
    });

    // Send consolidated change to server
    const change = batcher.flush({
      batchId: 'migration-2025-02',
      source: 'legacy-import',
    });

    await server.commitChanges(`user-stats-${user.id}`, [change]);
  }
}
```

Without `LWWBatcher`, you'd either:

1. Create a separate Change for each field (network overhead, storage bloat)
2. Manually track operations and consolidate them yourself (error-prone, duplicates server logic)

### How Consolidation Works

The batcher uses the same `consolidateOps` algorithm the server uses. Operations on the same path consolidate according to their type:

**Delta operations combine:**

```typescript
batcher.add([
  { op: '@inc', path: '/counter', value: 5 },
  { op: '@inc', path: '/counter', value: 3 },
  { op: '@inc', path: '/counter', value: 2 },
]);

const result = batcher.flush();
// Result: { op: '@inc', path: '/counter', value: 10 }
```

**Replace operations follow last-write-wins:**

```typescript
batcher.add([
  { op: 'replace', path: '/status', value: 'pending', ts: 1000 },
  { op: 'replace', path: '/status', value: 'active', ts: 2000 },
]);

const result = batcher.flush();
// Result: { op: 'replace', path: '/status', value: 'active', ts: 2000 }
```

**Delta ops apply to replace ops:**

```typescript
batcher.add([
  { op: 'replace', path: '/score', value: 100 },
  { op: '@inc', path: '/score', value: 5 },
]);

const result = batcher.flush();
// Result: { op: 'replace', path: '/score', value: 105 }
```

### API Reference

```typescript
class LWWBatcher<T extends object = object> {
  // Add operations (raw ops or JSONPatch object)
  add(newOps: JSONPatchOp[] | JSONPatch): void;

  // Use change() API like LWWDoc
  change(mutator: ChangeMutator<T>): void;

  // Get consolidated change and clear batch
  flush(metadata?: Record<string, any>): ChangeInput;

  // Clear without creating a change
  clear(): void;

  // Check if empty
  isEmpty(): boolean;

  // Number of pending operations (by path)
  get size(): number;
}
```

### When to Use It

**Use `LWWBatcher` when:**

- Writing migration scripts that convert legacy data
- Bulk importing records from external sources
- Building batch processing tools
- Pre-computing operations before network availability
- Testing scenarios with many accumulated changes

**Don't use it for:**

- Normal real-time collaboration (use `LWWDoc` instead)
- Single operations (just send them directly)
- When you need the full `Change` object with `rev`/`baseRev` (use `createChange` from `@dabble/patches`)

### Timestamps and IDs

The batcher automatically adds timestamps to operations that don't have them. All operations in a single `add()` call get the same timestamp. Operations from different `add()` calls get different timestamps.

```typescript
batcher.add([
  { op: 'replace', path: '/a', value: 1 }, // Gets ts: 1000
  { op: 'replace', path: '/b', value: 2 }, // Gets ts: 1000
]);

// Later...
batcher.add([
  { op: 'replace', path: '/c', value: 3 }, // Gets ts: 1005
]);
```

The `flush()` method generates a unique ID using the same algorithm as `createChange`, so the resulting `ChangeInput` is ready to send to the server.

## Algorithm Functions

The algorithm functions live in `src/algorithms/lww/`. For the general algorithm architecture, see [Algorithms](algorithms.md).

### consolidateOps

The core algorithm. Lives in `src/algorithms/lww/consolidateOps.ts`.

```typescript
function consolidateOps(
  existingOps: JSONPatchOp[],
  newOps: JSONPatchOp[]
): { opsToSave: JSONPatchOp[]; pathsToDelete: string[]; opsToReturn: JSONPatchOp[] };
```

What it does:

1. **Validates parent hierarchy**: If a parent is a primitive, new child ops are rejected (returns correction op)
2. **Consolidates same-path ops**: Higher timestamp wins; combinable ops are merged
3. **Handles parent overwrites**: Writing to `/user` deletes children like `/user/name`
4. **Returns results**: Ops to save, paths to delete, correction ops to return to client

Example flow:

```typescript
const existingOps = [{ op: 'replace', path: '/user/name', value: 'Alice', ts: 100 }];
const newOps = [
  { op: 'replace', path: '/user/name', value: 'Bob', ts: 150 }, // Higher ts, wins
];

const result = consolidateOps(existingOps, newOps);
// result.opsToSave = [{ op: 'replace', path: '/user/name', value: 'Bob', ts: 150 }]
// result.pathsToDelete = []
// result.opsToReturn = []
```

### Delta Operations

LWW supports special "delta" operations that combine rather than overwrite:

| Op     | Description             | Combine Logic             |
| ------ | ----------------------- | ------------------------- |
| `@inc` | Increment numeric value | Adds values together      |
| `@bit` | Bitmask operations      | Combines AND/OR/XOR masks |
| `@max` | Maximum of values       | Keeps higher value        |
| `@min` | Minimum of values       | Keeps lower value         |

```typescript
// Two concurrent increments combine:
const existing = { op: '@inc', path: '/counter', value: 5, ts: 100 };
const incoming = { op: '@inc', path: '/counter', value: 3, ts: 150 };
// Result: { op: '@inc', path: '/counter', value: 8, ts: 150 }

// @max keeps the highest:
const existing = { op: '@max', path: '/highScore', value: 100, ts: 100 };
const incoming = { op: '@max', path: '/highScore', value: 85, ts: 150 };
// Result: { op: '@max', path: '/highScore', value: 100, ts: 150 }  // 100 is higher
```

These delta operations are powerful for counters, feature flags, and high-score tracking where you want concurrent updates to combine rather than clobber each other.

### convertDeltaOps

Before storing, delta ops are converted to `replace` ops with concrete values:

```typescript
function convertDeltaOps(ops: JSONPatchOp[]): JSONPatchOp[];

// { op: '@inc', path: '/counter', value: 5 } becomes
// { op: 'replace', path: '/counter', value: 5 }  // (starting from 0)
```

This ensures stored ops are always concrete values, not deltas.

### mergeServerWithLocal

Used on the client to combine server changes with pending local ops:

```typescript
function mergeServerWithLocal(
  serverChanges: Change[],
  localOps: JSONPatchOp[] // sendingChange.ops + pendingOps
): Change[];
```

The logic:

- For paths server touched: If local has a delta op, apply it to server value. Otherwise, keep server value.
- For paths server didn't touch: Keep local ops so they still apply to state.

## Backend Store Interface

### LWWStoreBackend

The server-side storage interface. Implement this for your database.

```typescript
interface LWWStoreBackend extends ServerStoreBackend {
  // Get current revision without full state reconstruction
  getCurrentRev(docId: string): Promise<number>;

  // Get latest snapshot (compacted state)
  getSnapshot(docId: string): Promise<{ state: any; rev: number } | null>;

  // Save a new snapshot (overwrites previous)
  saveSnapshot(docId: string, state: any, rev: number): Promise<void>;

  // List ops, optionally filtered
  listOps(docId: string, options?: ListFieldsOptions): Promise<JSONPatchOp[]>;

  // Save ops atomically, increment revision
  saveOps(docId: string, ops: JSONPatchOp[], pathsToDelete?: string[]): Promise<number>;

  // Delete document and all data
  deleteDoc(docId: string): Promise<void>;
}

type ListFieldsOptions = { sinceRev: number } | { paths: string[] };
```

**Key implementation requirements for `saveOps`:**

- Atomically increment document revision
- Set `rev` on all saved ops to the new revision
- Delete child paths when saving parent (e.g., saving `/obj` deletes `/obj/name`)
- Delete paths in `pathsToDelete` atomically

### VersioningStoreBackend

Optional extension for user-visible versioning. This is the same interface used by OT, so a single store backend can handle both:

```typescript
interface VersioningStoreBackend {
  createVersion(docId: string, metadata: VersionMetadata, state: any, changes?: Change[]): Promise<void>;
  listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]>;
  loadVersionState(docId: string, versionId: string): Promise<any | undefined>;
  updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void>;
}
```

Use this when you want named versions users can browse, not just automatic snapshots.

## Using LWW and OT Together

The real power comes from combining strategies in the same app.

### Same App, Different Documents

A writing app might use:

- **OT** for the manuscript content (collaborative text editing)
- **LWW** for the outline structure (drag-and-drop reordering)
- **LWW** for user settings (preferences, theme, view options)

```typescript
import { Patches, InMemoryStore } from '@dabble/patches/client';
import { LWWInMemoryStore } from '@dabble/patches/client';

// OT for documents
const patches = new Patches({
  store: new InMemoryStore(),
  strategy: 'ot',
});

// LWW for settings
const settingsPatches = new Patches({
  store: new LWWInMemoryStore(),
  strategy: 'lww',
});

// Open OT document for collaborative editing
const manuscriptDoc = await patches.openDoc('manuscript-123');

// Open LWW document for user settings
const settingsDoc = await settingsPatches.openDoc('settings-user-456');
```

### When to Split

Split into separate sync strategies when:

- Different parts of your data have fundamentally different conflict semantics
- Settings should never block content sync (or vice versa)
- You want simpler debugging by isolating sync behavior

Keep in one strategy when:

- Data is closely coupled and should sync together
- You want transactional consistency across related fields
- Complexity of multiple sync strategies isn't worth it

## Why LWW Works

### Simplicity Advantage

OT requires transformation functions for every operation type. Add a new operation? Write transformation logic against every other operation type. The combinatorial complexity grows fast.

LWW's conflict resolution fits in one function:

```typescript
function isExistingNewer(existingTs: number | undefined, incomingTs: number | undefined): boolean {
  if (incomingTs === undefined) return false;
  if (existingTs === undefined) return true;
  return existingTs > incomingTs;
}
```

That's it. Higher timestamp wins. Ties go to incoming. The entire algorithm is trivially correct by inspection.

### Performance Benefits

No transformation means:

- Faster server processing (just compare timestamps)
- Smaller storage (current state, not full history)
- Simpler queries (no need to replay changes)
- Easier caching (just cache current ops)

For a 10,000-field document, LWW stores 10,000 ops. OT might store 100,000 changes that all need to be replayed.

### When "Last Write Wins" Is Actually What You Want

Think about a design tool. Two users drag the same rectangle at the same time. What should happen?

With OT, you'd try to "merge" both movements. The rectangle ends up... somewhere. Neither user intended that position.

With LWW, the later movement wins. The rectangle is exactly where one user put it. The other user sees it move and can adjust. This is intuitive and predictable.

Most real-time data works this way. Status fields, settings, positions, selections, assignments, due dates... the last person to change it should win. That's not a compromise; that's the correct behavior.

### The Tradeoff Is Real

LWW loses data when conflicts happen. If Alice and Bob both change the title at the exact same millisecond, one title is gone.

For text editing, this is unacceptable. You can't tell a user "sorry, your paragraph disappeared because someone else edited at the same time."

For everything else, it's usually fine. Settings don't need history. Dashboard positions don't need merging. Task assignments should reflect the last decision.

Pick the right tool for the job. LWW is the right tool more often than you might think.

## Related Documentation

- [LWWServer](LWWServer.md) - Server-side LWW implementation
- [Operational Transformation](operational-transformation.md) - When you need merging instead of overwriting
- [Persistence](persist.md) - Client-side storage options
- [Algorithms](algorithms.md) - Pure functions that power sync
- [PatchesDoc](PatchesDoc.md) - The document interface for making changes
- [JSON Patch](json-patch.md) - The operation format under the hood

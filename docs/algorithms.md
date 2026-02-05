# Unleash the Algorithms! 🧙‍♂️

Alright, let's peek behind the curtain at the brains of the Patches operation. This isn't just a pile of code; it's where the real magic happens. We've split out the core Operational Transformation (OT) and sync logic into its own neat little corner: `src/algorithms/`. Why? Because making things easy to test, reuse, and understand is how we roll.

## The Big Idea: Keep It Clean, Keep It Clear

Think of it like a well-organized kitchen. You've got your chefs (the main classes like `PatchesSync`, `PatchesDoc`, `OTServer`) who decide what needs to be done. Then you've got your specialized tools and recipe cards (that's our algorithms module!).

Here's the breakdown:

- **Chef's Orders (Orchestration)**: `PatchesSync`, `PatchesDoc`, `OTServer` call the shots.
- **Recipe Cards (Algorithm Logic)**: Pure functions in `src/algorithms/` that do the heavy lifting of OT and syncing without messing with anything else.
- **Sous Chefs (Strategies)**: `OTStrategy` and `LWWStrategy` know _when_ to use which recipe and handle algorithm-specific coordination.
- **Pantry (Storage)**: Your chosen store (like `IndexedDBStore`) just holds the ingredients - no cooking allowed!
- **Waiter Service (Networking)**: The WebSocket and protocol layers just shuttle messages back and forth.

**Important distinction**: Stores are intentionally "dumb" - they save and load data, period. The _strategies_ are the ones that invoke algorithm functions. This keeps stores simple and testable, while strategies handle the smart coordination work.

This setup means:

1.  **Testing is a Breeze**: Pure functions are a dream to unit test. No fuss, no muss.
2.  **Reusability Rocks**: Got your own way of doing sync? Grab these algorithms and plug 'em in.
3.  **Clarity for Days**: The main classes stay lean and mean, focusing on coordinating the work.
4.  **Maintenance Made Easy**: Tweaking an algorithm doesn't mean you have to relearn how the whole kitchen runs.

## The Lay of the Land

Here's how we've laid out the `src/algorithms/` directory:

```
src/algorithms/
├── client/                     # Client-side smarts
│   ├── applyCommittedChanges.ts  # Logic for when server changes land
│   ├── createStateFromSnapshot.ts # Building current state from history
│   └── makeChange.ts             # Crafting new local changes
├── lww/                        # LWW-specific algorithms
│   ├── applyLWWChange.ts         # Apply changes with timestamp comparison
│   └── makeLWWChange.ts          # Create LWW changes with timestamps
├── server/                     # Server-side algorithms
│   ├── commitChanges.ts          # Complete change commit workflow
│   ├── createVersion.ts          # Version creation with persistence
│   ├── getSnapshotAtRevision.ts  # Server snapshot retrieval
│   ├── getStateAtRevision.ts     # Server state retrieval
│   ├── handleOfflineSessionsAndBatches.ts # Offline sync handling
│   └── transformIncomingChanges.ts # Core OT transformation logic
├── shared/                     # Bits everyone can use
│   ├── applyChanges.ts         # Applying a list of changes to a state
│   ├── changeBatching.ts       # Bundling and splitting changes for network
│   └── rebaseChanges.ts        # The core OT rebasing dance
└── index.ts                    # The friendly neighborhood exporter
```

## Client-Side Algorithms: The Nitty-Gritty

### `applyCommittedChanges.ts`

- **`applyCommittedChanges(snapshot, committedChanges)`**: This is your go-to when the server sends down a fresh batch of confirmed changes. It takes the current document snapshot (base state + pending changes) and the server's changes, then intelligently merges them. It'll rebase your pending changes so they play nice with what the server said. Super important for keeping everyone on the same page.

### `createStateFromSnapshot.ts`

- **`createStateFromSnapshot(snapshot)`**: Takes a `PatchesSnapshot` (which includes a base state and a list of pending changes) and computes the live, in-memory state of the document by applying those pending changes to the base state.

### `makeChange.ts`

- **`makeChange(snapshot, mutator, changeMetadata?, maxPayloadBytes?)`**: This is what `PatchesDoc.change()` uses under the hood. You give it the current snapshot, a mutator function (how you want to change the doc), and it figures out the JSON Patch operations. It then creates the actual `Change` object(s). If the resulting change is too big (based on `maxPayloadBytes`), it'll use `breakChanges` to split it up automatically.

## Shared Algorithms: The Common Ground

### `applyChanges.ts`

- **`applyChanges(state, changes)`**: Simple but vital. Takes a state object and an array of `Change` objects, and applies each change's operations to the state, one by one. This is how you get from one version of your data to the next.

### `changeBatching.ts`

- **`breakChanges(changes, maxBytes)`**: Sometimes changes are just too big for one network message. This function takes an array of changes and splits any oversized ones into smaller, more manageable pieces. It first tries to split by individual JSON Patch operations. If an op itself (like a massive text insert) is still too big, it'll even attempt to break that specific operation down further.

- **`breakChangesIntoBatches(changes, maxPayloadBytes?)`**: Got a bunch of changes to send? This function wraps them up into neat batches, respecting any `maxPayloadBytes` you set. Keeps your network calls efficient.

- **`getJSONByteSize(data)`**: A handy utility to get a rough estimate of how big a piece of data will be when turned into a JSON string. Crucial for the batching functions above.

### `rebaseChanges.ts`

- **`rebaseChanges(serverChanges, localChanges)`**: The heart of client-side Operational Transformation. When the server has new changes that your local (pending) changes didn't know about, this function rewrites your local changes so they can be applied _after_ the server's changes, as if you made them on top of the server's latest version. It's what prevents your work from overwriting someone else's, and vice-versa.

## LWW Algorithms: The Simpler Path

For Last-Write-Wins sync, we have a separate set of algorithms in `src/algorithms/lww/`:

### `makeLWWChange.ts`

- **`makeLWWChange(snapshot, mutator, timestamp?)`**: Creates a change object with timestamps on each operation. If no timestamp is provided, it uses the current time. The timestamp determines which write wins when there are conflicts.

### `applyLWWChange.ts`

- **`applyLWWChange(state, change)`**: Applies a change using LWW semantics. For each operation, it compares timestamps - if the incoming timestamp is >= the existing one, the incoming value wins. Simple and predictable!

LWW is great for data where you don't need to merge concurrent edits - just let the latest write win. User preferences, settings, status data - that kind of thing.

## Server-Side Algorithms: The Authority

### `commitChanges.ts`

- **`commitChanges(store, docId, changes, sessionTimeoutMillis, options?)`**: The complete workflow for committing client changes to the server. This algorithm handles the entire change commit process: validation, idempotency checks, offline session management, version creation, operational transformation against concurrent changes, and persistence. Returns both committed changes found on the server and the newly transformed changes. Pass `options.forceCommit: true` to preserve changes even if they result in no state modification (useful for migrations). This is the brain behind `OTServer.commitChanges()`.

### `createVersion.ts`

- **`createVersion(store, docId, state, changes, metadata?)`**: Creates and persists a new version snapshot. Takes the document state, changes since the last version, and optional metadata, then handles all the version creation logic including ID generation, metadata setup, and storage persistence. This is what `OTServer.captureCurrentVersion()` uses internally.

### `transformIncomingChanges.ts`

- **`transformIncomingChanges(changes, stateAtBaseRev, committedChanges, currentRev, forceCommit?)`**: The heart of server-side Operational Transformation. Takes incoming client changes and transforms them against any changes that were committed since the client's base revision. This ensures proper conflict resolution and sequential revision assignment. When `forceCommit` is true, changes are preserved even if they result in no state modification or have empty ops (useful for migrations). Core to the `commitChanges` workflow.

### `getSnapshotAtRevision.ts` & `getStateAtRevision.ts`

These handle the server's version of state reconstruction - loading the appropriate snapshot and applying changes to get the state at any given revision.

### `handleOfflineSessionsAndBatches.ts`

Manages the complex logic for processing offline sessions and multi-batch uploads, including version creation for offline work.

## How This Makes Everything Better

Remember that messy kitchen? Now it's sparkling!

### The Strategy Layer

Between the orchestration classes and the algorithm functions, we have **strategies**:

- **`OTStrategy`**: Knows when to call OT algorithms like `rebaseChanges` and `applyCommittedChanges`
- **`LWWStrategy`**: Knows when to call LWW algorithms and handles field consolidation

Strategies work with their matching stores (`OTClientStore` or `LWWClientStore`) and invoke the right algorithms at the right time. This keeps the stores "dumb" (just data in, data out) while strategies handle the smarts.

**`PatchesSync` (Client's Network Captain):**

- **Before**: Had to know all the fiddly details of rebasing and applying changes.
- **After**: Just calls `applyCommittedChanges` when server updates arrive. Clean. Simple. Gets an updated snapshot and tells the `PatchesDoc` and `PatchesStore` what's new.

```typescript
// PatchesSync._applyServerChangesToDoc simplified:
async _applyServerChangesToDoc(docId, serverChanges, sentPendingRange?) {
  const currentSnapshot = await this.store.getDoc(docId);
  // 👇 Look Ma, pure function!
  const { state, rev, changes: pendingChanges } = applyCommittedChanges(currentSnapshot, serverChanges);

  await this.store.saveCommittedChanges(docId, serverChanges, sentPendingRange);
  await this.store.replacePendingChanges(docId, pendingChanges);

  const doc = this.patches.getOpenDoc(docId);
  if (doc) {
    // Smartly updates the open doc
    if (doc.committedRev === serverChanges[0].rev - 1) {
      doc.applyCommittedChanges(serverChanges, pendingChanges);
    } else {
      doc.import({ state, rev, changes: pendingChanges });
    }
  }
}
```

**`PatchesDoc` (Your Local Document Guardian):**

- **Before**: Also had to juggle its own version of rebasing and applying server confirmations.
- **After**: Mostly just holds onto the latest `PatchesSnapshot` and uses `makeChange` to create new edits. When `PatchesSync` tells it about server updates, it either imports the new snapshot or applies the committed changes directly via its new `applyCommittedChanges` method (which is just a state updater now).

This new structure is a big win for clarity and robustness. You can dive into the `algorithms` directory to see exactly how the OT magic works, or you can look at `PatchesSync` and `PatchesDoc` for the higher-level flow. Your choice! And if you ever want to build your own sync layer, the algorithms are right there for you to reuse.

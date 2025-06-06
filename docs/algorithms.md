# Unleash the Algorithms! 🧙‍♂️

Alright, let's peek behind the curtain at the brains of the Patches operation. This isn't just a pile of code; it's where the real magic happens. We've split out the core Operational Transformation (OT) and sync logic into its own neat little corner: `src/algorithms/`. Why? Because making things easy to test, reuse, and understand is how we roll.

## The Big Idea: Keep It Clean, Keep It Clear

Think of it like a well-organized kitchen. You've got your chefs (the main classes like `PatchesSync`, `PatchesDoc`, `PatchesServer`) who decide what needs to be done. Then you've got your specialized tools and recipe cards (that's our algorithms module!).

Here's the breakdown:

- **Chef's Orders (Orchestration)**: `PatchesSync`, `PatchesDoc`, `PatchesServer` call the shots.
- **Recipe Cards (Algorithm Logic)**: Pure functions in `src/algorithms/` that do the heavy lifting of OT and syncing without messing with anything else.
- **Pantry (Storage)**: Your chosen store (like `IndexedDBStore`) just holds the ingredients.
- **Waiter Service (Networking)**: The WebSocket and protocol layers just shuttle messages back and forth.

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
│   ├── batching.ts             # Bundling up changes for sending
│   ├── breakChange.ts          # Chopping up big changes
│   ├── createStateFromSnapshot.ts # Building current state from history
│   ├── getJSONByteSize.ts      # Estimating change size
│   └── makeChange.ts             # Crafting new local changes
├── server/                     # Server-side algorithms
│   ├── createVersion.ts          # Version creation with persistence
│   ├── getSnapshotAtRevision.ts  # Server snapshot retrieval
│   ├── getStateAtRevision.ts     # Server state retrieval
│   ├── handleOfflineSessionsAndBatches.ts # Offline sync handling
│   └── transformIncomingChanges.ts # Core OT transformation logic
├── shared/                     # Bits everyone can use
│   ├── applyChanges.ts         # Applying a list of changes to a state
│   └── rebaseChanges.ts        # The core OT rebasing dance
└── index.ts                    # The friendly neighborhood exporter
```

## Client-Side Algorithms: The Nitty-Gritty

### `applyCommittedChanges.ts`

- **`applyCommittedChanges(snapshot, committedChanges)`**: This is your go-to when the server sends down a fresh batch of confirmed changes. It takes the current document snapshot (base state + pending changes) and the server's changes, then intelligently merges them. It'll rebase your pending changes so they play nice with what the server said. Super important for keeping everyone on the same page.

### `batching.ts`

- **`breakIntoBatches(changes, maxPayloadBytes?)`**: Got a bunch of changes to send? This function wraps them up into neat batches, respecting any `maxPayloadBytes` you set. Keeps your network calls efficient.

### `breakChange.ts`

- **`breakChange(change, maxBytes)`**: Sometimes a single change is just too big for one network message. This function is the heavy lifter that splits a single, oversized `Change` object into smaller, more manageable `Change` objects. It first tries to split by individual JSON Patch operations. If an op itself (like a massive text insert) is still too big, `breakChange` will even attempt to break that specific operation down further.

### `createStateFromSnapshot.ts`

- **`createStateFromSnapshot(snapshot)`**: Takes a `PatchesSnapshot` (which includes a base state and a list of pending changes) and computes the live, in-memory state of the document by applying those pending changes to the base state.

### `getJSONByteSize.ts`

- **`getJSONByteSize(data)`**: A handy utility to get a rough estimate of how big a piece of data will be when turned into a JSON string. Crucial for `breakChange` and `breakIntoBatches`.

### `makeChange.ts`

- **`makeChange(snapshot, mutator, changeMetadata?, maxPayloadBytes?)`**: This is what `PatchesDoc.change()` uses under the hood. You give it the current snapshot, a mutator function (how you want to change the doc), and it figures out the JSON Patch operations. It then creates the actual `Change` object(s). If the resulting change is too big (based on `maxPayloadBytes`), it'll use `breakChange` to split it up automatically.

## Shared Algorithms: The Common Ground

### `applyChanges.ts`

- **`applyChanges(state, changes)`**: Simple but vital. Takes a state object and an array of `Change` objects, and applies each change's operations to the state, one by one. This is how you get from one version of your data to the next.

### `rebaseChanges.ts`

- **`rebaseChanges(serverChanges, localChanges)`**: The heart of client-side Operational Transformation. When the server has new changes that your local (pending) changes didn't know about, this function rewrites your local changes so they can be applied _after_ the server's changes, as if you made them on top of the server's latest version. It's what prevents your work from overwriting someone else's, and vice-versa.

## Server-Side Algorithms: The Authority

### `createVersion.ts`

- **`createVersion(store, docId, state, changes, metadata?)`**: Creates and persists a new version snapshot. Takes the document state, changes since the last version, and optional metadata, then handles all the version creation logic including ID generation, metadata setup, and storage persistence. This is what `PatchesServer.captureCurrentVersion()` uses internally.

### `transformIncomingChanges.ts`

- **`transformIncomingChanges(changes, stateAtBaseRev, committedChanges, currentRev)`**: The heart of server-side Operational Transformation. Takes incoming client changes and transforms them against any changes that were committed since the client's base revision. This ensures proper conflict resolution and sequential revision assignment. Core to the `PatchesServer.commitChanges()` workflow.

### `getSnapshotAtRevision.ts` & `getStateAtRevision.ts`

These handle the server's version of state reconstruction - loading the appropriate snapshot and applying changes to get the state at any given revision.

### `handleOfflineSessionsAndBatches.ts`

Manages the complex logic for processing offline sessions and multi-batch uploads, including version creation for offline work.

## How This Makes `PatchesSync` and `PatchesDoc` Better

Remember that messy kitchen? Now it's sparkling!

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

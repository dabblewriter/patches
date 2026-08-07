# Branching and Merging in Patches

Branches let you create parallel copies of a document that can diverge and later merge back. Think of it as "git branching" for collaborative JSON documents.

The use case is simple: experimentation without fear. Want to try a radical redesign? Create a branch. Need multiple teams working on different features? Give each team their own branch. Building an approval workflow? Branches make review-before-publish trivial.

**Table of Contents**

- [Branching and Merging in Patches](#branching-and-merging-in-patches)
  - [How Branching Works](#how-branching-works)
  - [OT vs LWW Branching](#ot-vs-lww-branching)
  - [Creating a Branch](#creating-a-branch)
  - [Branch Metadata](#branch-metadata)
  - [Merging Back](#merging-back)
    - [OT Merge Approach](#ot-merge-approach)
    - [LWW Merge Approach](#lww-merge-approach)
  - [Design Decisions](#design-decisions)
  - [Practical Example](#practical-example)

## How Branching Works

When you create a branch, the system:

1. Captures the source document's state at a specific revision
2. Creates a new document with that state as its starting point
3. Records metadata linking the branch to its source

The branch document is a real document. Edit it just like any other. The branching system only matters when you want to merge those changes back.

**One rule matters:** You cannot branch from a branch. Single-level branching only. This constraint prevents the exponential complexity of nested branch hierarchies. Trust the constraint.

## OT vs LWW Branching

Patches supports two sync algorithms, and each has its own branch manager:

| Algorithm | Branch Manager                             | Merge Approach                             |
| --------- | ------------------------------------------ | ------------------------------------------ |
| OT        | [OTBranchManager](PatchesBranchManager.md) | Transforms operations, preserves history   |
| LWW       | LWWBranchManager                           | Timestamps resolve conflicts automatically |

**OT branching** (via `OTBranchManager`) works like git. The branch captures the source at a specific revision. When merging, the system checks if the source has new changes since the branch was created:

- **Fast-forward merge:** No concurrent changes on source. Branch changes become part of the main timeline as-is.
- **Divergent merge:** Source has new changes. Branch changes are lifted through the merge frame — the source's concurrent changes re-expressed in the branch's frame — and committed at the source tip in bounded windows, each stamped `batchId: branchId`.

**LWW branching** (via `LWWBranchManager`) is simpler. Each field carries a timestamp. When merging, timestamps resolve conflicts automatically. No transformation needed. Later timestamp wins.

For details on the underlying sync algorithms, see [Operational Transformation](operational-transformation.md) and [Last-Write-Wins](last-write-wins.md).

## Creating a Branch

Both branch managers use the same interface:

```typescript
import { OTBranchManager, OTServer } from '@dabble/patches/server';
// or for LWW:
// import { LWWBranchManager, LWWServer } from '@dabble/patches/server';

const branchManager = new OTBranchManager(store, server);

// Create a branch at revision 42
const branchDocId = await branchManager.createBranch(
  'source-doc-id',
  42, // revision to branch from
  { name: 'Experimental Feature' } // optional metadata
);

// The branch is now a separate document you can edit
const doc = await patches.openDoc(branchDocId);
doc.change(state => {
  state.title = 'New experimental title';
});
```

What happens under the hood:

1. System validates you're not branching from a branch
2. Retrieves source document state at the specified revision
3. Creates a new document with that state
4. Stores branch metadata linking back to the source

The `branchDocId` is a real document ID. Open it, edit it, sync it, close it. It behaves like any other document until merge time.

## Branch Metadata

The `Branch` record tracks the relationship between branch and source:

```typescript
interface Branch {
  id: string; // The branch document ID
  docId: string; // Source document ID
  branchedAtRev: number; // Revision on source where branch was created
  createdAt: number; // Unix timestamp (milliseconds)
  name?: string; // Human-readable name
  lastMergedRev?: number; // Branch rev through which changes were last merged
  mergeBaseRev?: number; // Pinned merge base (only set when branchedAtRev was ahead of the source tip)
  deleted?: true; // Tombstone marker for incremental sync
}
```

List branches for a document:

```typescript
const branches = await branchManager.listBranches('source-doc-id');
```

Update branch metadata:

```typescript
await branchManager.updateBranch(branchDocId, {
  name: 'Renamed Feature Branch',
});
```

Delete a branch:

```typescript
await branchManager.deleteBranch(branchDocId);
```

## Merging Back

Merging applies branch changes to the source document. Branches support **multiple merges** — the branch stays open after each merge, and `lastMergedRev` tracks which branch revision was last merged. Subsequent merges only pick up new changes.

```typescript
// First merge
const changes1 = await branchManager.mergeBranch(branchDocId);
// Branch stays around — make more edits...

// Second merge — only new changes since first merge
const changes2 = await branchManager.mergeBranch(branchDocId);

// Delete when done
await branchManager.deleteBranch(branchDocId);
```

### OT Merge Approach

The [OTBranchManager](PatchesBranchManager.md) preserves original branch changes and uses `batchId` for correct transformation:

```
Source: [rev 40] [rev 41] [rev 42] [rev 43 (Bob)] [rev 44 (Carol)] ─────[rev 45] [rev 46]
                              │                                             ↑        ↑
                              └── Branch created ── [change A] [change B] ──┘────────┘
                                                                          (each transformed independently)
```

When Alice merges her branch:

1. Unmerged branch changes (since `lastMergedRev`) merge in bounded **windows** (at most `maxChangesPerMerge` changes and `maxBytesPerMergeWindow` serialized bytes each), so the merge's cost scales with the window, not the branch's age
2. The **merge frame** — the source's concurrent changes re-expressed in the branch's frame — lifts each window's changes to the source tip before commit; the frame advances through each window's raw ops for the next one (this is the advance half of the OT diamond, carried explicitly instead of re-derived from a full queue)
3. Each window commits with `batchId: branchId` and its original change IDs preserved — the store's write-time id guard makes retries and concurrent merges idempotent (safe to retry if the network drops after commit but before acknowledgment)
4. Branch versions whose span a window covers get copied to source with `origin: 'branch'` in version metadata
5. `lastMergedRev` and the frame are updated on the branch record together after each window

Why `batchId`? All changes in a branch are created in the context of each other. Change 500 knows about change 5, even across multiple merges. Using the branch ID as the batch ID ensures they're never transformed against each other — while the frame ensures the source's changes still meet each window at the right offsets.

Why preserve original changes instead of flattening? Idempotency. If changes are flattened into a new change with a new ID, a retry after a failed acknowledgment would create a duplicate with a different ID — the server can't detect it as a duplicate, and the document gets corrupted. Preserving original IDs means the server's ID-based deduplication catches retries automatically. This also enables offline merge: two clients merging the same branch produce identical change IDs, so deduplication prevents corruption.

### Merge Retry and Concurrency Safety

Each window's commit and the watermark update are separate writes, so a crash or timeout can land between them, and nothing serializes two merges of the same branch. Instead of a transaction, merges rely on four properties:

1. **Write-time id guard.** Merged changes keep their original branch change ids, and the store's mandatory `[docId, change.id]` uniqueness enforcement (`OTStoreBackend.saveChanges`) resolves any re-send of already-committed changes as a resend instead of applying it twice. Windowed commits advance `baseRev` past earlier windows, so the read-side dedup cannot cover this — the store guard is load-bearing.
2. **Frame catch-up.** A merge that finds its own committed rows above the frame's source position — a crash-resume's prefix, or a concurrent merge's windows — advances the frame through those rows' raw branch ops (from the branch log) before proceeding, exactly as if it had committed them itself. The merge base stays pinned (`mergeBaseRev` for clamped branches) so every attempt anchors the same frame.
3. **Watermark from the merged batch.** `lastMergedRev` is set to the highest branch rev in the window actually read and committed — never the branch tip — so an edit landing on the branch mid-merge stays uncovered and is picked up by the next merge.
4. **Forward-only watermark.** When the store implements the optional `updateBranchIf` compare-and-set capability, the watermark update (frame riding along) is conditioned on the value observed at window start; a losing CAS drops the merge's in-memory carry, and the next window adopts the winner's persisted state. Stores without the capability keep non-atomic max-wins semantics.

Copied versions get the same treatment: the source copy keeps the branch version's id (version ids are namespaced per doc), so a retried or concurrent merge detects an existing copy and skips it instead of duplicating it.

A merge that fails after anything committed — a later window's fault, a crash between a window's commit and its watermark write (even the first window's), a stalled cursor, or the per-call window cap — throws `MergePartialProgressError` carrying the committed changes and the branch rev content is durably merged through. The committed prefix is permanent and a retry resumes and completes it; consumers must not present this error as "nothing was changed". Deterministic refusals (e.g. `MergeContentDuplicationError`) decide before the first window commits and throw their original error — those genuinely leave no trace. A repeat merge with nothing new on the branch returns `[]` even when the source has moved on its own.

`lastMergedRev`, `mergeBaseRev` and `mergeFrame` are server-managed: values arriving in client-supplied metadata (whole branch records sync through `PatchesSync`) are silently stripped on both create and update.

### LWW Merge Approach

The `LWWBranchManager` approach is simpler:

1. Get field changes made on the branch since last merge (or since creation)
2. Commit them to the source document
3. Timestamps automatically resolve conflicts
4. Update `lastMergedRev` on the branch

No transformation. No flattening. Just timestamp comparison. If the branch wrote to `/settings/theme` with timestamp 1738761234567 and source has an older timestamp, branch wins. If source has a newer timestamp, source wins.

This works because LWW conflicts don't need intelligent merging. The last writer wins, and that's the expected behavior. LWW merge is naturally idempotent — merging the same ops multiple times produces the same result.

## Design Decisions

**Why branch revisions start from the source revision?**

The initial branch version uses the source's revision number. When you branch at rev 42, the branch's first version is at rev 42. This means no translation needed when merging. The revision numbers just work.

**Why not flatten changes for merge?**

Flattening creates a new change with a new ID. That destroys idempotency — if a merge is retried (network failure after commit, before acknowledgment), the second attempt creates a different change ID for the same content. The server can't deduplicate it, and the document gets double-applied ops.

Preserving original branch changes with their original IDs means the server's existing ID-based deduplication handles retries correctly. The tradeoff is more transformation work (N changes × committed ops instead of 1 × committed ops), but correctness beats performance here.

**Why no nested branches?**

Branch hierarchies create exponential complexity. What happens when branch-of-branch diverges from its parent, which diverges from grandparent? The merge semantics become confusing fast.

Single-level branching keeps the mental model simple: every branch has one source, and merging has predictable behavior.

**Why treat offline sessions like auto-branches?**

When a client goes offline, their changes are essentially a branch. They diverge from the server state and need to reconcile later.

Patches handles this the same way:

- No concurrent server changes while offline? Changes merge like a fast-forward.
- Concurrent server changes? Offline changes get marked `origin: 'offline-branch'` and each change is transformed individually against the concurrent changes.

This consistency means the same algorithms handle both explicit branching and implicit offline divergence.

## Practical Example

Here's a complete feature branching workflow:

```typescript
import { Patches, InMemoryStore } from '@dabble/patches/client';
import { OTServer, OTBranchManager } from '@dabble/patches/server';

// Setup
const store = new MyDatabaseStore();
const server = new OTServer(store);
const branchManager = new OTBranchManager(store, server);

// 1. Create a feature branch
async function createFeatureBranch(sourceDocId: string, featureName: string) {
  const { rev } = await server.getDoc(sourceDocId);

  const branchDocId = await branchManager.createBranch(sourceDocId, rev, {
    name: `Feature: ${featureName}`,
  });

  return branchDocId;
}

// 2. Work on the branch (normal document editing)
const branchDocId = await createFeatureBranch('main-doc', 'Dark Mode');
const doc = await patches.openDoc(branchDocId);

doc.change(state => {
  state.theme = 'dark';
  state.colors.background = '#1a1a1a';
  state.colors.text = '#ffffff';
});

// 3. List branches
const branches = await branchManager.listBranches('main-doc');
console.log(`${branches.length} branches`);

// 4. Merge when ready (branch stays around for further edits)
const changes = await branchManager.mergeBranch(branchDocId);
console.log(`Merged ${changes.length} changes`);

// 5. Merge again after more edits (only new changes since last merge)
const moreChanges = await branchManager.mergeBranch(branchDocId);

// 6. Delete when done
await branchManager.deleteBranch(branchDocId);
```

The branch manager handles all the complexity. You just create branches, work on them, and merge when ready.

---

For more on the underlying sync mechanisms, see:

- [Operational Transformation](operational-transformation.md) - How OT handles concurrent edits
- [Last-Write-Wins](last-write-wins.md) - How LWW resolves conflicts
- [PatchesBranchManager](PatchesBranchManager.md) - Detailed OTBranchManager API reference
- [OTServer](OTServer.md) - Server-side OT processing
- [LWWServer](LWWServer.md) - Server-side LWW processing

# Branching and Merging in Patches

Branches let you create parallel copies of a document that can diverge and later merge back. Think of it as "git branching" for collaborative JSON documents.

The use case is simple: experimentation without fear. Want to try a radical redesign? Create a branch. Need multiple teams working on different features? Give each team their own branch. Building an approval workflow? Branches make review-before-publish trivial.

**Table of Contents**

- [How Branching Works](#how-branching-works)
- [OT vs LWW Branching](#ot-vs-lww-branching)
- [Creating a Branch](#creating-a-branch)
- [Branch Metadata](#branch-metadata)
- [Merging Back](#merging-back)
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

Patches supports two sync strategies, and each has its own branch manager:

| Strategy | Branch Manager                             | Merge Approach                             |
| -------- | ------------------------------------------ | ------------------------------------------ |
| OT       | [OTBranchManager](PatchesBranchManager.md) | Transforms operations, preserves history   |
| LWW      | LWWBranchManager                           | Timestamps resolve conflicts automatically |

**OT branching** (via `OTBranchManager`) works like git. The branch captures the source at a specific revision. When merging, the system checks if the source has new changes since the branch was created:

- **Fast-forward merge:** No concurrent changes on source. Branch changes become part of the main timeline as-is.
- **Divergent merge:** Source has new changes. Branch changes get flattened and transformed against source changes.

**LWW branching** (via `LWWBranchManager`) is simpler. Each field carries a timestamp. When merging, timestamps resolve conflicts automatically. No transformation needed. Later timestamp wins.

For details on the underlying sync strategies, see [Operational Transformation](operational-transformation.md) and [Last-Write-Wins](last-write-wins.md).

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
  status: BranchStatus; // 'open' | 'merged' | 'closed'
}

type BranchStatus = 'open' | 'merged' | 'closed';
```

List branches for a document:

```typescript
const branches = await branchManager.listBranches('source-doc-id');
// Returns all branches, including merged and closed ones
```

Update branch metadata:

```typescript
await branchManager.updateBranch(branchDocId, {
  name: 'Renamed Feature Branch',
});
```

Close a branch without merging:

```typescript
await branchManager.closeBranch(branchDocId, 'closed');
// Status can be 'merged' or 'closed'
```

## Merging Back

Merging applies branch changes to the source document:

```typescript
const committedChanges = await branchManager.mergeBranch(branchDocId);
console.log(`Merged ${committedChanges.length} changes back to source`);
```

### OT Merge Strategy

The [OTBranchManager](PatchesBranchManager.md) handles two scenarios:

**Fast-forward merge** (no concurrent changes on source):

```
Source: [rev 40] [rev 41] [rev 42] ─────────────────────────────────────[rev 43] [rev 44] [rev 45]
                              │                                             ↑
                              └── Branch created ── [change A] [change B] ──┘
                                                                          merge
```

The branch changes (A, B) are committed individually to the source. Their version history shows `origin: 'main'` because they're now part of the main timeline. Clean and simple.

**Divergent merge** (source has new changes since branching):

```
Source: [rev 40] [rev 41] [rev 42] [rev 43 (Bob)] [rev 44 (Carol)] ───────[rev 45]
                              │                                               ↑
                              └── Branch created ── [change A] [change B] ────┘
                                                                            merge (flattened + transformed)
```

When Alice merges her branch:

1. Branch changes get copied to source with `origin: 'branch'` in version metadata
2. All branch changes get flattened into a single change
3. That flattened change gets transformed against concurrent source changes
4. Result is committed to source

Why flatten? Transforming 1,000 individual branch changes against 500 source changes would be slow. Flattening gives the same end result with better performance. The original version history is preserved with `origin: 'branch'` for traceability.

### LWW Merge Strategy

The `LWWBranchManager` approach is simpler:

1. Get all field changes made on the branch
2. Commit them to the source document
3. Timestamps automatically resolve conflicts

No transformation. No flattening. Just timestamp comparison. If the branch wrote to `/settings/theme` with timestamp 1738761234567 and source has an older timestamp, branch wins. If source has a newer timestamp, source wins.

This works because LWW conflicts don't need intelligent merging. The last writer wins, and that's the expected behavior.

## Design Decisions

**Why branch revisions start from the source revision?**

The initial branch version uses the source's revision number. When you branch at rev 42, the branch's first version is at rev 42. This means no translation needed when merging. The revision numbers just work.

**Why flatten changes for divergent merges?**

Performance. A branch with 10,000 tiny changes merged against 5,000 source changes would require transforming each branch change against each source change. Flattening collapses the branch into one change, making merge fast regardless of branch size.

The tradeoff: you lose the granular branch history in the transformation. But the original versions are preserved with `origin: 'branch'` metadata for auditing.

**Why no nested branches?**

Branch hierarchies create exponential complexity. What happens when branch-of-branch diverges from its parent, which diverges from grandparent? The merge semantics become confusing fast.

Single-level branching keeps the mental model simple: every branch has one source, and merging has predictable behavior.

**Why treat offline sessions like auto-branches?**

When a client goes offline, their changes are essentially a branch. They diverge from the server state and need to reconcile later.

Patches handles this the same way:

- No concurrent server changes while offline? Changes merge like a fast-forward.
- Concurrent server changes? Offline changes get marked `origin: 'offline-branch'` and flattened for transformation.

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

// 3. Check branch status
const branches = await branchManager.listBranches('main-doc');
const activeBranches = branches.filter(b => b.status === 'open');
console.log(`${activeBranches.length} active branches`);

// 4. Merge when ready
const changes = await branchManager.mergeBranch(branchDocId);
console.log(`Merged ${changes.length} changes`);
// Branch status is now 'merged'

// 5. Or close without merging
// await branchManager.closeBranch(branchDocId, 'closed');
```

The branch manager handles all the complexity. You just create branches, work on them, and merge when ready.

---

For more on the underlying sync mechanisms, see:

- [Operational Transformation](operational-transformation.md) - How OT handles concurrent edits
- [Last-Write-Wins](last-write-wins.md) - How LWW resolves conflicts
- [PatchesBranchManager](PatchesBranchManager.md) - Detailed OTBranchManager API reference
- [OTServer](OTServer.md) - Server-side OT processing
- [LWWServer](LWWServer.md) - Server-side LWW processing

# Branch Managers

Branch managers handle document branching and merging on the server side. Think of them as git for your collaborative documents: create isolated copies, work independently, merge back when ready.

Patches provides two implementations:

- **`OTBranchManager`**: For documents using [Operational Transformation](operational-transformation.md)
- **`LWWBranchManager`**: For documents using [Last-Write-Wins](last-write-wins.md) semantics

Both implement the same `BranchManager` interface, so your application code works the same regardless of which sync algorithm you use.

> **Note**: `PatchesBranchManager` is a deprecated alias for `OTBranchManager`. Update your imports.

**Table of Contents**

- [Why Use Branches](#why-use-branches)
- [Getting Started](#getting-started)
- [Core Operations](#core-operations)
- [OT vs LWW Branching](#ot-vs-lww-branching)
- [Real-World Example](#real-world-example)
- [Related Documentation](#related-documentation)

## Why Use Branches

Branches solve real problems:

- **Experiment without risk**: Make sweeping changes without touching the main document
- **Parallel workstreams**: Different teams work on different features simultaneously
- **Approval workflows**: Create a branch, get review, merge when approved
- **Safe onboarding**: Let new users practice in a sandbox

If you need a document copy that can diverge and potentially merge back, branches are the tool.

## Getting Started

Both branch managers require a store (for persistence) and a server (for merge operations). Your store must implement `BranchingStoreBackend` in addition to the algorithm-specific backend.

### OT Setup

```typescript
import { OTServer, OTBranchManager } from '@dabble/patches/server';
import { MyOTStore } from './my-store'; // Implements OTStoreBackend & BranchingStoreBackend

const store = new MyOTStore(/* connection details */);
const server = new OTServer(store);
const branchManager = new OTBranchManager(store, server);
```

### LWW Setup

```typescript
import { LWWServer, LWWBranchManager } from '@dabble/patches/server';
import { MyLWWStore } from './my-store'; // Implements LWWStoreBackend & BranchingStoreBackend

const store = new MyLWWStore(/* connection details */);
const server = new LWWServer(store);
const branchManager = new LWWBranchManager(store, server);
```

## Core Operations

Both `OTBranchManager` and `LWWBranchManager` implement the `BranchManager` interface with identical method signatures.

### Creating a Branch

```typescript
// createBranch(docId: string, rev: number, metadata?: EditableBranchMetadata): Promise<string>

const branchDocId = await branchManager.createBranch(
  'main-proposal', // Source document ID
  42, // Revision to branch from
  {
    name: 'Experimental Draft',
    createdBy: 'alice@example.com',
    purpose: 'Testing new layout',
  }
);

console.log(`Branch document ID: ${branchDocId}`);
```

What happens:

1. A new document is created with the source document's state at that revision
2. Branch metadata is stored linking the new document to its source
3. The branch ID is returned - this is a real document ID you can use with [PatchesDoc](PatchesDoc.md)

**Important**: You cannot branch from a branch. One level only. Trust us, branch hierarchies get messy fast.

### Listing Branches

```typescript
// listBranches(docId: string): Promise<Branch[]>

const branches = await branchManager.listBranches('main-proposal');

console.log(`Found ${branches.length} branches`);

for (const branch of branches) {
  console.log(`${branch.name} (${branch.status}) - created ${new Date(branch.createdAt)}`);
}
```

Returns all branches for a document. Filter in your application code:

```typescript
const openBranches = branches.filter(b => b.status === 'open');
const myBranches = branches.filter(b => b.createdBy === currentUser.id);
```

### The Branch Object

Each branch record contains:

```typescript
interface Branch {
  id: string; // The branch document ID
  docId: string; // The source document ID
  branchedAtRev: number; // Revision where branching occurred
  createdAt: number; // Unix timestamp (ms)
  status: BranchStatus; // 'open' | 'closed' | 'merged' | 'archived' | 'abandoned'
  name?: string; // Optional human-readable name
  [metadata: string]: any; // Your custom metadata
}
```

### Updating Branch Metadata

```typescript
// updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void>

await branchManager.updateBranch(branchDocId, {
  name: 'Renamed Branch',
  reviewStatus: 'pending',
  assignedTo: 'bob@example.com',
});
```

You can update `name` and any custom metadata. Protected fields (`id`, `docId`, `branchedAtRev`, `createdAt`, `status`) cannot be modified this way.

### Merging a Branch

```typescript
// mergeBranch(branchId: string): Promise<Change[]>

const changes = await branchManager.mergeBranch(branchDocId);

console.log(`Applied ${changes.length} changes to source document`);
```

What happens:

1. All changes from the branch are applied to the source document
2. For OT: Conflicts are resolved via operational transformation
3. For LWW: Timestamps determine winners automatically
4. The branch status is set to `'merged'`
5. Returns the changes that were committed to the source

If the branch has no changes, it's marked as merged and an empty array is returned.

### Closing a Branch

```typescript
// closeBranch(branchId: string, status?: Exclude<BranchStatus, 'open'>): Promise<void>

// Default status is 'closed'
await branchManager.closeBranch(branchDocId);

// Or specify a status
await branchManager.closeBranch(branchDocId, 'abandoned');
await branchManager.closeBranch(branchDocId, 'archived');
```

This updates the branch status but doesn't delete anything. Valid statuses: `'closed'`, `'merged'`, `'archived'`, `'abandoned'`.

## OT vs LWW Branching

The two branch managers handle merging differently based on their underlying sync algorithm.

### OT Branch Merging

`OTBranchManager` uses two merge strategies:

**Fast-forward merge** (no changes on source since branching):

- Branch changes are applied directly to the source
- Clean history - like the branch never diverged

**Divergent merge** (source has changed since branching):

- Branch changes are flattened into a single change
- That change is transformed against concurrent source changes
- Result is applied to source

Why flatten? Imagine a branch with 1,000 tiny changes. Transforming each individually against concurrent changes would be slow. Flattening gives the same result with better performance. See [branching.md](branching.md) for the full details.

### LWW Branch Merging

`LWWBranchManager` is simpler:

- Get all field changes from the branch
- Apply them to the source document
- Timestamps resolve conflicts automatically (later timestamp wins)

No transformation needed. LWW merging is idempotent - merge the same fields multiple times, get the same result.

## Store Requirements

Your store must implement `BranchingStoreBackend`:

```typescript
interface BranchingStoreBackend {
  // Optional: custom ID generation
  createBranchId?(docId: string): Promise<string> | string;

  // List branches for a source document
  listBranches(docId: string): Promise<Branch[]>;

  // Load a specific branch record
  loadBranch(branchId: string): Promise<Branch | null>;

  // Create a new branch record
  createBranch(branch: Branch): Promise<void>;

  // Update branch fields (status, name, metadata)
  updateBranch(branchId: string, updates: Partial<Pick<Branch, 'status' | 'name' | 'metadata'>>): Promise<void>;
}
```

Combine this with `OTStoreBackend` or `LWWStoreBackend` depending on your sync algorithm.

## Real-World Example

Here's a feature branching workflow with review and approval:

```typescript
import { OTServer, OTBranchManager } from '@dabble/patches/server';
import { MyDatabaseStore } from './database-store';

class DocumentWorkflow {
  private server: OTServer;
  private branchManager: OTBranchManager;
  private store: MyDatabaseStore;

  constructor() {
    this.store = new MyDatabaseStore();
    this.server = new OTServer(this.store);
    this.branchManager = new OTBranchManager(this.store, this.server);
  }

  async createFeatureBranch(sourceDocId: string, featureName: string, user: User) {
    // Get latest revision of the source doc
    const { rev } = await this.server.getDoc(sourceDocId);

    // Create the branch
    const branchDocId = await this.branchManager.createBranch(sourceDocId, rev, {
      name: `Feature: ${featureName}`,
      createdBy: user.id,
      feature: featureName,
    });

    return {
      branchDocId,
      url: `/documents/${branchDocId}`,
    };
  }

  async listFeatureBranches(sourceDocId: string) {
    const branches = await this.branchManager.listBranches(sourceDocId);

    return branches.map(branch => ({
      id: branch.id,
      name: branch.name,
      status: branch.status,
      createdBy: branch.createdBy || 'Unknown',
      url: `/documents/${branch.id}`,
    }));
  }

  async submitForReview(branchDocId: string, reviewer: User) {
    await this.branchManager.updateBranch(branchDocId, {
      reviewStatus: 'pending',
      reviewer: reviewer.id,
    });

    // Your notification logic here
  }

  async approveBranch(branchDocId: string, approver: User) {
    // Merge applies changes and sets status to 'merged'
    const changes = await this.branchManager.mergeBranch(branchDocId);

    // Update with approval metadata
    await this.branchManager.updateBranch(branchDocId, {
      approvedBy: approver.id,
      approvedAt: Date.now(),
    });

    return { changeCount: changes.length };
  }

  async rejectBranch(branchDocId: string, rejector: User, reason: string) {
    await this.branchManager.updateBranch(branchDocId, {
      reviewStatus: 'rejected',
      rejectedBy: rejector.id,
      rejectionReason: reason,
    });

    // Don't close - allow fixing and resubmitting
  }
}
```

## Related Documentation

- [Branching Concepts](branching.md) - How branches work under the hood
- [OTServer](OTServer.md) - Server for OT documents
- [LWWServer](LWWServer.md) - Server for LWW documents
- [PatchesHistoryManager](PatchesHistoryManager.md) - Version and snapshot management
- [Persistence](persist.md) - Storage backend implementation

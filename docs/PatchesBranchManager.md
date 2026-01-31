# `PatchesBranchManager` - Document Branching Made Easy! 🌿

Ever wanted to experiment with big changes without wrecking your main document? Or have multiple people work on different features at once? That's what `PatchesBranchManager` is all about! Think of it as "git branching" for your collaborative documents.

**Table of Contents**

- [Why Branches Are Awesome](#why-branches-are-awesome)
- [Getting Started](#getting-started)
- [Core Operations](#core-operations)
- [Behind the Scenes](#behind-the-scenes)
- [Real-World Example](#real-world-example)

## Why Branches Are Awesome

Branches give your collaborative workflow superpowers! Here's what you can do:

- **Try Bold New Ideas** 💡 - Experiment with massive changes without fear
- **Work in Parallel** 👥 - Have different teams working on separate features simultaneously
- **Review Process** 🔍 - Create branches for approval workflows before merging to main
- **Training Grounds** 🧪 - Let new users practice in a safe environment before touching the real thing

Basically, anytime you want a "copy" of a document that can diverge and then potentially merge back later, branches are your friend!

## Getting Started

Setting up branching is super simple:

```typescript
import { OTServer } from '@dabble/patches/server';
import { PatchesBranchManager, BranchingStoreBackend } from '@dabble/patches/server';
import { MyDatabaseStore } from './my-store'; // Your backend implementation

// First, you need your store and server
const store = new MyDatabaseStore(/* your connection details */);
const server = new OTServer(store);

// Then create the branch manager
const branchManager = new PatchesBranchManager(store, server);

// Now you're ready to branch and merge!
```

The `branchManager` needs both the store (to save branch metadata) and the server (to handle merging operations).

## Core Operations

Let's dive into the main things you can do with branches:

### Creating a Branch 🌱

```typescript
// Create a branch from the main document at a specific revision
const branchInfo = await branchManager.createBranch({
  sourceDocId: 'main-proposal', // The document to branch from
  branchId: 'experimental-draft', // ID for the new branch
  baseRev: 42, // Which revision to branch from
  name: 'Experimental Draft', // Human-readable name
  metadata: {
    // Any extra info you want to store
    createdBy: 'alice@example.com',
    purpose: 'Testing new layout',
  },
});

console.log(`Created branch: ${branchInfo.name}`);
console.log(`The branch document ID is: ${branchInfo.docId}`);
```

What happens:

1. A new document is created based on the state of the source at the specified revision
2. This branch is tracked so you can merge it back later
3. You get back info about the new branch, including its document ID
4. You can now edit this branch independently from the main document!

### Listing Branches 📋

Need to see all branches for a document?

```typescript
// List all branches for a document
const branches = await branchManager.listBranches('main-proposal');

console.log(`Document has ${branches.length} branches`);

// Just get open branches (not merged or closed)
const openBranches = await branchManager.listBranches('main-proposal', {
  status: 'open',
});

// Or filter by who created them
const myBranches = await branchManager.listBranches('main-proposal', {
  metadata: { createdBy: 'alice@example.com' },
});
```

The branch list gives you all the metadata you need to display a nice branch management UI.

### Merging a Branch 🔄

When you're ready to bring those experimental changes back to the main document:

```typescript
// Merge the branch back into the source document
const mergeResult = await branchManager.mergeBranch({
  sourceDocId: 'main-proposal',
  branchId: 'experimental-draft',
  name: 'Experimental Layout Integration', // Optional name for the merge commit
  metadata: {
    // Optional metadata
    approvedBy: 'bob@example.com',
  },
});

console.log(`Merged ${mergeResult.changeCount} changes back to main document`);
console.log(`New revision after merge: ${mergeResult.rev}`);
```

What happens:

1. All changes made on the branch get transformed and applied to the main document
2. The server handles any conflicts using OT magic
3. The branch stays open (unless you specify `autoClose: true`) but is marked as merged
4. The main document now includes all the branch's changes!

### Closing a Branch ❌

Done with a branch and want to mark it as obsolete?

```typescript
// Close a branch (mark it as no longer active)
await branchManager.closeBranch('main-proposal', 'experimental-draft', {
  status: 'abandoned', // 'merged', 'abandoned', or 'closed'
  metadata: {
    reason: 'Feature was deprioritized',
  },
});

console.log('Branch marked as abandoned');
```

This doesn't delete anything - it just updates the branch's status so you know it's no longer active.

## Behind the Scenes

`PatchesBranchManager` relies on your `BranchingStoreBackend` implementation to store all the branch metadata and relationships. This backend extends the regular `PatchesStoreBackend` with additional methods specifically for branch management.

The key relationship is:

- Each branch points to its source document
- Each branch has its own document ID (so it's a real document in the system)
- Branches track which revision they branched from
- Branches have status (open, merged, abandoned, etc.)

## Real-World Example

Here's how you might implement a feature branching workflow in your app:

```typescript
import { OTServer } from '@dabble/patches/server';
import { PatchesBranchManager } from '@dabble/patches/server';
import { MyDatabaseStore } from './database-store';

class DocumentWorkflow {
  private server: OTServer;
  private branchManager: PatchesBranchManager;

  constructor() {
    const store = new MyDatabaseStore();
    this.server = new OTServer(store);
    this.branchManager = new PatchesBranchManager(store, this.server);
  }

  async createFeatureBranch(sourceDocId: string, featureName: string, user: User) {
    // Get latest revision of the source doc
    const { rev } = await this.server.getLatestDocumentStateAndRev(sourceDocId);

    // Create a unique ID for the branch
    const branchId = `feature-${Date.now()}-${featureName.toLowerCase().replace(/\s+/g, '-')}`;

    // Create the branch
    const branchInfo = await this.branchManager.createBranch({
      sourceDocId,
      branchId,
      baseRev: rev,
      name: `Feature: ${featureName}`,
      metadata: {
        createdBy: user.id,
        createdAt: new Date().toISOString(),
        status: 'draft',
        feature: featureName,
      },
    });

    // Return information about the new branch
    return {
      branchId: branchInfo.branchId,
      docId: branchInfo.docId,
      name: branchInfo.name,
      url: `/documents/${branchInfo.docId}`, // URL for the branch document
    };
  }

  async listFeatureBranches(sourceDocId: string) {
    // Get all branches
    const allBranches = await this.branchManager.listBranches(sourceDocId);

    // Format them for display
    return allBranches.map(branch => ({
      id: branch.branchId,
      name: branch.name,
      status: branch.status,
      createdBy: branch.metadata?.createdBy || 'Unknown',
      createdAt: branch.metadata?.createdAt || 'Unknown date',
      lastActivity: branch.updatedAt,
      url: `/documents/${branch.docId}`,
    }));
  }

  async submitForReview(sourceDocId: string, branchId: string, reviewer: User) {
    // Update branch metadata to reflect review status
    await this.branchManager.updateBranch(sourceDocId, branchId, {
      metadata: {
        status: 'in_review',
        reviewRequestedAt: new Date().toISOString(),
        reviewer: reviewer.id,
      },
    });

    // Notify the reviewer (implementation depends on your app)
    await this.notifyUser(reviewer.id, {
      type: 'review_request',
      sourceDocId,
      branchId,
      message: `You've been asked to review a document branch`,
    });

    return { success: true };
  }

  async approveBranch(sourceDocId: string, branchId: string, approver: User) {
    // Merge the branch back to main
    const mergeResult = await this.branchManager.mergeBranch({
      sourceDocId,
      branchId,
      name: `Approved feature: ${branchId}`,
      metadata: {
        approvedBy: approver.id,
        approvedAt: new Date().toISOString(),
      },
      autoClose: true, // Automatically close the branch after merging
    });

    // Notify the branch creator (implementation depends on your app)
    const branch = await this.branchManager.getBranch(sourceDocId, branchId);
    await this.notifyUser(branch.metadata?.createdBy, {
      type: 'branch_approved',
      sourceDocId,
      branchId,
      message: `Your branch has been approved and merged!`,
    });

    return {
      success: true,
      newRevision: mergeResult.rev,
      changeCount: mergeResult.changeCount,
    };
  }

  async rejectBranch(sourceDocId: string, branchId: string, rejector: User, reason: string) {
    // Update branch metadata with rejection reason
    await this.branchManager.updateBranch(sourceDocId, branchId, {
      metadata: {
        status: 'rejected',
        rejectedBy: rejector.id,
        rejectedAt: new Date().toISOString(),
        rejectionReason: reason,
      },
    });

    // Don't close the branch - allow for fixing and resubmitting

    // Notify the branch creator
    const branch = await this.branchManager.getBranch(sourceDocId, branchId);
    await this.notifyUser(branch.metadata?.createdBy, {
      type: 'branch_rejected',
      sourceDocId,
      branchId,
      message: `Your branch was rejected: ${reason}`,
    });

    return { success: true };
  }

  // Helper method - implementation depends on your app
  private async notifyUser(userId: string, notification: any) {
    // Send in-app notification, email, etc.
  }
}
```

This example shows how you can build a complete workflow with feature branches, review processes, approvals, and notifications!

---

Branches add a whole new dimension to collaborative editing. Instead of everyone always working on the same document, you can create sandboxes for experimentation and coordinate multiple workstreams with ease. Happy branching! 🌳

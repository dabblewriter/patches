# `PatchesHistoryManager` - Your Doc's Time Machine! ⏰

Ever wanted to peek into your document's past? Time travel to see who added what and when? That's exactly what `PatchesHistoryManager` is for! This awesome little utility gives you a window into your document's history - from tiny edits to major milestones.

**Table of Contents**

- [The Basics](#the-basics)
- [Getting Started](#getting-started)
- [Digging Through History](#digging-through-history)
- [Finding Specific Changes](#finding-specific-changes)
- [Behind-the-Scenes Magic](#behind-the-scenes-magic)
- [Example: Building a History Explorer](#example-building-a-history-explorer)

## The Basics

`PatchesHistoryManager` is your backdoor into the past. It lets you:

- 📋 List all the versions of a document
- 📝 See what a document looked like at any point in time
- 🔍 Find out exactly what changes were made in each version
- 🕵️ Track who changed what and when
- ↩️ Get the data you need to restore previous versions

This is perfect for creating features like:

- Version history browsers
- "Restore previous version" buttons
- Activity logs showing who did what
- Debugging tools to diagnose sync problems

## Getting Started

Using `PatchesHistoryManager` is super easy:

```typescript
import { PatchesHistoryManager } from '@dabble/patches/server';
import { MyDatabaseStore } from './my-store'; // Your backend implementation

// Create your store
const store = new MyDatabaseStore(/* connection details */);

// Create the history manager
const historyManager = new PatchesHistoryManager(store);

// Now you're ready to start exploring the past!
```

That's it! Now you have a history manager that can work with any document.

## Digging Through History

Let's explore the different ways you can peek into the past:

### Listing Document Versions

Get a snapshot of all the document versions:

```typescript
// Get the 10 most recent versions
const recentVersions = await historyManager.listVersions('project-proposal-final', {
  limit: 10,
  reverse: true, // Most recent first
  orderBy: 'rev', // Sort by revision number
});

console.log(`Found ${recentVersions.length} versions`);

// Versions from a specific revision range
const versionsInRange = await historyManager.listVersions('project-proposal-final', {
  startAfter: 50, // List versions after revision 50
  endBefore: 75, // List versions before revision 75
  orderBy: 'rev', // Sort by revision number
});

// Versions with a specific origin
const offlineVersions = await historyManager.listVersions('project-proposal-final', {
  origin: 'offline', // Filter by origin type ('main', 'offline', or 'branch')
  groupId: 'batch-123', // Optional: filter by group ID (for offline batches or branches)
});
```

Each version gives you metadata like:

- When it was created
- Who created it
- What changes it contains
- Version name (if assigned)

### Getting a Specific Version

Want to see exactly what the document looked like at a certain point?

```typescript
const docId = 'project-proposal-final';

// Get the actual document state at that version
const oldState = await historyManager.getStateAtVersion(docId, versionId);
console.log('The document looked like:', oldState);

// Get the changes that were made in this version
const changes = await historyManager.getChangesForVersion(docId, versionId);
console.log(`This version includes ${changes.length} changes`);
```

### Finding a Version's Parent

Every version (except the first) has a parent version. This lets you trace the document's evolution:

```typescript
// Get the state of the version that came before this one
const parentState = await historyManager.getParentState(docId, versionId);
console.log('Before those changes, the document was:', parentState);
```

## Finding Specific Changes

Sometimes you don't care about versions - you just want to see specific changes based on their revision numbers:

```typescript
const docId = 'project-proposal-final';

// Get all changes between revision 50 and 75
const changes = await historyManager.listServerChanges(docId, {
  startAfterRev: 50,
  endAtRev: 75,
});

console.log(`Found ${changes.length} changes in that range`);

// Or just get the 10 most recent changes
const recentChanges = await historyManager.listServerChanges(docId, {
  limit: 10,
  reverse: true,
});
```

This is super helpful for:

- Syncing specific revision ranges
- Auditing who made which edits
- Debugging sync issues

## Behind-the-Scenes Magic

`PatchesHistoryManager` doesn't do the actual storage - it just knows how to ask your backend for the right information. That's why you need to give it a `PatchesStoreBackend` implementation.

This design makes it flexible enough to work with any storage system - from in-memory (for testing) to massive distributed databases.

## Example: Building a History Explorer

Here's a simple example of building a document history UI:

```typescript
import { PatchesHistoryManager } from '@dabble/patches/server';
import { MyDatabaseStore } from './my-store';

class DocumentHistoryExplorer {
  private historyManager: PatchesHistoryManager;
  private docId: string;

  constructor(docId: string) {
    const store = new MyDatabaseStore();
    this.historyManager = new PatchesHistoryManager(store);
    this.docId = docId;
  }

  async getVersionTimeline() {
    // Get all versions, newest first
    const versions = await this.historyManager.listVersions(this.docId, {
      reverse: true,
      orderBy: 'startDate',
    });

    // Format them for display
    return versions.map(version => ({
      id: version.id,
      name: version.name || `Version at ${new Date(version.startDate).toLocaleString()}`,
      date: new Date(version.startDate),
      changeCount: version.changes.length,
    }));
  }

  async viewVersion(versionId: string) {
    // Get the version data
    const state = await this.historyManager.getStateAtVersion(this.docId, versionId);
    const changes = await this.historyManager.getChangesForVersion(this.docId, versionId);

    return {
      state,
      changes,
    };
  }

  async restoreVersion(versionId: string) {
    // Get the state at this version
    const state = await this.historyManager.getStateAtVersion(this.docId, versionId);

    // Then use your PatchesDoc to replace current state with this one
    // (Implementation depends on your app structure)
    await this.documentManager.replaceDocumentWithState(state);

    return { success: true, restoredState: state };
  }

  async getChangeDetails(startRev: number, endRev: number) {
    // Get specific changes by revision range
    const changes = await this.historyManager.listServerChanges(this.docId, {
      startAfterRev: startRev - 1,
      endAtRev: endRev,
    });

    // Format changes for display
    return changes.map(change => ({
      id: change.id,
      rev: change.rev,
      date: new Date(change.created),
      operations: change.ops.length,
      // Extract author info if available
      author: change.metadata?.user?.name || 'Unknown',
    }));
  }
}

// Usage
const explorer = new DocumentHistoryExplorer('important-document');

// Show version history
const versions = await explorer.getVersionTimeline();
renderVersionList(versions);

// View a specific version
const versionDetails = await explorer.viewVersion(selectedVersionId);
renderVersionViewer(versionDetails);

// Restore an old version
await explorer.restoreVersion(versionToRestoreId);
showNotification('Document restored to previous version!');
```

And there you have it! With `PatchesHistoryManager`, you can give your users the power to explore and restore their document's past. Time travel made easy! ⏱️✨

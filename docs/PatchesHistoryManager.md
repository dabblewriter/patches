# PatchesHistoryManager

Server-side document history access. If you need to build version history browsers, restore features, audit logs, or debugging tools, this is your entry point.

**Table of Contents**

- [What It Does](#what-it-does)
- [Getting Started](#getting-started)
- [API Reference](#api-reference)
  - [listVersions](#listversions)
  - [createVersion](#createversion)
  - [updateVersion](#updateversion)
  - [getStateAtVersion](#getstateatversion)
  - [getChangesForVersion](#getchangesforversion)
- [Version vs Change: Know the Difference](#version-vs-change-know-the-difference)
- [Example: Building a History Explorer](#example-building-a-history-explorer)
- [Related Documentation](#related-documentation)

## What It Does

`PatchesHistoryManager` provides read access to your document's history on the server. It handles:

- **Listing versions** - Retrieve version metadata with filtering and sorting
- **Creating versions** - Capture the current document state as a named version
- **Updating versions** - Modify version metadata (name, description, tags)
- **Loading version state** - Get the exact document state at any version
- **Loading version changes** - See what operations were included in a version

This is separate from [PatchesHistoryClient](PatchesHistoryClient.md), which is the client-side counterpart for exploring history from the browser.

## Getting Started

```typescript
import { PatchesHistoryManager, OTServer } from '@dabble/patches/server';
import { MyDatabaseStore } from './my-store';

const store = new MyDatabaseStore();
const server = new OTServer(store);
const historyManager = new PatchesHistoryManager(server, store);
```

The history manager needs both a [PatchesServer](OTServer.md) instance and a `VersioningStoreBackend`. The server handles version creation logic; the store handles persistence.

Note: `PatchesHistoryManager` works with both [OTServer](OTServer.md) and [LWWServer](LWWServer.md) - any server that implements `captureCurrentVersion`.

## API Reference

### listVersions

Lists version metadata for a document with optional filtering and sorting.

```typescript
const versions = await historyManager.listVersions('doc-123', {
  limit: 10,
  reverse: true, // Most recent first
  orderBy: 'startedAt', // Sort by creation time (default)
});
```

**Options:**

| Option       | Type                                     | Description                                             |
| ------------ | ---------------------------------------- | ------------------------------------------------------- |
| `startAfter` | `number \| string`                       | List versions after this value (based on orderBy field) |
| `endBefore`  | `number \| string`                       | List versions before this value                         |
| `limit`      | `number`                                 | Maximum versions to return                              |
| `orderBy`    | `'startedAt' \| 'endRev' \| 'startRev'`  | Sort field (defaults to `'startedAt'`)                  |
| `reverse`    | `boolean`                                | Descending order when true                              |
| `origin`     | `'main' \| 'offline-branch' \| 'branch'` | Filter by origin type                                   |
| `groupId`    | `string`                                 | Filter by group ID (branch or offline batch)            |

**Returns:** `Promise<VersionMetadata[]>` - Array of version metadata objects with fields like `id`, `name`, `description`, `startedAt`, `endedAt`, `startRev`, `endRev`, `origin`, `groupId`, and `parentId`.

### createVersion

Captures the current document state as a new named version.

```typescript
const versionId = await historyManager.createVersion('doc-123', {
  name: 'Version 1.0',
  description: 'Initial release',
  tags: ['release', 'stable'],
});
```

**Parameters:**

- `docId` - The document ID
- `metadata` (optional) - Version metadata with `name`, `description`, and/or `tags`

**Returns:** `Promise<string | null>` - The new version ID, or `null` if there were no changes to capture.

### updateVersion

Modifies metadata for an existing version.

```typescript
await historyManager.updateVersion('doc-123', 'version-abc', {
  name: 'Version 1.0 (Final)',
  description: 'Updated description',
});
```

### getStateAtVersion

Loads the complete document state at a specific version.

```typescript
const state = await historyManager.getStateAtVersion('doc-123', 'version-abc');
console.log('Document at that version:', state);
```

Throws an error if the version doesn't exist or loading fails.

### getChangesForVersion

Retrieves the individual changes that were included in a specific version. Useful for replaying or scrubbing through operations.

```typescript
const changes = await historyManager.getChangesForVersion('doc-123', 'version-abc');
console.log(`This version contains ${changes.length} changes`);
```

Each change includes `id`, `rev`, `baseRev`, `ops`, `createdAt`, `committedAt`, and `metadata`. See [JSON Patch](json-patch.md) for details on the `ops` format.

## Version vs Change: Know the Difference

A **version** groups multiple changes together. Versions are created automatically (after periods of inactivity) or manually (via `createVersion`). Versions have metadata like names and descriptions.

A **change** is a single atomic edit - one call to `doc.change()`. Changes have revision numbers and [JSON Patch operations](json-patch.md).

Use `listVersions` + `getChangesForVersion` when you want the user-facing version history with nice labels. For raw revision-level access, query the store's `listChanges` method directly (OT only).

## Example: Building a History Explorer

```typescript
import { PatchesHistoryManager, OTServer } from '@dabble/patches/server';
import { MyDatabaseStore } from './my-store';

class DocumentHistoryExplorer {
  private historyManager: PatchesHistoryManager;
  private docId: string;

  constructor(docId: string) {
    const store = new MyDatabaseStore();
    const server = new OTServer(store);
    this.historyManager = new PatchesHistoryManager(server, store);
    this.docId = docId;
  }

  async getVersionTimeline() {
    const versions = await this.historyManager.listVersions(this.docId, {
      reverse: true,
      orderBy: 'startedAt',
    });

    return versions.map(version => ({
      id: version.id,
      name: version.name || `Version at ${new Date(version.startedAt).toLocaleString()}`,
      date: new Date(version.startedAt),
      revisionRange: `${version.startRev} - ${version.endRev}`,
    }));
  }

  async viewVersion(versionId: string) {
    const [state, changes] = await Promise.all([
      this.historyManager.getStateAtVersion(this.docId, versionId),
      this.historyManager.getChangesForVersion(this.docId, versionId),
    ]);

    return { state, changes };
  }

  async createNamedVersion(name: string, description?: string) {
    return this.historyManager.createVersion(this.docId, {
      name,
      description,
    });
  }

}

// Usage
const explorer = new DocumentHistoryExplorer('important-document');

const versions = await explorer.getVersionTimeline();
console.log('Version history:', versions);

const details = await explorer.viewVersion(versions[0].id);
console.log('Latest version state:', details.state);
console.log('Changes in this version:', details.changes.length);
```

## Related Documentation

- [PatchesHistoryClient](PatchesHistoryClient.md) - Client-side history access with scrubbing support
- [OTServer](OTServer.md) - Server-side OT document management
- [LWWServer](LWWServer.md) - Server-side LWW document management
- [Persistence](persist.md) - Storage backend implementation details
- [JSON Patch](json-patch.md) - Understanding change operations
- [Operational Transformation](operational-transformation.md) - How changes are transformed and versioned
- [Branching](branching.md) - How versions relate to branches

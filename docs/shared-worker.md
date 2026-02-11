# SharedWorker Architecture: One Connection to Rule Them All

Multiple browser tabs. Each one syncing documents. Do you really need five WebSocket connections doing the same work?

No.

**Table of Contents**

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [How the API Supports This](#how-the-api-supports-this)
- [Building the Worker Side](#building-the-worker-side)
- [Building the Tab Side](#building-the-tab-side)
- [The Full Picture](#the-full-picture)
- [Gotchas and Edge Cases](#gotchas-and-edge-cases)
- [What's Not Included](#whats-not-included)
- [Related Documentation](#related-documentation)

## The Problem

The typical multi-tab setup:

```
Tab A ──WebSocket──► Server
Tab B ──WebSocket──► Server
Tab C ──WebSocket──► Server
```

Three connections. Three IndexedDB handles fighting over the same data. Three sets of pending changes that might conflict. Chaos dressed as architecture.

What you actually want:

```
Tab A ◄──────┐
Tab B ◄──────┼── SharedWorker ──WebSocket──► Server
Tab C ◄──────┘
```

One connection. One source of truth. Changes flow through a single point.

## The Solution

The Patches API supports this pattern by design. The key insight:

**Documents live in tabs. Storage and sync live in the worker.**

The worker doesn't render anything. It doesn't need document instances with reactive state and change tracking. It needs to:

1. Store changes when tabs make them
2. Sync with the server
3. Broadcast updates to all tabs

Tabs handle document state, UI updates, and user interactions.

## How the API Supports This

The [`ClientAlgorithm`](algorithms.md) interface has two methods designed for this:

```typescript
// Process a local change - doc can be undefined (worker scenario)
handleDocChange<T extends object>(
  docId: string,
  ops: JSONPatchOp[],
  doc: PatchesDoc<T> | undefined,  // <-- undefined in worker
  metadata: Record<string, any>
): Promise<Change[]>;

// Apply server changes - doc can be undefined (worker scenario)
applyServerChanges<T extends object>(
  docId: string,
  serverChanges: Change[],
  doc: PatchesDoc<T> | undefined   // <-- undefined in worker
): Promise<Change[]>;
```

Both methods return `Change[]` - exactly what you need to broadcast to tabs.

On the document side, [`BaseDoc`](PatchesDoc.md) has:

```typescript
// Apply changes from the worker (after broadcast)
applyChanges(changes: Change[]): void;

// Update sync state indicator
updateSyncing(newSyncing: SyncingState): void;

// Restore state from a snapshot
import(snapshot: PatchesSnapshot<T>): void;
```

These internal methods let tabs update their documents from worker broadcasts. They're on `BaseDoc`, not the app-facing [`PatchesDoc`](PatchesDoc.md) interface - by design.

## Building the Worker Side

The worker holds the algorithm and store, but no documents:

```typescript
// shared-worker.ts
import { OTAlgorithm, OTIndexedDBStore } from '@dabble/patches/client';
import type { JSONPatchOp, Change } from '@dabble/patches';

class WorkerCoordinator {
  private algorithm: OTAlgorithm;
  private store: OTIndexedDBStore;
  private ports: Set<MessagePort> = new Set();

  constructor() {
    this.store = new OTIndexedDBStore('my-app');
    this.algorithm = new OTAlgorithm(this.store);

    // Set up your WebSocket connection here
    // When server sends changes, call this.handleServerChanges()
  }

  // Tab connected
  addPort(port: MessagePort) {
    this.ports.add(port);
    port.onmessage = e => this.handleTabMessage(port, e.data);
  }

  // Tab made a change
  async handleLocalChange(docId: string, ops: JSONPatchOp[], metadata: Record<string, any> = {}) {
    // No doc instance - pass undefined
    const changes = await this.algorithm.handleDocChange(docId, ops, undefined, metadata);

    // Broadcast to ALL tabs (including the one that made the change)
    this.broadcast({ type: 'changes', docId, changes });
  }

  // Server sent changes
  async handleServerChanges(docId: string, serverChanges: Change[]) {
    // No doc instance - pass undefined
    const changes = await this.algorithm.applyServerChanges(docId, serverChanges, undefined);

    // Broadcast to all tabs
    this.broadcast({ type: 'changes', docId, changes });
  }

  // Tab requests a document snapshot
  async handleLoadDoc(port: MessagePort, docId: string) {
    const snapshot = await this.store.getDoc(docId);
    port.postMessage({ type: 'snapshot', docId, snapshot });
  }

  private broadcast(message: any) {
    for (const port of this.ports) {
      port.postMessage(message);
    }
  }

  private handleTabMessage(port: MessagePort, message: any) {
    switch (message.type) {
      case 'change':
        this.handleLocalChange(message.docId, message.ops, message.metadata);
        break;
      case 'loadDoc':
        this.handleLoadDoc(port, message.docId);
        break;
      // ... other message types
    }
  }
}

// SharedWorker setup
const coordinator = new WorkerCoordinator();

self.onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  coordinator.addPort(port);
  port.start();
};
```

## Building the Tab Side

Tabs hold documents but delegate storage and sync to the worker:

```typescript
// tab-client.ts
import { OTDoc, BaseDoc } from '@dabble/patches/client';
import type { Change, PatchesSnapshot, SyncingState } from '@dabble/patches';

class TabClient {
  private worker: SharedWorker;
  private port: MessagePort;
  private docs: Map<string, OTDoc<any>> = new Map();

  constructor() {
    this.worker = new SharedWorker('/shared-worker.js');
    this.port = this.worker.port;
    this.port.onmessage = e => this.handleWorkerMessage(e.data);
    this.port.start();
  }

  // Open a document - request snapshot from worker
  async openDoc<T extends object>(docId: string): Promise<OTDoc<T>> {
    return new Promise(resolve => {
      // Request the snapshot
      this.port.postMessage({ type: 'loadDoc', docId });

      // Wait for the response (in real code, use a proper request/response pattern)
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'snapshot' && e.data.docId === docId) {
          const doc = new OTDoc<T>(docId, e.data.snapshot);
          this.docs.set(docId, doc);

          // Wire up change handling - send ops to worker, don't apply locally
          doc.onChange(ops => {
            this.port.postMessage({
              type: 'change',
              docId,
              ops,
              metadata: { user: getCurrentUser() },
            });
          });

          this.port.removeEventListener('message', handler);
          resolve(doc);
        }
      };
      this.port.addEventListener('message', handler);
    });
  }

  // Handle messages from worker
  private handleWorkerMessage(message: any) {
    switch (message.type) {
      case 'changes':
        this.applyChanges(message.docId, message.changes);
        break;
      case 'syncing':
        this.updateSyncingState(message.docId, message.state);
        break;
    }
  }

  // Apply changes broadcast from worker
  private applyChanges(docId: string, changes: Change[]) {
    const doc = this.docs.get(docId) as BaseDoc | undefined;
    if (doc) {
      doc.applyChanges(changes);
    }
  }

  // Update syncing state from worker
  private updateSyncingState(docId: string, state: SyncingState) {
    const doc = this.docs.get(docId) as BaseDoc | undefined;
    if (doc) {
      doc.updateSyncing(state);
    }
  }
}
```

## The Full Picture

How changes flow through the system:

### User Makes a Change

```
1. User types in Tab A
2. Tab A's doc.change() captures ops
3. Tab A's onChange fires, sends ops to Worker
4. Worker calls algorithm.handleDocChange(docId, ops, undefined, metadata)
5. Algorithm creates Change, stores it, returns Change[]
6. Worker broadcasts { type: 'changes', changes } to ALL tabs
7. Tab A, B, C all call doc.applyChanges(changes)
8. All tabs show the same state
```

### Server Sends Changes

```
1. Server pushes changes to Worker via WebSocket
2. Worker calls algorithm.applyServerChanges(docId, changes, undefined)
3. Algorithm processes changes (rebases pending for OT), returns Change[]
4. Worker broadcasts { type: 'changes', changes } to all tabs
5. All tabs call doc.applyChanges(changes)
6. Everyone's in sync
```

### Tab Opens a Document

```
1. Tab D opens, requests doc "project-123"
2. Worker loads snapshot from store via algorithm.loadDoc()
3. Worker sends snapshot to Tab D
4. Tab D creates OTDoc with snapshot
5. Tab D starts receiving broadcasts like everyone else
```

## Gotchas and Edge Cases

### Don't Apply Changes Locally First

When a tab makes a change, it should **not** optimistically apply it. The flow is:

1. Tab emits ops to worker
2. Worker creates the change and broadcasts
3. Tab receives broadcast and applies

This keeps all tabs perfectly synchronized. If Tab A applied changes locally before the broadcast, it would be ahead of other tabs until they caught up. The synchronization advantage of SharedWorkers disappears if you break this discipline.

### Handle Tab Disconnection

When a tab closes, clean up:

```typescript
// In worker
port.onclose = () => {
  this.ports.delete(port);
};
```

### Handle Worker Restart

SharedWorkers can be killed by the browser. When a tab reconnects to a fresh worker, it needs to re-sync:

```typescript
// In tab, on worker connection
async reconnect() {
  for (const [docId, doc] of this.docs) {
    // Request fresh snapshot
    const snapshot = await this.requestSnapshot(docId);
    (doc as BaseDoc).import(snapshot);
  }
}
```

### LWW Works the Same Way

Everything above applies to [LWW](last-write-wins.md) too. Swap `OTAlgorithm` for `LWWAlgorithm`, `OTDoc` for `LWWDoc`, and `OTIndexedDBStore` for `LWWIndexedDBStore`. The `handleDocChange` and `applyServerChanges` methods have identical signatures.

**The key difference: no rebasing.** [OT](operational-transformation.md) transforms pending changes when server updates arrive. LWW compares timestamps - whoever wrote last wins. Simpler coordination, but the SharedWorker pattern still matters.

**What `LWWIndexedDBStore` stores:**

- `committedOps` - Server-confirmed operations (field-level, keyed by `[docId, path]`)
- `pendingOps` - Local changes waiting to be sent (keyed by `[docId, path]`)
- `sendingChanges` - In-flight changes (keyed by `docId`, for retry after disconnect)

**State reconstruction order:**

```
snapshot → committedOps → sendingChange.ops → pendingOps
```

Each layer overwrites the previous. Snapshot is the base, committed ops are server truth, sending ops are "probably confirmed soon," pending ops are local-only.

**Same benefits apply:**

- Single IndexedDB connection (no multi-tab corruption)
- Coordinated sync (one WebSocket, not five)
- No duplicate submissions (`sendingChange` tracks in-flight state)

### Cast to BaseDoc for Internal Methods

The [`PatchesDoc`](PatchesDoc.md) interface is app-facing and doesn't expose `applyChanges`, `import`, or `updateSyncing`. To call these from your tab client, cast to `BaseDoc`:

```typescript
import { BaseDoc } from '@dabble/patches/client';
import type { SyncingState } from '@dabble/patches';

const baseDoc = doc as BaseDoc;
baseDoc.applyChanges(changes);
baseDoc.updateSyncing(null); // SyncingState: null = synced, 'updating' = syncing, 'initial' = first sync, Error = failed
baseDoc.import(snapshot);
```

This separation is intentional. App code uses `PatchesDoc`. Infrastructure code (like the tab client) uses `BaseDoc`.

## What's Not Included

This guide covers architecture and API usage. You still need to build:

- The actual SharedWorker message passing (consider [Comlink](https://github.com/GoogleChromeLabs/comlink) for RPC-style calls)
- Request/response correlation for async operations
- Error handling and retry logic
- Worker health monitoring and reconnection

The Patches API provides the building blocks. The plumbing between worker and tabs is your domain.

## Related Documentation

- [Patches](Patches.md) - Main client coordinator
- [PatchesDoc](PatchesDoc.md) - Document interface and `BaseDoc` internals
- [PatchesSync](PatchesSync.md) - Standard sync coordinator (what you're replacing with SharedWorker)
- [persist.md](persist.md) - Store implementations (`OTIndexedDBStore`, `LWWIndexedDBStore`)
- [algorithms.md](algorithms.md) - `ClientAlgorithm` interface details
- [last-write-wins.md](last-write-wins.md) - LWW algorithm overview
- [operational-transformation.md](operational-transformation.md) - OT algorithm overview
- [net.md](net.md) - Networking layer (WebSocket protocol)

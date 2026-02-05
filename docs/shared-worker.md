# SharedWorker Architecture: One Connection to Rule Them All

So you've got multiple browser tabs open. Each one wants to sync documents. And you're thinking, "Do I really need five WebSocket connections doing the same thing?"

No. No you don't.

**Table of Contents**

- [SharedWorker Architecture: One Connection to Rule Them All](#sharedworker-architecture-one-connection-to-rule-them-all)
  - [The Problem](#the-problem)
  - [The Solution](#the-solution)
  - [How the API Supports This](#how-the-api-supports-this)
  - [Building the Worker Side](#building-the-worker-side)
  - [Building the Tab Side](#building-the-tab-side)
  - [The Full Picture](#the-full-picture)
    - [User Makes a Change](#user-makes-a-change)
    - [Server Sends Changes](#server-sends-changes)
    - [Tab Opens a Document](#tab-opens-a-document)
  - [Gotchas and Edge Cases](#gotchas-and-edge-cases)
    - [Don't Apply Changes Locally First](#dont-apply-changes-locally-first)
    - [Handle Tab Disconnection](#handle-tab-disconnection)
    - [Handle Worker Restart](#handle-worker-restart)
    - [LWW Works the Same Way](#lww-works-the-same-way)
    - [Cast to BaseDoc for Internal Methods](#cast-to-basedoc-for-internal-methods)
  - [What's Not Included](#whats-not-included)

## The Problem

Here's the typical setup without a SharedWorker:

```
Tab A ──WebSocket──► Server
Tab B ──WebSocket──► Server
Tab C ──WebSocket──► Server
```

Three connections. Three IndexedDB handles fighting over the same data. Three sets of pending changes that might conflict. It's chaos dressed up as architecture.

What you actually want:

```
Tab A ◄──────┐
Tab B ◄──────┼── SharedWorker ──WebSocket──► Server
Tab C ◄──────┘
```

One connection. One source of truth. Changes flow through a single point. Sanity restored.

## The Solution

The Patches API is designed to support this pattern. Here's the key insight:

**Documents live in tabs. Storage and sync live in the worker.**

The worker doesn't render anything. It doesn't need document instances with reactive state and change tracking. It just needs to:

1. Store changes when tabs make them
2. Sync with the server
3. Broadcast updates to all tabs

The tabs handle the actual document state, UI updates, and user interactions.

## How the API Supports This

The `ClientStrategy` interface has two methods that make this work:

```typescript
// Process a local change - doc can be undefined (worker scenario)
handleDocChange<T>(
  docId: string,
  ops: JSONPatchOp[],
  doc: PatchesDoc<T> | undefined,  // <-- undefined in worker
  metadata?: ChangeMetadata
): Promise<Change[]>;

// Apply server changes - doc can be undefined (worker scenario)
applyServerChanges<T>(
  docId: string,
  serverChanges: Change[],
  doc: PatchesDoc<T> | undefined   // <-- undefined in worker
): Promise<Change[]>;
```

Both methods return `Change[]` - exactly what you need to broadcast to tabs.

On the document side, `BaseDoc` has:

```typescript
// Apply changes from the worker (after broadcast)
applyChanges(changes: Change[]): void;

// Restore state from a snapshot
import(snapshot: PatchesSnapshot<T>): void;
```

These are the internal methods tabs use to update their documents from worker broadcasts.

## Building the Worker Side

The worker holds the strategy and store, but no documents:

```typescript
// shared-worker.ts
import { OTStrategy, IndexedDBStore } from '@dabble/patches/client';
import { PatchesSync } from '@dabble/patches/net';

class WorkerCoordinator {
  private strategy: OTStrategy;
  private store: IndexedDBStore;
  private sync: PatchesSync;
  private ports: Set<MessagePort> = new Set();

  constructor() {
    this.store = new IndexedDBStore('my-app');
    this.strategy = new OTStrategy(this.store);

    // Set up sync - we'll handle the callbacks
    this.sync = new PatchesSync(/* ... */);
  }

  // Tab connected
  addPort(port: MessagePort) {
    this.ports.add(port);
    port.onmessage = e => this.handleTabMessage(port, e.data);
  }

  // Tab made a change
  async handleLocalChange(docId: string, ops: JSONPatchOp[], metadata?: ChangeMetadata) {
    // No doc instance - pass undefined
    const changes = await this.strategy.handleDocChange(docId, ops, undefined, metadata);

    // Broadcast to ALL tabs (including the one that made the change)
    this.broadcast({ type: 'changes', docId, changes });
  }

  // Server sent changes
  async handleServerChanges(docId: string, serverChanges: Change[]) {
    // No doc instance - pass undefined
    const changes = await this.strategy.applyServerChanges(docId, serverChanges, undefined);

    // Broadcast to all tabs
    this.broadcast({ type: 'changes', docId, changes });
  }

  // Tab requests a document snapshot
  async handleLoadDoc(port: MessagePort, docId: string) {
    const snapshot = await this.store.get(docId);
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

Tabs hold the documents but delegate storage and sync to the worker:

```typescript
// tab-client.ts
import { OTDoc } from '@dabble/patches/client';
import type { BaseDoc } from '@dabble/patches/client';
import type { Change, PatchesSnapshot } from '@dabble/patches';

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

Here's how a change flows through the system:

### User Makes a Change

```
1. User types in Tab A
2. Tab A's doc.change() creates ops
3. Tab A's onChange fires, sends ops to Worker
4. Worker calls strategy.handleDocChange(docId, ops, undefined)
5. Strategy creates Change, stores it, returns [change]
6. Worker broadcasts { type: 'changes', changes } to ALL tabs
7. Tab A, B, C all call doc.applyChanges(changes)
8. All tabs now show the same state
```

### Server Sends Changes

```
1. Server pushes changes to Worker via WebSocket
2. Worker calls strategy.applyServerChanges(docId, changes, undefined)
3. Strategy processes changes (rebases pending for OT), returns Change[]
4. Worker broadcasts { type: 'changes', changes } to all tabs
5. All tabs call doc.applyChanges(changes)
6. Everyone's in sync
```

### Tab Opens a Document

```
1. Tab D opens, requests doc "project-123"
2. Worker loads snapshot from store
3. Worker sends snapshot to Tab D
4. Tab D creates OTDoc with snapshot
5. Tab D starts receiving broadcasts like everyone else
```

## Gotchas and Edge Cases

### Don't Apply Changes Locally First

This is the big one. When a tab makes a change, it should **not** optimistically apply it. Instead:

1. Tab emits ops to worker
2. Worker creates the change and broadcasts
3. Tab receives broadcast and applies

This keeps all tabs perfectly synchronized. If Tab A applied changes locally before the broadcast, it would be ahead of other tabs until they caught up.

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

Everything above applies to LWW too. Just swap `OTStrategy` for `LWWStrategy` and `OTDoc` for `LWWDoc`. The `handleDocChange` and `applyServerChanges` methods work identically.

### Cast to BaseDoc for Internal Methods

The `PatchesDoc` interface is app-facing and doesn't expose `applyChanges`, `import`, or `updateSyncing`. To call these from your tab client, cast to `BaseDoc`:

```typescript
import type { BaseDoc } from '@dabble/patches/client';

const baseDoc = doc as BaseDoc;
baseDoc.applyChanges(changes);
baseDoc.updateSyncing('synced');
baseDoc.import(snapshot);
```

This is intentional. Your app code uses `PatchesDoc`. Your infrastructure code (like the tab client) uses `BaseDoc`.

## What's Not Included

This guide shows you the architecture and how to use the API. You still need to build:

- The actual SharedWorker message passing (consider using something like Comlink)
- Request/response correlation for async operations
- Error handling and retry logic
- Worker health monitoring

The Patches API gives you the building blocks. The plumbing between worker and tabs is your domain.

Now go build something that doesn't open five WebSocket connections to do one job.

# `PatchesDoc<T>` - Your Document Interface

`PatchesDoc<T>` is the interface your app uses to interact with a single collaborative document. It tracks state, emits events when things change, and provides the `change()` method for making edits.

Here's the deal: You don't create these yourself. Let the main [`Patches`](Patches.md) client create them for you with `patches.openDoc()`.

**Table of Contents**

- [What It Does](#what-it-does)
- [Getting One](#getting-one)
- [The State Model](#the-state-model)
- [Making Changes](#making-changes)
- [Reading State and Status](#reading-state-and-status)
- [Events](#events)
- [OT vs LWW: Two Implementations](#ot-vs-lww-two-implementations)
- [Example Usage](#example-usage)

## What It Does

`PatchesDoc` has a focused job. It's your app's interface to a document - nothing more.

**It handles:**

- **State Management**: Tracks committed state plus pending local changes
- **Change Interface**: Provides `change()` for making edits
- **Status Tracking**: Reports pending changes and sync status
- **Event Emission**: Notifies your UI when things change

**It does NOT handle:**

- Operational Transformation (that's in the [algorithms](algorithms.md))
- Server communication (that's [`PatchesSync`](PatchesSync.md)'s job)
- Rebasing logic (also in algorithms)
- Storage (that's the store's job)

The separation is intentional. Pure algorithm functions handle the math. Stores handle persistence. `PatchesDoc` is just the interface your app touches.

## Getting One

Almost always, let `Patches` create documents for you:

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';

const patches = new Patches({ store: new InMemoryStore() });

// Open a document (creates it if it doesn't exist)
const doc = await patches.openDoc<MyDocType>('my-document-id');
```

If you need to create one directly (rare - usually only for testing):

```typescript
import { OTDoc } from '@dabble/patches/client';

const doc = new OTDoc<MyDocType>('my-document-id', {
  state: {
    /* initial state */
  },
  rev: 0,
  changes: [], // pending changes
});
```

For LWW documents:

```typescript
import { LWWDoc } from '@dabble/patches/client';

const doc = new LWWDoc<MyDocType>('my-document-id', {
  state: {
    /* initial state */
  },
  rev: 0,
  changes: [],
});
```

## The State Model

`PatchesDoc` manages a straightforward state model:

### Current State

What you get from `doc.state` - this includes all server-confirmed changes plus your local pending changes merged together. Your changes appear immediately (optimistic updates), so the UI feels responsive.

### Committed Revision

The `doc.committedRev` property tells you the last revision number confirmed by the server.

### Pending Changes

Local edits waiting for server confirmation. The `doc.hasPending` boolean tells you if there are any. The sync layer handles getting these to the server.

### Syncing Status

The `doc.syncing` property tells you the current sync state: `null` when idle, `'syncing'` when actively syncing, or an `Error` if something went wrong.

You don't need to manage this complexity directly. Make changes, check status, and let the system handle the rest.

## Making Changes

The `change()` method captures your edits as [JSON Patch](json-patch.md) operations:

```typescript
doc.change(draft => {
  draft.title = 'My Document';
  draft.count = (draft.count || 0) + 1;

  if (draft.items) {
    draft.items.push({ id: 'new-item', text: 'Hello world' });
  } else {
    draft.items = [{ id: 'new-item', text: 'Hello world' }];
  }
});
```

**Important**: The `change()` method emits JSON Patch ops via `onChange` - it does NOT apply them locally. The algorithm layer packages these ops into Change objects, persists them, and calls back to update the doc's state.

This design means:

1. Changes are captured as pure JSON Patch operations
2. The algorithm decides how to package and persist them (differently for OT vs LWW)
3. State updates happen through a consistent path

The sync layer ([`PatchesSync`](PatchesSync.md)) handles getting changes to the server and dealing with conflicts.

## Reading State and Status

### `id`

```typescript
const docId = doc.id; // The unique document identifier
```

### `state`

```typescript
const currentState = doc.state;
```

The live state with committed plus pending changes applied. Use this for rendering your UI.

### `committedRev`

```typescript
const serverRevision = doc.committedRev;
```

The revision number of the last server-confirmed state.

### `hasPending`

```typescript
if (doc.hasPending) {
  // Show "unsaved changes" indicator
}
```

### `syncing`

```typescript
if (doc.syncing === 'syncing') {
  // Currently syncing with server
} else if (doc.syncing instanceof Error) {
  // Sync error occurred
} else {
  // Idle - no sync in progress
}
```

## Events

### `onUpdate` - State Changes

Called whenever the document state changes, from any source (local changes, server updates, imports):

```typescript
doc.onUpdate(newState => {
  console.log('Document updated:', newState);
  renderUI(newState);
});
```

### `onChange` - Local Changes

Called when `change()` captures local edits. Emits the raw JSON Patch ops:

```typescript
doc.onChange(ops => {
  console.log('Local changes captured:', ops);
  // ops is an array of JSONPatchOp objects
});
```

### `onSyncing` - Sync Status Changes

Called when the sync status changes:

```typescript
doc.onSyncing(syncingState => {
  if (syncingState === 'syncing') {
    showSpinner();
  } else if (syncingState instanceof Error) {
    showError(syncingState.message);
  } else {
    hideSpinner();
  }
});
```

### `subscribe` - Immediate + Ongoing Updates

Like `onUpdate`, but calls immediately with the current state, then on every subsequent change. Returns an unsubscribe function:

```typescript
const unsub = doc.subscribe(state => {
  // Called immediately with current state
  // Then called on every subsequent update
  renderUI(state);
});

// Later, when done:
unsub();
```

This is particularly useful for reactive frameworks that need the current value right away.

## OT vs LWW: Two Implementations

`PatchesDoc<T>` is an interface with two implementations:

### OTDoc (Operational Transformation)

Used with the OT sync algorithm. Tracks a separate committed state and pending changes array. When server changes arrive, pending changes get rebased using the [OT algorithms](algorithms.md).

Best for: Collaborative editing where concurrent changes need intelligent merging.

### LWWDoc (Last-Write-Wins)

Used with the LWW sync algorithm. Simpler model - timestamps determine which value wins when there's a conflict.

Best for: Settings, preferences, status data where the latest write should simply win.

See [Operational Transformation](operational-transformation.md) and [Last-Write-Wins](last-write-wins.md) for the concepts, or [persist.md](persist.md) for guidance on which algorithm to use.

## Example Usage

Here's a complete example using `PatchesDoc` with React:

```typescript
import React, { useEffect, useState } from 'react';
import { Patches, InMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';
import type { PatchesDoc } from '@dabble/patches/client';

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

interface TodoDoc {
  items: TodoItem[];
}

function TodoApp() {
  const [doc, setDoc] = useState<PatchesDoc<TodoDoc> | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [newTodo, setNewTodo] = useState('');
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [syncError, setSyncError] = useState<Error | null>(null);

  useEffect(() => {
    const setup = async () => {
      const store = new InMemoryStore();
      const patches = new Patches({ store });

      const sync = new PatchesSync(patches, 'wss://your-server.example.com');
      await sync.connect();

      const todoDoc = await patches.openDoc<TodoDoc>('my-todos');

      // Initialize if empty
      if (!todoDoc.state.items) {
        todoDoc.change(draft => {
          draft.items = [];
        });
      }

      // Use subscribe for immediate + ongoing updates
      todoDoc.subscribe(state => {
        setTodos(state.items || []);
        setHasUnsaved(todoDoc.hasPending);
      });

      todoDoc.onSyncing(syncState => {
        setSyncError(syncState instanceof Error ? syncState : null);
        setHasUnsaved(todoDoc.hasPending);
      });

      setDoc(todoDoc);
    };

    setup();
  }, []);

  const addTodo = () => {
    if (!newTodo.trim() || !doc) return;

    doc.change(draft => {
      draft.items.push({
        id: `todo-${Date.now()}`,
        text: newTodo,
        done: false
      });
    });

    setNewTodo('');
  };

  const toggleTodo = (id: string) => {
    if (!doc) return;

    doc.change(draft => {
      const todo = draft.items.find(item => item.id === id);
      if (todo) {
        todo.done = !todo.done;
      }
    });
  };

  return (
    <div>
      <h1>Collaborative Todo List</h1>

      {syncError && (
        <div className="error">Sync error: {syncError.message}</div>
      )}
      {hasUnsaved && !syncError && (
        <div className="info">Unsaved changes</div>
      )}

      <div className="add-todo">
        <input
          value={newTodo}
          onChange={e => setNewTodo(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addTodo()}
          placeholder="Add a new todo"
        />
        <button onClick={addTodo}>Add</button>
      </div>

      <ul className="todo-list">
        {todos.map(todo => (
          <li
            key={todo.id}
            className={todo.done ? 'done' : ''}
            onClick={() => toggleTodo(todo.id)}
          >
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

The `PatchesDoc` handles local state and change capture. [`PatchesSync`](PatchesSync.md) handles server communication. The [algorithm functions](algorithms.md) handle conflict resolution. Clean separation - each piece does one thing well.

## Related Documentation

- [Patches](Patches.md) - The main client that creates and manages documents
- [PatchesSync](PatchesSync.md) - Sync coordination with the server
- [algorithms](algorithms.md) - Pure functions for OT and change processing
- [json-patch](json-patch.md) - The JSON Patch format used for changes
- [persist](persist.md) - Storage options and OT vs LWW guidance

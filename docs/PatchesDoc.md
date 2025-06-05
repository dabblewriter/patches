# `PatchesDoc<T>`

Say hello to your document's friendly neighborhood manager! 🌟

`PatchesDoc<T>` is your direct interface to a single collaborative document. Think of it as your document's personal assistant - it handles your local changes, keeps track of what's happening, and provides a clean API for your app to work with.

**Here's the deal:** Don't create these yourself! Let the main `Patches` client create them for you with `patches.openDoc()`.

**Table of Contents**

- [What's Its Job?](#whats-its-job)
- [Getting Your Hands on One](#getting-your-hands-on-one)
- [State Management Made Simple](#state-management-made-simple)
- [Making Changes](#making-changes)
- [Accessing State and Status](#accessing-state-and-status)
- [Event Hooks](#event-hooks)
- [Example Usage](#example-usage)

## What's Its Job?

After the big refactor, `PatchesDoc` has a much cleaner, focused role. It's your app's interface to a document. No more juggling complex sync logic - that's handled elsewhere now!

Here's what it actually does:

- **State Management:** Keeps track of your document's current state (committed + pending changes)
- **Change Interface:** Provides the `change()` method for making edits
- **Status Tracking:** Tells you if there are pending changes, syncing status, etc.
- **Event Emission:** Lets you know when things change so your UI can update

Here's what it does NOT do anymore:
- ❌ Operational Transformation (that's in the algorithms now)
- ❌ Server communication (that's PatchesSync's job)
- ❌ Complex rebasing logic (also in algorithms)

## Getting Your Hands on One

Remember, you almost never create a `PatchesDoc` directly. Let `Patches` do it for you:

```typescript
import { Patches, InMemoryStore } from '@dabble/patches';

// Create the main Patches client
const patches = new Patches({ store: new InMemoryStore() });

// Get a PatchesDoc instance
const doc = await patches.openDoc<MyDocType>('my-document-id');
```

If you really need to create one directly (rare!):

```typescript
import { PatchesDoc } from '@dabble/patches/client';

const doc = new PatchesDoc<MyDocType>({
  /* initial state */
}, {
  /* initial metadata */
}, {
  maxPayloadBytes: 1024 * 1024 // 1MB max per change
});
```

## State Management Made Simple

`PatchesDoc` manages a simple but powerful state model:

### Current State
What you see via `doc.state` - this includes all confirmed server changes PLUS your local pending changes. This makes your app feel super responsive since you see your changes immediately.

### Pending Changes
Your local edits that haven't been confirmed by the server yet. These live in the document's internal snapshot and get handled by the sync layer.

### Metadata
Information about the document's revision, sync status, and change metadata.

The beauty is that you don't need to think about the complexity. Just make changes and check the status!

## Making Changes

Changing your document is dead simple:

```typescript
// Make a change to your document
doc.change(draft => {
  draft.title = 'My Amazing Document';
  draft.count = (draft.count || 0) + 1;

  // You can do whatever you want to the draft object
  if (draft.items) {
    draft.items.push({ id: 'new-item', text: 'Hello world' });
  } else {
    draft.items = [{ id: 'new-item', text: 'Hello world' }];
  }
});
```

The `change` method:

1. Takes your changes and applies them to a draft object
2. Uses the `makeChange` algorithm to create proper change objects
3. Updates the local state immediately (optimistic update)
4. Adds the changes to the pending queue
5. Emits events so your UI can update

The sync layer (PatchesSync) will handle getting these changes to the server and dealing with any conflicts.

## Accessing State and Status

There are several ways to access your document's state and metadata:

### `state` Getter

```typescript
const currentState = doc.state;
```

This gives you the current state (committed + pending changes). This is what you use for rendering your UI.

### `committedRev` Getter

```typescript
const serverRevision = doc.committedRev;
```

Get the current server revision number.

### Status Getters

```typescript
if (doc.hasPending) {
  // Show an "unsaved changes" indicator
}

if (doc.syncing) {
  // Show sync status - could be an error or "syncing" state
}
```

### Import/Export for Persistence

```typescript
// Get the full document snapshot
const snapshot = doc.export();

// Import a document snapshot (e.g., when loading from storage)
doc.import({
  state: { /* ... */ },
  rev: 42,
  changes: [ /* pending changes */ ]
});
```

## Event Hooks

Listen to document events to update your UI:

```typescript
// Called whenever the document state changes (from any source)
doc.onUpdate(newState => {
  console.log('Document updated:', newState);
  updateUI(newState);
});

// Called when a local change is made
doc.onChange(changes => {
  console.log('Local changes made:', changes);
});

// Called before applying a local change (can be used for validation)
doc.onBeforeChange(change => {
  console.log('About to apply change:', change);
});

// Called when syncing state changes
doc.onSyncing(syncingState => {
  if (syncingState) {
    console.log('Syncing or sync error:', syncingState);
  } else {
    console.log('Sync completed successfully');
  }
});
```

## Example Usage

Here's a full example of using `PatchesDoc` with a React component:

```typescript
import React, { useEffect, useState } from 'react';
import { Patches, InMemoryStore } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';

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

  // Set up Patches on component mount
  useEffect(() => {
    const setup = async () => {
      const store = new InMemoryStore();
      const patches = new Patches({ store });

      // Connect to server (PatchesSync handles all the sync logic)
      const sync = new PatchesSync(patches, 'wss://your-server.example.com');
      await sync.connect();

      // Open the todos document
      const todoDoc = await patches.openDoc<TodoDoc>('my-todos');

      // Initialize if empty
      if (!todoDoc.state.items) {
        todoDoc.change(draft => {
          draft.items = [];
        });
      }

      // Listen for state updates
      todoDoc.onUpdate(newState => {
        setTodos(newState.items || []);
      });

      // Track pending changes
      todoDoc.onChange(() => {
        setHasUnsaved(todoDoc.hasPending);
      });

      // Track sync errors
      todoDoc.onSyncing(syncingState => {
        setSyncError(syncingState instanceof Error ? syncingState : null);
        setHasUnsaved(todoDoc.hasPending);
      });

      setDoc(todoDoc);
    };

    setup();
  }, []);

  // Add a new todo
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

  // Toggle a todo's completion status
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
      
      {/* Status indicators */}
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

That's it! Your todo list now has real-time collaboration. The `PatchesDoc` handles your local state and changes, while `PatchesSync` (behind the scenes) makes sure everything stays in sync with other users. Clean separation of concerns! ✨
# `PatchesDoc<T>`

Say hello to the star of the show! 🌟

`PatchesDoc<T>` is your direct interface to a single collaborative document. It's where all the client-side magic happens - making changes, handling updates from the server, and keeping your UI in sync with everyone else's edits.

**Here's a hot tip:** Don't create these yourself! Let the main `Patches` client create them for you with `patches.openDoc()`.

**Table of Contents**

- [Overview](#overview)
- [Initialization](#initialization)
- [State Management](#state-management)
- [Making Local Changes](#making-local-changes)
- [Synchronization with Server](#synchronization-with-server)
- [Accessing State and Metadata](#accessing-state-and-metadata)
- [Event Hooks](#event-hooks)
- [Example Usage](#example-usage)

## Overview

`PatchesDoc` is your document's local representation. Think of it as your personal view into a shared world. It does some seriously clever stuff:

- **Optimistic Updates:** Apply your changes locally right away for super-responsive UI
- **Change Tracking:** Keep track of what's pending, what's sending, and what's confirmed
- **Operational Transformation:** Handle rebasing your local changes on top of server changes
- **Immutable State:** Give you a clean, consistent state object that won't be accidentally mutated

## Initialization

Remember, you almost never create a `PatchesDoc` directly. Let `Patches` do it for you:

```typescript
import { Patches } from '@dabble/patches';
import { InMemoryStore } from '@dabble/patches/persist';

// Create the main Patches client
const patches = new Patches({ store: new InMemoryStore() });

// Get a PatchesDoc instance
const doc = await patches.openDoc<MyDocType>('my-document-id');
```

If you really need to create one directly (rare!):

```typescript
import { PatchesDoc } from '@dabble/patches/client';

const doc = new PatchesDoc<MyDocType>({
  initialState: {
    /* initial state */
  },
  id: 'my-document-id', // Optional, can set later with setId()
});
```

## State Management

`PatchesDoc` is a state management genius. It juggles three different versions of your document state:

### Committed State

This is the last confirmed state from the server - the ground truth that everyone agrees on. It's stored in `doc._committedState` and has a revision number in `doc.committedRev`.

### Optimistic State

This is what you actually see and use via `doc.state`. It includes all confirmed changes PLUS your pending local changes. This makes your app feel super responsive since you see your changes immediately.

### Pending Changes

These are your local edits that haven't been confirmed by the server yet. They're in three possible states:

1. **Pending:** Changes waiting to be sent (`_pendingChanges`)
2. **Sending:** Changes currently being sent to the server (`_sendingChanges`)
3. **Confirmed:** Changes the server accepted (these become part of the committed state)

## Making Local Changes

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
2. Creates a new immutable state with those changes applied
3. Generates a change record to send to the server
4. Updates the local state immediately (optimistic update)
5. Adds the change to the pending queue

You get instant feedback while changes sync in the background!

## Synchronization with Server

`PatchesDoc` has three key methods for syncing with the server:

### `getUpdatesForServer()`

```typescript
const changesToSend = doc.getUpdatesForServer();
```

This moves pending changes to "sending" status and returns them so they can be sent to the server. Usually, your sync provider calls this for you.

### `applyServerConfirmation()`

```typescript
doc.applyServerConfirmation(serverCommittedChanges);
```

When the server confirms changes, this method:

1. Updates the committed state and revision number
2. Clears the corresponding sending changes
3. Triggers update events for your UI

### `applyExternalServerUpdate()`

```typescript
doc.applyExternalServerUpdate(changesFromOtherClients);
```

When other clients make changes, this method:

1. Updates the committed state with their changes
2. Rebases any pending local changes on top using OT
3. Updates the optimistic state
4. Triggers update events for your UI

## Accessing State and Metadata

There are several ways to access your document's state and metadata:

### `state` Getter

```typescript
const currentState = doc.state;
```

This gives you the optimistic state (committed + pending changes). This is what you use for rendering your UI.

### `committedRev` Getter

```typescript
const serverRevision = doc.committedRev;
```

Get the current server revision number.

### Status Getters

```typescript
if (doc.isSending) {
  // Show a "saving..." indicator
}

if (doc.hasPending) {
  // Show an "unsaved changes" warning
}
```

### Import/Export

```typescript
// Get the full document state with all changes
const exportedDoc = doc.export();

// Import a document state (e.g., when initializing)
doc.import({
  state: {
    /* ... */
  },
  committedRev: 42,
  pendingChanges: [
    /* ... */
  ],
  sendingChanges: [
    /* ... */
  ],
});
```

## Event Hooks

Listen to document events to update your UI:

```typescript
// Called whenever the document state changes
doc.onUpdate((newState, oldState) => {
  console.log('Document updated:', newState);
  updateUI(newState);
});

// Called when a change is made locally
doc.onChange(change => {
  console.log('Local change made:', change);
});

// Called before applying a change (can be used for validation)
doc.onBeforeChange((draftState, callback) => {
  if (!isValid(draftState)) {
    callback(new Error('Invalid change!'));
    return;
  }
  callback(null);
});

// Called when the server confirms changes
doc.onCommit(committedChanges => {
  console.log('Changes committed by server:', committedChanges);
});
```

## Example Usage

Here's a full example of using `PatchesDoc` with a React component:

```typescript
import React, { useEffect, useState } from 'react';
import { Patches } from '@dabble/patches';
import { InMemoryStore } from '@dabble/patches/persist';
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
  const [doc, setDoc] = useState(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [newTodo, setNewTodo] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Set up Patches on component mount
  useEffect(() => {
    const setup = async () => {
      const store = new InMemoryStore();
      const patches = new Patches({ store });

      // Connect to server
      const sync = new PatchesSync('wss://your-server.example.com', patches);
      await sync.connect();

      // Open the todos document
      const todoDoc = await patches.openDoc<TodoDoc>('my-todos');

      // Initialize if empty
      if (!todoDoc.state.items) {
        todoDoc.change(draft => {
          draft.items = [];
        });
      }

      // Listen for updates
      todoDoc.onUpdate(newState => {
        setTodos(newState.items || []);
      });

      // Track saving status
      setInterval(() => {
        setIsSaving(todoDoc.isSending || todoDoc.hasPending);
      }, 100);

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
      {isSaving && <div className="saving-indicator">Saving...</div>}

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

That's it! Your todo list now has real-time collaboration. Multiple people can add and complete todos together, and everything stays in sync automagically. ✨

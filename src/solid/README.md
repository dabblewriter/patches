## Patches Solid.js Integration

Reactive primitives for building real-time collaborative applications with Solid.js and Patches.

## Installation

```bash
npm install @dabble/patches solid-js
```

Solid.js is a peer dependency. Install it separately if you haven't already.

## Quick Start

### 1. Setup at App Level

Wrap your app with `PatchesProvider`:

```tsx
import { render } from 'solid-js/web';
import { Patches, InMemoryStore } from '@dabble/patches/client';
import { PatchesSync } from '@dabble/patches/net';
import { PatchesProvider } from '@dabble/patches/solid';
import App from './App';

const patches = new Patches({ store: new InMemoryStore() });
const sync = new PatchesSync(patches, 'wss://your-server.com');

await sync.connect();

render(
  () => (
    <PatchesProvider patches={patches} sync={sync}>
      <App />
    </PatchesProvider>
  ),
  document.getElementById('app')!
);
```

### 2. Use in Components

```tsx
import { Show } from 'solid-js';
import { usePatchesDoc } from '@dabble/patches/solid';

interface DocType {
  title?: string;
}

function DocumentViewer(props: { documentId: string }) {
  // Auto-opens on mount, closes on cleanup (ref-counted)
  const { data, loading, error, change } = usePatchesDoc<DocType>(() => props.documentId);

  return (
    <Show when={!loading()} fallback={<div>Loading...</div>}>
      <Show when={!error()} fallback={<div>Error: {error()!.message}</div>}>
        <h1>{data()?.title}</h1>
        <button onClick={() => change((patch, root) => patch.replace(root.title!, 'New Title'))}>
          Update
        </button>
      </Show>
    </Show>
  );
}
```

### 3. Reactive Document Switching

Pass an accessor that returns `null` to unload, or a new path to swap:

```tsx
import { createSignal } from 'solid-js';
import { usePatchesDoc } from '@dabble/patches/solid';

const [projectId, setProjectId] = createSignal<string | null>('abc');

// Automatically opens/closes as the ID changes
const { data, change } = usePatchesDoc<Project>(
  () => projectId() && `projects/${projectId()}/content`
);

// Swap docs
setProjectId('def');

// Unload
setProjectId(null);
```

## API Reference

### `usePatchesDoc<T>(docId, options?)`

Creates reactive bindings for a Patches document. Auto-opens the document and closes it on cleanup or when the accessor value changes.

**Parameters:**

- `docId`: `MaybeAccessor<string | null | undefined | false>` — static string or accessor. Falsy values mean no doc loaded.
- `options?`:
  - `untrack?: boolean` — when true, removes the document from sync tracking on close
  - `algorithm?: string` — algorithm override
  - `metadata?: object` — metadata for the open call

**Returns:**

```typescript
{
  data: Accessor<T | undefined>      // Current document state
  loading: Accessor<boolean>          // Loading status
  error: Accessor<Error | undefined>  // Sync error if any
  rev: Accessor<number>               // Committed revision number
  hasPending: Accessor<boolean>       // Has pending local changes
  change: (mutator) => void           // Make changes (no-ops if doc not loaded)
  close: () => Promise<void>          // Explicitly close and reset
  doc: Accessor<PatchesDoc<T>>        // Raw PatchesDoc instance
}
```

### `usePatchesSync()`

Gets reactive sync state. Throws if PatchesSync wasn't provided to context.

```tsx
const { connected, syncing, online } = usePatchesSync();
```

### `createPatchesDoc<T>(name)`

Creates a named document context with a Provider component and a `useDoc` hook.

```tsx
const { Provider, useDoc } = createPatchesDoc<User>('user');

// Static
<Provider docId="user-123">
  <UserProfile />
</Provider>

// Reactive
const [activeId, setActiveId] = createSignal('design-1');
<Provider docId={activeId}>
  <WhiteboardCanvas />
</Provider>

// Child component
function UserProfile() {
  const { data, change } = useDoc();
  return <div>{data()?.name}</div>;
}
```

**Provider props:**

- `docId`: `MaybeAccessor<string>` — document ID (static or accessor)
- `untrack?: boolean` — remove from sync tracking on close
- `algorithm?`, `metadata?` — passed through to openDoc

### `createManagedDocs<TDoc, TData>(pathsAccessor, initialData, reducer, options?)`

Reactively manages multiple documents based on a reactive list of paths.

```tsx
const [paths] = createSignal(['projects/a', 'projects/b']);

const { data, close } = createManagedDocs<ProjectMeta, Record<string, ProjectMeta>>(
  paths,
  {},
  (data, path, state) => {
    const id = path.split('/').pop()!;
    data = { ...data };
    state ? (data[id] = state) : delete data[id];
    return data;
  },
);
```

### `fillPath(template, params)`

Resolves `:param` placeholders in a path template.

```typescript
fillPath('projects/:projectId/content', { projectId: 'abc' });
// => 'projects/abc/content'
```

## Patterns

### Multiple Components, Same Document

Reference counting handles this automatically:

```tsx
// Both components share the same doc — stays open until both clean up
function ComponentA() {
  const { data } = usePatchesDoc('doc-1');
  return <div>{data()?.title}</div>;
}

function ComponentB() {
  const { data, change } = usePatchesDoc('doc-1');
  return <button onClick={() => change(/* ... */)}>Edit</button>;
}
```

### `untrack` Option

By default, documents stay in the sync tracking list after closing (so they can be re-synced later). Pass `untrack: true` to fully remove them:

```tsx
// Closes on cleanup, doc stays tracked for future re-sync
usePatchesDoc(() => props.docId);

// Closes AND untracks on cleanup
usePatchesDoc(() => props.docId, { untrack: true });
```

### Optimistic Updates

Changes apply locally immediately, then sync to server:

```tsx
const { data, change, hasPending } = usePatchesDoc<MyType>('doc-1');

change((patch, root) => {
  patch.replace(root.status!, 'completed');
});
// data() is updated immediately
// hasPending() === true until server confirms
```

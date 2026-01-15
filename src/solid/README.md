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
// index.tsx
import { render } from 'solid-js/web';
import { Patches, InMemoryStore } from '@dabble/patches/client';
import { PatchesSync } from '@dabble/patches/net';
import { PatchesProvider } from '@dabble/patches/solid';
import App from './App';

const patches = new Patches({ store: new InMemoryStore() });
const sync = new PatchesSync(patches, 'wss://your-server.com');

// Connect to server
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

#### Explicit Lifecycle (Recommended)

You control when documents open and close:

```tsx
import { onMount, onCleanup, Show } from 'solid-js';
import { usePatchesContext, usePatchesDoc } from '@dabble/patches/solid';

interface DocType {
  title?: string;
}

function DocumentEditor(props: { documentId: string }) {
  const { patches } = usePatchesContext();

  // Open document when component mounts
  onMount(() => patches.openDoc(props.documentId));

  // Close when component unmounts
  onCleanup(() => patches.closeDoc(props.documentId));

  // Get reactive document state
  // IMPORTANT: Use accessor for reactive prop, string for static ID
  const { data, loading, error, change } = usePatchesDoc<DocType>(
    () => props.documentId // Reactive: () => props.documentId
    // Static: 'doc-123'
  );

  function updateTitle(newTitle: string) {
    change((patch, root) => {
      patch.replace(root.title!, newTitle);
    });
  }

  return (
    <Show when={!loading()} fallback={<div>Loading...</div>}>
      <Show when={!error()} fallback={<div>Error: {error()!.message}</div>}>
        <div>
          <h1>{data()?.title}</h1>
          <button onClick={() => updateTitle('New Title')}>Update Title</button>
        </div>
      </Show>
    </Show>
  );
}
```

#### Auto Lifecycle (Convenience)

Let the primitive manage document lifecycle with reference counting:

```tsx
import { Show } from 'solid-js';
import { usePatchesDoc } from '@dabble/patches/solid';

interface DocType {
  title?: string;
}

function DocumentViewer(props: { documentId: string }) {
  // Automatically opens on mount, closes on cleanup (ref-counted)
  const { data, loading, error } = usePatchesDoc<DocType>(
    () => props.documentId, // Use () => props.x for reactive props
    { autoClose: true }
  );

  return (
    <Show when={!loading()} fallback={<div>Loading...</div>}>
      <Show when={!error()} fallback={<div>Error: {error()!.message}</div>}>
        <h1>{data()?.title}</h1>
      </Show>
    </Show>
  );
}
```

## Critical: Don't Destructure Props!

This is a Solid-specific gotcha. Props in Solid are reactive getters, and destructuring breaks reactivity.

```tsx
// ❌ WRONG - breaks reactivity
function MyComponent(props: { docId: string }) {
  const { docId } = props; // destructured!
  const doc = usePatchesDoc(() => docId); // won't react to prop changes
}

// ✅ RIGHT - keeps reactivity
function MyComponent(props: { docId: string }) {
  const doc = usePatchesDoc(() => props.docId); // access via props object
}
```

**Pass props as accessor functions** to primitives when they're reactive:

```tsx
usePatchesDoc(() => props.documentId); // ✅ Correct for reactive props
usePatchesDoc('static-doc-id'); // ✅ Correct for static IDs
usePatchesDoc(props.documentId); // ❌ Wrong - loses reactivity
```

If you need to use multiple props, use Solid's `splitProps`:

```tsx
import { splitProps } from 'solid-js';

function MyComponent(props: { docId: string; title: string }) {
  const [local] = splitProps(props, ['docId', 'title']);
  // Now you can safely use local.docId and local.title
  const doc = usePatchesDoc(() => local.docId);
}
```

## API Reference

### `PatchesProvider`

Provides Patches context to your Solid app. Wrap your app with this component.

**Props:**

- `patches`: Patches instance
- `sync?`: Optional PatchesSync instance for network synchronization
- `children`: Child components

### `usePatchesContext()`

Gets the injected Patches context. Throws if context hasn't been provided.

**Returns:**

```typescript
{
  patches: Patches
  sync?: PatchesSync
}
```

### `usePatchesDoc<T>(docId, options?)`

Creates reactive bindings for a Patches document.

**Parameters:**

- `docId`: Document ID - string or accessor function (e.g., `'doc-123'` or `() => props.docId`)
- `options?`:
  - `autoClose`: boolean (default: `false`) - If true, automatically opens/closes doc with ref counting

**Returns:**

```typescript
{
  data: Accessor<T | undefined>      // Current document state
  loading: Accessor<boolean>         // Loading/syncing status
  error: Accessor<Error | null>      // Sync error if any
  rev: Accessor<number>              // Committed revision number
  hasPending: Accessor<boolean>      // Has pending local changes
  change: (mutator) => void          // Make changes to document
  doc: Accessor<PatchesDoc<T>>       // Raw PatchesDoc instance
}
```

**Remember:** All return values are **accessor functions** - call them to get the value:

```tsx
const { data, loading } = usePatchesDoc<MyType>(() => props.docId);

// ✅ Correct - call the accessor
const title = data()?.title;
const isLoading = loading();

// ❌ Wrong - accessing the function itself
const title = data.title; // undefined!
```

#### Making Changes

Use the `change` function with the JSON Patch mutator API:

```tsx
const { change } = usePatchesDoc<MyType>(() => props.docId);

change((patch, root) => {
  // Replace a value
  patch.replace(root.title!, 'New Title');

  // Add to array
  patch.add(root.items[0], { name: 'First Item' });

  // Remove from array
  patch.remove(root.items[2]);

  // Increment a number
  patch.increment(root.count!, 1);

  // Text operations (Delta)
  patch.text(root.content!, new Delta().retain(5).insert(' world'));
});
```

### `usePatchesSync()`

Gets reactive sync state. Throws if PatchesSync wasn't provided to context.

**Returns:**

```typescript
{
  connected: Accessor<boolean>; // WebSocket connected
  syncing: Accessor<boolean>; // Currently syncing documents
  online: Accessor<boolean>; // Client has network connectivity
}
```

**Usage:**

```tsx
import { Show } from 'solid-js';
import { usePatchesSync } from '@dabble/patches/solid';

function SyncIndicator() {
  const { connected, syncing } = usePatchesSync();

  return (
    <>
      <Show when={!connected()}>
        <div class="offline-banner">You are offline</div>
      </Show>
      <Show when={syncing()}>
        <div class="syncing-indicator">Syncing...</div>
      </Show>
    </>
  );
}
```

### `createPatchesDoc<T>(name)`

Creates a named document context for sharing documents across components without prop drilling.

**Parameters:**

- `name`: Unique identifier for this document context (e.g., 'whiteboard', 'user')

**Returns:**

```typescript
{
  Provider: Component; // Provider component
  useDoc: () => UsePatchesDocReturn<T>; // Hook to access the doc
}
```

**Usage:**

```tsx
// Create the context (typically in a shared file)
const { Provider: WhiteboardProvider, useDoc: useWhiteboard } = createPatchesDoc<WhiteboardDoc>('whiteboard');

// Parent component: provide the document
function WhiteboardPage() {
  const [boardId] = createSignal('board-123');

  return (
    <WhiteboardProvider docId={boardId} autoClose>
      <Canvas />
      <Toolbar />
    </WhiteboardProvider>
  );
}

// Child components: consume without prop drilling
function Canvas() {
  const { data, change } = useWhiteboard();
  // Use data() and change...
}

function Toolbar() {
  const { data } = useWhiteboard();
  // Use data()...
}
```

The Provider accepts the same options as `usePatchesDoc`:

```tsx
<Provider
  docId="static-doc-id" // or () => someSignal() for reactive
  autoClose={true} // optional
>
  {children}
</Provider>
```

## Important: Universal Reference Counting

All uses of `usePatchesDoc` participate in reference counting, regardless of the `autoClose` setting. This prevents premature doc closes when mixing modes.

### The Problem (Without Unified Ref Counting)

```tsx
// Component A - explicit mode
const { data: dataA } = usePatchesDoc('doc-1');

// Component B - auto mode
const { data: dataB } = usePatchesDoc('doc-1', { autoClose: true });

// ❌ Component B unmounts → autoClose closes doc → Component A breaks!
```

### The Solution

Both modes increment/decrement the ref count:

- **Auto mode**: Opens doc when ref count goes 0→1, closes when 1→0
- **Explicit mode**: Only tracks usage (increments/decrements), never opens/closes

The document stays open as long as ANY component is using it.

## Patterns

### Multiple Components, Same Document

With `autoClose: false` (explicit mode), you control when docs close:

```tsx
// Parent: manages lifecycle
function Parent() {
  const { patches } = usePatchesContext();

  onMount(() => patches.openDoc('doc-1'));
  onCleanup(() => patches.closeDoc('doc-1'));

  return (
    <>
      <ChildA />
      <ChildB />
    </>
  );
}

// Children: just consume
function ChildA() {
  const { data } = usePatchesDoc(() => 'doc-1');
  return <div>{data()?.title}</div>;
}
```

With `autoClose: true` (auto mode), reference counting handles it:

```tsx
// Component A
function ComponentA() {
  const { data } = usePatchesDoc(() => 'doc-1', { autoClose: true });
  return <div>{data()?.title}</div>;
}

// Component B (same doc)
function ComponentB() {
  const { data } = usePatchesDoc(() => 'doc-1', { autoClose: true });
  return <div>{data()?.content}</div>;
}

// Doc stays open until both unmount
```

### Global Loading/Error States

Combine doc-level and sync-level states:

```tsx
import { createMemo } from 'solid-js';
import { usePatchesDoc, usePatchesSync } from '@dabble/patches/solid';

function MyComponent(props) {
  const { data, loading: docLoading } = usePatchesDoc(() => props.docId);
  const { syncing } = usePatchesSync();

  const showSpinner = createMemo(() => docLoading() || syncing());

  return <Show when={!showSpinner()}>...</Show>;
}
```

### Optimistic Updates

Changes apply locally immediately, then sync to server:

```tsx
const { data, change, hasPending } = usePatchesDoc<MyType>(() => 'doc-1');

// Change is visible immediately in data()
change((patch, root) => {
  patch.replace(root.status!, 'completed');
});

// hasPending() === true until server confirms
```

### Reactive Document Switching

Use a signal to switch between documents:

```tsx
function DocumentTabs() {
  const [activeDocId, setActiveDocId] = createSignal('doc-1');

  // Switches documents reactively
  const { data, loading } = usePatchesDoc(activeDocId, { autoClose: true });

  return (
    <div>
      <button onClick={() => setActiveDocId('doc-1')}>Doc 1</button>
      <button onClick={() => setActiveDocId('doc-2')}>Doc 2</button>

      <Show when={!loading()}>
        <div>{data()?.title}</div>
      </Show>
    </div>
  );
}
```

## Solid-Specific Tips

### Components Run Once

Unlike React, Solid components only run once. Reactivity happens through signals and effects:

```tsx
// ❌ This won't update when data changes
function MyComponent(props) {
  const { data } = usePatchesDoc(() => props.docId);
  console.log('Title:', data()?.title); // Only logs on mount
  return <div>{data()?.title}</div>;
}

// ✅ Use createEffect to track changes
function MyComponent(props) {
  const { data } = usePatchesDoc(() => props.docId);

  createEffect(() => {
    console.log('Title changed:', data()?.title); // Logs on every change
  });

  return <div>{data()?.title}</div>;
}
```

### Synchronous Reactivity

Solid's reactivity is synchronous - updates happen immediately:

```tsx
const { data, change } = usePatchesDoc<MyType>(() => 'doc-1');

change((patch, root) => {
  patch.replace(root.count!, 42);
});

console.log(data()?.count); // 42 - updated synchronously!
```

No need for `nextTick()` or `await` like in Vue.

### Use `<For>` for Lists

Solid's `<For>` component is optimized for reactive lists:

```tsx
import { For } from 'solid-js';

function TodoList() {
  const { data } = usePatchesDoc<{ items?: Item[] }>(() => 'todos');

  return <For each={data()?.items}>{item => <div>{item.name}</div>}</For>;
}
```

## Advanced: DocManager

Access the reference counting manager directly for advanced use cases:

```tsx
import { getDocManager } from '@dabble/patches/solid';

const { patches } = usePatchesContext();
const manager = getDocManager(patches);

// Check ref count
const refCount = manager.getRefCount('doc-1');

// Manual ref counting
manager.incrementRefCount('doc-1');
manager.decrementRefCount('doc-1');
```

Normally you won't need this - the primitives handle it automatically.

## Troubleshooting

**"Cannot make changes: document not loaded yet"**

- In auto mode, the doc loads asynchronously. Wait for `loading()` to be false.
- In explicit mode, ensure you've called `patches.openDoc()` before using the doc.

**Props not updating reactively**

- Don't destructure props - use `props.propName` directly
- Pass props to primitives as accessor functions: `() => props.docId`

**"usePatchesContext must be called within a PatchesProvider"**

- Wrap your app with `<PatchesProvider>` at the root level

**Document closing unexpectedly**

- Check that all components using the doc participate in ref counting
- Both explicit and auto modes track usage to prevent premature closes

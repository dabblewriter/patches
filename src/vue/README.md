# Patches Vue Integration

Vue 3 Composition API utilities for building reactive, real-time collaborative applications with Patches.

## Installation

```bash
npm install @dabble/patches vue
```

Vue is a peer dependency, so you need to install it separately.

## Quick Start

### 1. Setup at App Level

Provide the Patches and PatchesSync instances to your Vue app:

```typescript
// main.ts
import { createApp } from 'vue';
import { Patches, InMemoryStore } from '@dabble/patches/client';
import { PatchesSync } from '@dabble/patches/net';
import { providePatchesContext } from '@dabble/patches/vue';
import App from './App.vue';

const patches = new Patches({ store: new InMemoryStore() });
const sync = new PatchesSync(patches, 'wss://your-server.com');

const app = createApp(App);
providePatchesContext(app, patches, sync);

// Connect to server
await sync.connect();

app.mount('#app');
```

### 2. Use in Components

#### Explicit Lifecycle (Recommended)

You control when documents open and close:

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { usePatchesContext, usePatchesDoc } from '@dabble/patches/vue';

const props = defineProps<{ documentId: string }>();
const { patches } = usePatchesContext();

// Open document when component mounts
onMounted(() => patches.openDoc(props.documentId));

// Close when component unmounts
onBeforeUnmount(() => patches.closeDoc(props.documentId));

// Get reactive document state
const { data, loading, error, change } = usePatchesDoc<{ title?: string }>(props.documentId);

function updateTitle(newTitle: string) {
  change((patch, root) => {
    patch.replace(root.title!, newTitle);
  });
}
</script>

<template>
  <div v-if="loading">Loading...</div>
  <div v-else-if="error">Error: {{ error.message }}</div>
  <div v-else>
    <h1>{{ data?.title }}</h1>
    <button @click="updateTitle('New Title')">Update Title</button>
  </div>
</template>
```

#### Auto Lifecycle (Convenience)

Let the composable manage document lifecycle with reference counting:

```vue
<script setup lang="ts">
import { usePatchesDoc } from '@dabble/patches/vue';

const props = defineProps<{ documentId: string }>();

// Automatically opens on mount, closes on unmount (ref-counted)
const { data, loading, error, change } = usePatchesDoc<{ title?: string }>(props.documentId, { autoClose: true });
</script>

<template>
  <div v-if="loading">Loading...</div>
  <div v-else-if="error">Error: {{ error.message }}</div>
  <div v-else>
    <h1>{{ data?.title }}</h1>
  </div>
</template>
```

## API Reference

### `providePatchesContext(app, patches, sync?)`

Provides Patches context to your Vue app. Call this once at app initialization.

**Parameters:**

- `app`: Vue App instance
- `patches`: Patches instance
- `sync?`: Optional PatchesSync instance for network synchronization

### `usePatchesContext()`

Gets the injected Patches context. Throws if context hasn't been provided.

**Returns:**

```typescript
{
  patches: Patches
  sync?: PatchesSync
}
```

### `usePatchesDoc<T>(docId, options?)` — Eager Mode

Creates reactive bindings for a Patches document when you know the docId at call time.

**Parameters:**

- `docId`: Document ID string
- `options?`:
  - `autoClose`: `boolean | 'untrack'` (default: `false`)
    - `false`: Explicit mode. Assumes doc is already open. Throws if not.
    - `true`: Opens doc on mount with ref counting, closes on unmount. Doc stays tracked for background sync.
    - `'untrack'`: Opens doc on mount, closes AND untracks on unmount. Removes from background sync entirely.

**Returns:**

```typescript
{
  data: ShallowRef<T | undefined>  // Current document state
  loading: Ref<boolean>             // Loading/syncing status
  error: Ref<Error | null>          // Sync error if any
  rev: Ref<number>                  // Committed revision number
  hasPending: Ref<boolean>          // Has pending local changes
  change: (mutator) => void         // Make changes to document
  doc: Ref<PatchesDoc<T>>           // Raw PatchesDoc instance
}
```

### `usePatchesDoc<T>(options?)` — Lazy Mode

Returns a deferred handle for documents where the path isn't known at creation time. Ideal for Pinia stores where the user navigates between documents.

Does NOT use `onBeforeUnmount` — you manage lifecycle via `load()` and `close()`.

**Parameters:**

- `options?`:
  - `idProp?`: string — Injects `doc.id` into state under this key on every update

**Returns:** Everything from eager mode, plus:

```typescript
{
  path: Ref<string | null>; // Current document path (null = not loaded)
  load: (docPath: string) => Promise<void>; // Open a document (closes previous first)
  close: () => Promise<void>; // Close current document and reset state
  create: (docPath: string, initialState: T | JSONPatch) => Promise<void>; // One-shot create
}
```

**Key behaviors:**

- `data` starts as `undefined`, `loading` starts as `false`
- Calling `load()` again first closes the previous doc, then opens the new one
- `close()` calls `patches.closeDoc()` without untracking — tracking is managed separately
- `create()` opens a doc, applies initial state, closes it. Doesn't bind to the handle.
- `change()` silently no-ops if no doc is loaded

**Example:**

```typescript
// In a Pinia store
import { defineStore } from 'pinia';
import { usePatchesDoc, fillPath } from '@dabble/patches/vue';

export const useProjectStore = defineStore('project', () => {
  const { data: project, load, close, change, create } = usePatchesDoc<Project>({ idProp: 'id' });

  return {
    project,
    load: (projectId: string) => load(fillPath('projects/:projectId/content', { projectId })),
    close,
    change,
    create: (projectId: string, patch: JSONPatch) =>
      create(fillPath('projects/:projectId/content', { projectId }), patch),
  };
});
```

#### Making Changes

Use the `change` function with the JSON Patch mutator API:

```typescript
const { change } = usePatchesDoc<MyType>(docId);

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

### `useManagedDocs<TDoc, TData>(pathsRef, initialData, reducer, options?)`

Reactively manages multiple documents based on a reactive list of paths. Opens documents as paths appear, closes them as paths disappear, and aggregates all state through a reducer function.

Uses `inject()` and `watchEffect` internally, so it works in both components and Pinia stores.

**Parameters:**

- `pathsRef`: `Ref<string[] | null>` — Reactive list of document paths to manage
- `initialData`: `TData` — Initial aggregated data value
- `reducer`: `(data: TData, path: string, state: TDoc | null) => TData` — Called when a doc updates (`state`) or is removed (`null`)
- `options?`:
  - `idProp?`: string — Injects `doc.id` into each document's state

**Returns:**

```typescript
{
  data: ShallowRef<TData>  // Reactive aggregated data
  close: () => void         // Stop watching and close all docs
}
```

**Example:**

```typescript
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useManagedDocs } from '@dabble/patches/vue';

interface ProjectMeta {
  id?: string;
  title: string;
}
type ProjectMetas = Record<string, ProjectMeta>;

export const useProjectMetasStore = defineStore('projectMetas', () => {
  const projectPaths = computed(() => Object.keys(workspace?.projects || {}).map(id => `projects/${id}`));

  const { data: projectMetas, close } = useManagedDocs<ProjectMeta, ProjectMetas>(
    projectPaths,
    {} as ProjectMetas,
    (data, path, state) => {
      const id = path.split('/').pop()!;
      data = { ...data };
      state ? (data[id] = state) : delete data[id];
      return data;
    },
    { idProp: 'id' }
  );

  return { projectMetas, close };
});
```

### `fillPath(template, params)`

Resolves a path template by replacing `:param` placeholders with values. Not Vue-specific, but handy for building document paths.

```typescript
import { fillPath } from '@dabble/patches/vue';

fillPath('projects/:projectId/content', { projectId: 'abc' });
// => 'projects/abc/content'

fillPath('users/:userId/settings', { userId: '123' });
// => 'users/123/settings'
```

Throws if a parameter is missing from the params object.

### `usePatchesSync()`

Gets reactive sync state. Throws if PatchesSync wasn't provided to context.

**Returns:**

```typescript
{
  connected: Ref<boolean>; // WebSocket connected
  syncing: Ref<boolean>; // Currently syncing documents
  online: Ref<boolean>; // Client has network connectivity
}
```

**Usage:**

```vue
<script setup lang="ts">
import { usePatchesSync } from '@dabble/patches/vue';

const { connected, syncing, online } = usePatchesSync();
</script>

<template>
  <div v-if="!connected" class="offline-banner">You are offline</div>
  <div v-if="syncing" class="syncing-indicator">Syncing...</div>
</template>
```

## Important: Universal Reference Counting

**All usages of `usePatchesDoc` participate in reference counting**, regardless of the `autoClose` setting. This prevents a critical bug where mixing modes could cause premature doc closes.

### The Problem (Without Unified Ref Counting)

```typescript
// Component A - explicit mode
const { data: dataA } = usePatchesDoc('doc-1');

// Component B - auto mode
const { data: dataB } = usePatchesDoc('doc-1', { autoClose: true });

// ❌ Component B unmounts → autoClose closes doc → Component A breaks!
```

### The Solution

Both explicit and auto modes increment/decrement the ref count:

- **Auto mode**: Opens doc when ref count goes 0→1, closes when 1→0
- **Explicit mode**: Only tracks usage (increments/decrements), never opens/closes

This ensures the document stays open as long as ANY component is using it.

## Patterns

### Multiple Components, Same Document

With `autoClose: false` (explicit mode), you control when docs close. Multiple components can safely consume:

```vue
<!-- Parent: manages lifecycle -->
<script setup>
const { patches } = usePatchesContext();
onMounted(() => patches.openDoc('doc-1'));
onBeforeUnmount(() => patches.closeDoc('doc-1'));
</script>

<!-- Child: just consumes -->
<script setup>
const { data } = usePatchesDoc('doc-1');
</script>
```

With `autoClose: true` (auto mode), reference counting handles multiple components safely:

```vue
<!-- Component A -->
<script setup>
const { data } = usePatchesDoc('doc-1', { autoClose: true });
</script>

<!-- Component B (same doc) -->
<script setup>
const { data } = usePatchesDoc('doc-1', { autoClose: true });
</script>

<!-- Doc stays open until both unmount -->
```

### Global Loading/Error States

Combine doc-level and sync-level states:

```vue
<script setup>
import { computed } from 'vue';
import { usePatchesDoc, usePatchesSync } from '@dabble/patches/vue';

const { data, loading: docLoading } = usePatchesDoc('doc-1');
const { syncing } = usePatchesSync();

const showSpinner = computed(() => docLoading.value || syncing.value);
</script>
```

### Optimistic Updates

Changes apply locally immediately, then sync to server:

```typescript
const { data, change, hasPending } = usePatchesDoc<MyType>('doc-1');

// Change is visible immediately in data.value
change((patch, root) => {
  patch.replace(root.status!, 'completed');
});

// hasPending.value === true until server confirms
```

## Advanced: DocManager

For advanced use cases, you can access the reference counting manager directly:

```typescript
import { getDocManager } from '@dabble/patches/vue';

const manager = getDocManager(patches);

// Manual ref counting
await manager.openDoc(patches, 'doc-1'); // ref count: 1
await manager.openDoc(patches, 'doc-1'); // ref count: 2
await manager.closeDoc(patches, 'doc-1'); // ref count: 1
await manager.closeDoc(patches, 'doc-1'); // ref count: 0, actually closes

// Check ref count
const count = manager.getRefCount('doc-1');
```

## TypeScript

All composables are fully typed. Provide your document type for type-safe mutations:

```typescript
interface TodoDoc {
  title: string;
  items: Array<{ id: string; text: string; done: boolean }>;
}

const { data, change } = usePatchesDoc<TodoDoc>('todo-1');

// ✅ Type-safe
change((patch, root) => {
  patch.replace(root.title, 'My Todos');
  patch.add(root.items[0], { id: '1', text: 'Task 1', done: false });
});

// ❌ Type error
change((patch, root) => {
  patch.replace(root.invalidProp, 'value'); // Error: invalidProp doesn't exist
});
```

## Troubleshooting

### "Patches context not found"

Make sure you called `providePatchesContext()` at app initialization:

```typescript
const app = createApp(App);
providePatchesContext(app, patches, sync);
app.mount('#app');
```

### "Document X is not open"

In explicit mode (default), you must open the document first:

```typescript
// ✅ Correct
onMounted(() => patches.openDoc('doc-1'));
const { data } = usePatchesDoc('doc-1');

// ❌ Wrong
const { data } = usePatchesDoc('doc-1');
onMounted(() => patches.openDoc('doc-1'));
```

Or use auto mode:

```typescript
const { data } = usePatchesDoc('doc-1', { autoClose: true });
```

### Document closes while still in use

With universal ref counting (introduced in v1), this should no longer happen. All `usePatchesDoc` calls track usage, preventing premature closes even when mixing explicit and auto modes.

If you still experience this:

1. Verify all components using the same doc call `usePatchesDoc`
2. Check that components properly unmount (cleanup runs)
3. Consider using `autoClose: true` for simpler lifecycle management

### "onBeforeUnmount is called without current active component instance"

Eager mode (`usePatchesDoc(docId)`) uses `onBeforeUnmount` and must be called during component setup:

```typescript
// ✅ Correct - called during setup
const MyComponent = defineComponent({
  setup() {
    const { data } = usePatchesDoc('doc-1');
    return { data };
  },
});
```

**For Pinia stores**, use lazy mode instead — it doesn't rely on `onBeforeUnmount`:

```typescript
// ✅ Correct for Pinia stores
export const useMyStore = defineStore('my-store', () => {
  const { data, load, close } = usePatchesDoc<MyType>(); // lazy mode
  return { data, load, close };
});
```

If you need to use Patches outside components or stores, access the raw `Patches` instance directly:

```typescript
import { patches } from './my-patches-instance';

const doc = await patches.openDoc('doc-1');
doc.subscribe(state => console.log(state));
```

## Best Practices

1. **Use explicit mode for production** - More predictable, easier to debug
2. **Use autoClose for prototyping** - Faster development, less boilerplate
3. **Use `shallowRef` patterns** - Document state is immutable, shallow refs are efficient
4. **Batch changes** - Multiple operations in single `change()` call are batched
5. **Handle errors** - Always show error states to users
6. **Show loading states** - Documents may take time to sync initially

## Examples

### Todo List

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { usePatchesContext, usePatchesDoc } from '@dabble/patches/vue';

interface TodoDoc {
  title: string;
  items: Array<{ id: string; text: string; done: boolean }>;
}

const { patches } = usePatchesContext();
const docId = 'my-todos';

onMounted(() => patches.openDoc(docId));
onBeforeUnmount(() => patches.closeDoc(docId));

const { data, change } = usePatchesDoc<TodoDoc>(docId);

function addTodo(text: string) {
  const newTodo = {
    id: crypto.randomUUID(),
    text,
    done: false,
  };

  change((patch, root) => {
    const items = root.items!;
    patch.add(items[items.length], newTodo);
  });
}

function toggleTodo(index: number) {
  change((patch, root) => {
    const item = root.items![index];
    patch.replace(item.done, !item.done);
  });
}
</script>

<template>
  <div>
    <h1>{{ data?.title }}</h1>
    <ul>
      <li v-for="(item, i) in data?.items" :key="item.id">
        <input type="checkbox" :checked="item.done" @change="toggleTodo(i)" />
        {{ item.text }}
      </li>
    </ul>
  </div>
</template>
```

## Advanced Patterns

### Pinia Store with Lazy Mode (Recommended)

For Pinia stores where the document path depends on navigation or user state, use lazy mode. This is the cleanest pattern because:

- The store controls its own lifecycle via `load()` / `close()`
- No `onBeforeUnmount` (which doesn't work reliably in Pinia stores)
- `inject()` and `watchEffect` work correctly in Pinia stores via `effectScope`

```typescript
// stores/project.ts
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { usePatchesDoc, fillPath } from '@dabble/patches/vue';

interface Project {
  id?: string;
  title: string;
  description: string;
}

export const useProjectStore = defineStore('project', () => {
  const { data: project, load, close, change, create } = usePatchesDoc<Project>({ idProp: 'id' });

  const title = computed(() => project.value?.title ?? '');

  function setTitle(newTitle: string) {
    change((patch, root) => {
      patch.replace(root.title!, newTitle);
    });
  }

  return {
    project,
    title,
    load: (projectId: string) => load(fillPath('projects/:projectId/content', { projectId })),
    close,
    setTitle,
    create: (projectId: string, initialState: Project) =>
      create(fillPath('projects/:projectId/content', { projectId }), initialState),
  };
});
```

#### Managing Multiple Documents Reactively

When your store needs to track many documents that come and go (like project metadata for all projects in a workspace), use `useManagedDocs`:

```typescript
// stores/projectMetas.ts
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useManagedDocs } from '@dabble/patches/vue';

interface ProjectMeta {
  id?: string;
  title: string;
}

export const useProjectMetasStore = defineStore('projectMetas', () => {
  // This reactive list drives which docs are open
  const projectPaths = computed(() => Object.keys(workspace?.projects || {}).map(id => `projects/${id}`));

  const { data: metas, close } = useManagedDocs<ProjectMeta, Record<string, ProjectMeta>>(
    projectPaths,
    {},
    (data, path, state) => {
      const id = path.split('/').pop()!;
      data = { ...data };
      state ? (data[id] = state) : delete data[id];
      return data;
    },
    { idProp: 'id' }
  );

  return { metas, close };
});
```

### Pinia Store with Eager Mode

For stores where the document ID is known upfront and never changes, use eager mode with `autoClose`:

```typescript
// stores/user.ts
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { usePatchesDoc } from '@dabble/patches/vue';

interface UserSettings {
  theme: 'light' | 'dark';
  language: string;
}

export const useUserStore = defineStore('user', () => {
  const { data, loading, change } = usePatchesDoc<UserSettings>('user-settings', {
    autoClose: true,
  });

  const isDarkMode = computed(() => data.value?.theme === 'dark');

  function setTheme(theme: 'light' | 'dark') {
    change((patch, root) => {
      patch.replace(root.theme!, theme);
    });
  }

  return { data, loading, isDarkMode, setTheme };
});
```

### Document Context Provider

For workspace-scoped documents (like a whiteboard or document editor), use `providePatchesDoc` and `useCurrentDoc` to avoid prop drilling the docId through your component tree.

#### Static Document ID

For documents that never change (like user settings):

```vue
<!-- App.vue -->
<script setup lang="ts">
import { usePatchesContext, providePatchesDoc } from '@dabble/patches/vue';

const { patches } = usePatchesContext();

// Open the user settings document
await patches.openDoc('user-123');

// Provide it to all child components
providePatchesDoc('user', 'user-123');
</script>

<template>
  <RouterView />
</template>
```

```vue
<!-- Any child component -->
<script setup lang="ts">
import { useCurrentDoc } from '@dabble/patches/vue';

interface UserSettings {
  name: string;
  email: string;
}

const { data, change } = useCurrentDoc<UserSettings>('user');
</script>

<template>
  <div>Welcome, {{ data?.name }}</div>
</template>
```

#### Reactive Document ID (Multi-Tab Interface)

For apps with tabs where each tab represents a different document, and you want to keep all documents open for fast switching:

```vue
<!-- WorkspaceTabs.vue -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { usePatchesContext, providePatchesDoc } from '@dabble/patches/vue';

const { patches } = usePatchesContext();

// Track active tab's document ID
const activeTabId = ref('design-1');
const openTabs = ref(['design-1', 'design-2', 'design-3']);

// Open all tabs
openTabs.value.forEach(id => patches.openDoc(id));

// Provide the active document (autoClose: false keeps all docs open)
providePatchesDoc('whiteboard', activeTabId);

function switchTab(tabId: string) {
  activeTabId.value = tabId; // Document switches, all stay open
}

// Close documents when tabs are closed
function closeTab(tabId: string) {
  patches.closeDoc(tabId);
  openTabs.value = openTabs.value.filter(id => id !== tabId);
}
</script>

<template>
  <div class="tabs">
    <button v-for="tabId in openTabs" :key="tabId" @click="switchTab(tabId)" :class="{ active: activeTabId === tabId }">
      {{ tabId }}
      <span @click.stop="closeTab(tabId)">×</span>
    </button>
  </div>

  <!-- Child components access current whiteboard without props -->
  <WhiteboardCanvas />
  <WhiteboardToolbar />
  <WhiteboardSidebar />
</template>
```

```vue
<!-- WhiteboardCanvas.vue (child component) -->
<script setup lang="ts">
import { useCurrentDoc } from '@dabble/patches/vue';

interface WhiteboardDoc {
  shapes: Array<{ id: string; type: string; x: number; y: number }>;
}

// No need to pass docId through props!
const { data, loading, change } = useCurrentDoc<WhiteboardDoc>('whiteboard');

function addShape(shape: any) {
  change((patch, root) => {
    const shapes = root.shapes!;
    patch.add(shapes[shapes.length], shape);
  });
}
</script>

<template>
  <canvas v-if="!loading">
    <!-- Render shapes from data.shapes -->
  </canvas>
</template>
```

#### Single Document with Auto-Close

For apps where only one document is active at a time, and you want to close the old document when switching:

```vue
<!-- DocumentEditor.vue -->
<script setup lang="ts">
import { ref } from 'vue';
import { providePatchesDoc } from '@dabble/patches/vue';

const route = useRoute();
const currentDocId = ref(route.params.docId as string);

// With autoClose: true, old doc closes when currentDocId changes
providePatchesDoc('document', currentDocId, { autoClose: true });

// When route changes, update docId
watch(
  () => route.params.docId,
  newId => {
    currentDocId.value = newId as string;
  }
);
</script>

<template>
  <EditorToolbar />
  <EditorContent />
  <EditorSidebar />
</template>
```

#### Multiple Named Contexts

You can provide multiple documents with different names to avoid collisions:

```vue
<!-- Workspace.vue -->
<script setup lang="ts">
import { usePatchesContext, providePatchesDoc } from '@dabble/patches/vue';

const { patches } = usePatchesContext();

// Global user document (static)
await patches.openDoc('user-123');
providePatchesDoc('user', 'user-123');

// Workspace document (reactive)
const workspaceId = ref('workspace-1');
providePatchesDoc('workspace', workspaceId, { autoClose: true });
</script>
```

```vue
<!-- Any child component -->
<script setup lang="ts">
import { useCurrentDoc } from '@dabble/patches/vue';

// Access both documents by name
const { data: user } = useCurrentDoc<UserDoc>('user');
const { data: workspace } = useCurrentDoc<WorkspaceDoc>('workspace');
</script>
```

### Multi-Document Management

Use `useManagedDocs` to reactively open and close documents based on a reactive list of paths. See the [Pinia Store with Lazy Mode](#pinia-store-with-lazy-mode-recommended) section above for a full example.

## Learn More

- [Patches Documentation](../../README.md)
- [JSON Patch Operations](../../json-patch/README.md)
- [Vue 3 Composition API](https://vuejs.org/guide/extras/composition-api-faq.html)

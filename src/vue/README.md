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

await sync.connect();
app.mount('#app');
```

### 2. Use in Components

```vue
<script setup lang="ts">
import { usePatchesDoc } from '@dabble/patches/vue';

const props = defineProps<{ documentId: string }>();

// Auto-opens on mount, closes on unmount (ref-counted)
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

### 3. Reactive Document Switching

Pass a ref or getter to automatically swap documents:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { usePatchesDoc } from '@dabble/patches/vue';

const currentProjectId = ref<string | null>('abc');

// Automatically opens/closes as the ID changes. null = no doc loaded.
const { data, change } = usePatchesDoc<Project>(
  () => currentProjectId.value && `projects/${currentProjectId.value}/content`
);
</script>
```

## API Reference

### `providePatchesContext(app, patches, sync?)`

Provides Patches context to your Vue app. Call this once at app initialization.

### `usePatchesContext()`

Gets the injected Patches context. Throws if context hasn't been provided.

### `usePatchesDoc<T>(docId, options?)`

Creates reactive bindings for a Patches document. Auto-opens the document and closes it on unmount or when the path changes.

**Parameters:**

- `docId`: `string | MaybeRefOrGetter<string | null | undefined>` — static string, ref, or getter. `null`/`undefined` means no doc loaded.
- `options?`:
  - `untrack?: boolean` — when true, removes the document from sync tracking on close
  - `algorithm?: string` — algorithm override
  - `metadata?: object` — metadata for the open call

**Returns:**

```typescript
{
  data: ShallowRef<T | undefined>    // Current document state
  loading: Ref<boolean>               // Loading status
  error: Ref<Error | undefined>       // Sync error if any
  rev: Ref<number>                    // Committed revision number
  hasPending: Ref<boolean>            // Has pending local changes
  change: (mutator) => void           // Make changes (no-ops if doc not loaded)
  close: () => Promise<void>          // Explicitly close and reset
  doc: ShallowRef<PatchesDoc<T>>      // Raw PatchesDoc instance
}
```

### `providePatchesDoc<T>(name, docId, options?)`

Opens a document and provides it in the component tree. Child components access it via `useCurrentDoc(name)`.

```typescript
// Parent
providePatchesDoc('user', 'user-123');

// Reactive
const docId = ref('doc-1');
providePatchesDoc('document', docId);

// Child (anywhere in tree)
const { data, change } = useCurrentDoc<UserDoc>('user');
```

### `useCurrentDoc<T>(name)`

Injects a document provided by `providePatchesDoc`. Throws if not found.

### `useManagedDocs<TDoc, TData>(pathsRef, initialData, reducer, options?)`

Reactively manages multiple documents based on a reactive list of paths. Opens documents as paths appear, closes them as paths disappear, and aggregates all state through a reducer function.

```typescript
const projectPaths = computed(() => Object.keys(workspace?.projects || {}).map(id => `projects/${id}`));

const { data: metas, close } = useManagedDocs<ProjectMeta, Record<string, ProjectMeta>>(
  projectPaths,
  {},
  (data, path, state) => {
    const id = path.split('/').pop()!;
    data = { ...data };
    state ? (data[id] = state) : delete data[id];
    return data;
  }
);
```

### `usePatchesSync()`

Gets reactive sync state. Throws if PatchesSync wasn't provided to context.

```typescript
const { connected, syncing, online } = usePatchesSync();
```

### `fillPath(template, params)`

Resolves `:param` placeholders in a path template.

```typescript
fillPath('projects/:projectId/content', { projectId: 'abc' });
// => 'projects/abc/content'
```

## Patterns

### Multiple Components, Same Document

Reference counting handles this automatically. The document stays open until all components unmount:

```vue
<!-- Component A -->
<script setup>
const { data } = usePatchesDoc('doc-1');
</script>

<!-- Component B (same doc) -->
<script setup>
const { data } = usePatchesDoc('doc-1');
</script>

<!-- Doc stays open until both unmount -->
```

### Pinia Store

```typescript
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { usePatchesDoc, fillPath } from '@dabble/patches/vue';

export const useProjectStore = defineStore('project', () => {
  const projectId = ref<string | null>(null);

  const {
    data: project,
    change,
    close,
  } = usePatchesDoc<Project>(() => projectId.value && fillPath('projects/:id/content', { id: projectId.value }));

  const title = computed(() => project.value?.title ?? '');

  function setTitle(newTitle: string) {
    change((patch, root) => {
      patch.replace(root.title!, newTitle);
    });
  }

  return { project, title, projectId, setTitle, close };
});
```

### Optimistic Updates

Changes apply locally immediately, then sync to server:

```typescript
const { data, change, hasPending } = usePatchesDoc<MyType>('doc-1');

change((patch, root) => {
  patch.replace(root.status!, 'completed');
});
// data.value is updated immediately
// hasPending.value === true until server confirms
```

## Advanced: DocManager

For advanced use cases, access the reference counting manager directly:

```typescript
import { getDocManager } from '@dabble/patches/vue';

const manager = getDocManager(patches);
await manager.openDoc(patches, 'doc-1'); // ref count: 1
await manager.openDoc(patches, 'doc-1'); // ref count: 2
await manager.closeDoc(patches, 'doc-1'); // ref count: 1
await manager.closeDoc(patches, 'doc-1'); // ref count: 0, actually closes
```

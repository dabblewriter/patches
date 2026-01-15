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

### `usePatchesDoc<T>(docId, options?)`

Creates reactive bindings for a Patches document.

**Parameters:**

- `docId`: Document ID string
- `options?`:
  - `autoClose`: boolean (default: `false`) - If true, automatically opens/closes doc with ref counting

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

`usePatchesDoc` must be called during component setup:

```typescript
// ✅ Correct - called during setup
const MyComponent = defineComponent({
  setup() {
    const { data } = usePatchesDoc('doc-1');
    return { data };
  },
});

// ❌ Wrong - called outside component context
const { data } = usePatchesDoc('doc-1'); // Error!
const MyComponent = defineComponent({
  setup() {
    return { data };
  },
});
```

If you need to use Patches outside components, access the raw `Patches` instance directly:

```typescript
import { patches } from './my-patches-instance';

// Outside component - use raw API
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

### Pinia Store for Global Documents

For global documents like user settings or preferences, wrap a Patches document in a Pinia store to add domain-specific getters and actions.

**Option A: Explicit lifecycle** (more control)

```typescript
// stores/user.ts
import { defineStore } from 'pinia';
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { usePatchesContext, usePatchesDoc } from '@dabble/patches/vue';

interface UserSettings {
  theme: 'light' | 'dark';
  language: string;
  notifications: boolean;
}

export const useUserStore = defineStore('user', () => {
  const { patches } = usePatchesContext();
  const docId = 'user-settings';

  // Open document once when store is initialized
  onMounted(() => patches.openDoc(docId));
  onBeforeUnmount(() => patches.closeDoc(docId));

  // Get reactive document state
  const { data, loading, change } = usePatchesDoc<UserSettings>(docId);

  // Domain-specific getters
  const isDarkMode = computed(() => data.value?.theme === 'dark');
  const isNotificationsEnabled = computed(() => data.value?.notifications ?? true);

  // Domain-specific actions
  function setTheme(theme: 'light' | 'dark') {
    change((patch, root) => {
      patch.replace(root.theme!, theme);
    });
  }

  function toggleNotifications() {
    change((patch, root) => {
      patch.replace(root.notifications!, !root.notifications);
    });
  }

  function setLanguage(language: string) {
    change((patch, root) => {
      patch.replace(root.language!, language);
    });
  }

  return {
    data,
    loading,
    isDarkMode,
    isNotificationsEnabled,
    setTheme,
    toggleNotifications,
    setLanguage,
  };
});
```

**Option B: Auto lifecycle** (simpler)

```typescript
// stores/user.ts
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { usePatchesDoc } from '@dabble/patches/vue';

interface UserSettings {
  theme: 'light' | 'dark';
  language: string;
  notifications: boolean;
}

export const useUserStore = defineStore('user', () => {
  // Auto-manages lifecycle with ref counting
  const { data, loading, change } = usePatchesDoc<UserSettings>('user-settings', {
    autoClose: true,
  });

  // Domain-specific getters
  const isDarkMode = computed(() => data.value?.theme === 'dark');

  // Domain-specific actions
  function setTheme(theme: 'light' | 'dark') {
    change((patch, root) => {
      patch.replace(root.theme!, theme);
    });
  }

  return { data, loading, isDarkMode, setTheme };
});
```

**When to use each approach:**

- **Explicit mode**: When you want precise control over document lifecycle, or when the document should stay open even if no component is currently using the store
- **Auto mode**: Simpler and sufficient for most cases, document automatically closes when all components using the store unmount

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

For managing multiple related documents with `autoClose`, create a composable:

```typescript
// composables/useDocuments.ts
import { ref } from 'vue';
import { usePatchesContext, usePatchesDoc } from '@dabble/patches/vue';

export function useDocuments() {
  const { patches } = usePatchesContext();
  const openDocIds = ref<string[]>([]);

  function openDocument(docId: string) {
    if (!openDocIds.value.includes(docId)) {
      openDocIds.value.push(docId);
    }
  }

  function closeDocument(docId: string) {
    openDocIds.value = openDocIds.value.filter(id => id !== docId);
  }

  // Each document uses autoClose to manage lifecycle
  function useDocument<T extends object>(docId: string) {
    return usePatchesDoc<T>(docId, { autoClose: true });
  }

  return {
    openDocIds,
    openDocument,
    closeDocument,
    useDocument,
  };
}
```

## Learn More

- [Patches Documentation](../../README.md)
- [JSON Patch Operations](../../json-patch/README.md)
- [Vue 3 Composition API](https://vuejs.org/guide/extras/composition-api-faq.html)

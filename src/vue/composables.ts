import {
  ref,
  shallowRef,
  onBeforeUnmount,
  watch,
  unref,
  provide,
  inject,
  type Ref,
  type ShallowRef,
  type MaybeRef,
  type InjectionKey,
} from 'vue';
import type { PatchesDoc } from '../client/PatchesDoc.js';
import type { SyncingState, ChangeMutator } from '../types.js';
import type { PatchesSyncState } from '../net/PatchesSync.js';
import { usePatchesContext } from './provider.js';
import { getDocManager } from './doc-manager.js';

/**
 * Options for usePatchesDoc composable.
 */
export interface UsePatchesDocOptions {
  /**
   * Whether to automatically open/close the document based on component lifecycle.
   *
   * - `false` (default): Assumes doc is already open. Throws if not.
   * - `true`: Opens doc on mount with ref counting, closes on unmount.
   *
   * @default false
   */
  autoClose?: boolean;
}

/**
 * Return type for usePatchesDoc composable.
 */
export interface UsePatchesDocReturn<T extends object> {
  /**
   * Reactive reference to the document state.
   * Updated whenever the document changes (local or remote).
   */
  data: ShallowRef<T | undefined>;

  /**
   * Whether the document is currently loading/syncing.
   * - `true` during initial load or updates
   * - `false` when fully synced
   */
  loading: Ref<boolean>;

  /**
   * Error that occurred during sync, if any.
   */
  error: Ref<Error | null>;

  /**
   * The committed revision number.
   * Increments each time the server confirms changes.
   */
  rev: Ref<number>;

  /**
   * Whether there are pending local changes not yet committed by server.
   */
  hasPending: Ref<boolean>;

  /**
   * Make changes to the document.
   *
   * @example
   * ```typescript
   * change((patch, root) => {
   *   patch.replace(root.title!, 'New Title')
   * })
   * ```
   */
  change: (mutator: ChangeMutator<T>) => void;

  /**
   * The underlying PatchesDoc instance.
   * Useful for advanced operations.
   */
  doc: Ref<PatchesDoc<T> | undefined>;
}

/**
 * Vue composable for reactive Patches document state.
 *
 * Provides reactive access to a Patches document with automatic lifecycle management.
 *
 * ## Explicit Lifecycle (default)
 *
 * By default, assumes the document is already open and just adds Vue reactivity.
 * You control when documents are opened and closed.
 *
 * @example
 * ```typescript
 * // Component.vue
 * const props = defineProps(['docId'])
 * const { patches } = usePatchesContext()
 *
 * // You control lifecycle
 * onMounted(() => patches.openDoc(props.docId))
 * onBeforeUnmount(() => patches.closeDoc(props.docId))
 *
 * // Just adds reactivity
 * const { data, loading, change } = usePatchesDoc(props.docId)
 * ```
 *
 * ## Auto Lifecycle
 *
 * With `autoClose: true`, the composable manages the document lifecycle with
 * reference counting. Safe to use in multiple components with the same docId.
 *
 * @example
 * ```typescript
 * // Opens on mount, closes on unmount (ref-counted)
 * const { data, loading, change } = usePatchesDoc('doc-123', {
 *   autoClose: true
 * })
 * ```
 *
 * @param docId - Document ID to open
 * @param options - Configuration options
 * @returns Reactive document state and utilities
 * @throws Error if Patches context not provided
 * @throws Error if doc not open in explicit mode
 */
export function usePatchesDoc<T extends object>(
  docId: string,
  options: UsePatchesDocOptions = {}
): UsePatchesDocReturn<T> {
  const { patches } = usePatchesContext();
  const { autoClose = false } = options;

  const doc = ref<PatchesDoc<T> | undefined>(undefined) as Ref<PatchesDoc<T> | undefined>;
  const data = shallowRef<T | undefined>(undefined) as ShallowRef<T | undefined>;
  const loading = ref<boolean>(true);
  const error = ref<Error | null>(null);
  const rev = ref<number>(0);
  const hasPending = ref<boolean>(false);

  // Unsubscribe functions
  const unsubscribers: Array<() => void> = [];

  // ALWAYS use doc manager for universal ref counting
  const manager = getDocManager(patches);

  // Setup reactivity for a doc
  function setupDoc(patchesDoc: PatchesDoc<T>) {
    doc.value = patchesDoc;

    // Subscribe to state changes
    const unsubState = patchesDoc.subscribe(state => {
      data.value = state;
      rev.value = patchesDoc.committedRev;
      hasPending.value = patchesDoc.hasPending;
    });
    unsubscribers.push(unsubState);

    // Subscribe to sync state changes
    const unsubSync = patchesDoc.onSyncing((syncState: SyncingState) => {
      loading.value = syncState === 'initial' || syncState === 'updating';
      error.value = syncState instanceof Error ? syncState : null;
    });
    unsubscribers.push(unsubSync);

    // Set initial loading state
    loading.value = patchesDoc.syncing !== null;
  }

  // Initialize based on mode
  if (autoClose) {
    // Auto mode: manager opens and closes the doc
    manager
      .openDoc<T>(patches, docId)
      .then(patchesDoc => {
        setupDoc(patchesDoc);
      })
      .catch(err => {
        error.value = err;
        loading.value = false;
      });

    onBeforeUnmount(() => {
      unsubscribers.forEach(unsub => unsub());
      manager.closeDoc(patches, docId);
    });
  } else {
    // Explicit mode: just track ref count, don't open/close
    const patchesDoc = patches.getOpenDoc<T>(docId);

    if (!patchesDoc) {
      throw new Error(
        `Document "${docId}" is not open. Either open it with patches.openDoc() first, or use { autoClose: true } option.`
      );
    }

    // Increment ref count so autoClose mode won't close while we're using it
    manager.incrementRefCount(docId);

    setupDoc(patchesDoc);

    onBeforeUnmount(() => {
      unsubscribers.forEach(unsub => unsub());
      // Decrement ref count (but don't close - explicit mode never closes)
      manager.decrementRefCount(docId);
    });
  }

  // Change helper
  function change(mutator: ChangeMutator<T>) {
    if (!doc.value) {
      throw new Error('Cannot make changes: document not loaded yet');
    }
    doc.value.change(mutator);
  }

  return {
    data,
    loading,
    error,
    rev,
    hasPending,
    change,
    doc,
  };
}

/**
 * Return type for usePatchesSync composable.
 */
export interface UsePatchesSyncReturn {
  /**
   * Whether the WebSocket connection is established.
   */
  connected: Ref<boolean>;

  /**
   * Whether documents are currently syncing with the server.
   */
  syncing: Ref<boolean>;

  /**
   * Whether the client believes it has network connectivity.
   */
  online: Ref<boolean>;
}

/**
 * Vue composable for reactive Patches sync state.
 *
 * Provides reactive access to PatchesSync connection and sync status.
 * Useful for showing "Offline" banners, global loading indicators, etc.
 *
 * @example
 * ```typescript
 * const { connected, syncing, online } = usePatchesSync()
 *
 * // Show offline banner
 * if (!connected) {
 *   // Display "You are offline"
 * }
 * ```
 *
 * @returns Reactive sync state
 * @throws Error if Patches context not provided
 * @throws Error if PatchesSync was not provided to context
 */
export function usePatchesSync(): UsePatchesSyncReturn {
  const { sync } = usePatchesContext();

  if (!sync) {
    throw new Error('PatchesSync not found in context. Did you forget to pass sync to providePatchesContext()?');
  }

  const connected = ref(sync.state.connected);
  const syncing = ref(sync.state.syncing === 'updating');
  const online = ref(sync.state.online);

  const unsubscribe = sync.onStateChange((state: PatchesSyncState) => {
    connected.value = state.connected;
    syncing.value = state.syncing === 'updating';
    online.value = state.online;
  });

  onBeforeUnmount(() => {
    unsubscribe();
  });

  return {
    connected,
    syncing,
    online,
  };
}

/**
 * Creates an injection key for a named document context.
 * @internal
 */
function createDocInjectionKey<T extends object>(name: string): InjectionKey<UsePatchesDocReturn<T>> {
  return Symbol(`patches-doc-${name}`) as InjectionKey<UsePatchesDocReturn<T>>;
}

/**
 * Provides a Patches document in the component tree with a given name.
 *
 * This enables child components to access the document using `useCurrentDoc(name)`
 * without needing to pass the docId down through props. Supports both static and
 * reactive docIds.
 *
 * ## Use Cases
 *
 * **Static document (user settings):**
 * ```typescript
 * providePatchesDoc('user', 'user-123')
 * ```
 *
 * **Reactive document (multi-tab with autoClose: false):**
 * ```typescript
 * const activeTabId = ref('design-1')
 * providePatchesDoc('whiteboard', activeTabId) // Keeps all docs open, switches between them
 * ```
 *
 * **Reactive document (single-doc with autoClose: true):**
 * ```typescript
 * const currentDocId = ref('doc-1')
 * providePatchesDoc('document', currentDocId, { autoClose: true }) // Closes old, opens new
 * ```
 *
 * @param name - Unique identifier for this document context (e.g., 'whiteboard', 'user')
 * @param docId - Document ID (static string or reactive ref)
 * @param options - Configuration options (autoClose, etc.)
 *
 * @throws Error if Patches context not provided
 * @throws Error if doc not open in explicit mode
 */
export function providePatchesDoc<T extends object>(
  name: string,
  docId: MaybeRef<string>,
  options: UsePatchesDocOptions = {}
): UsePatchesDocReturn<T> {
  const { patches } = usePatchesContext();
  const { autoClose = false } = options;
  const manager = getDocManager(patches);

  // Create reactive refs for document state
  const doc = ref<PatchesDoc<T> | undefined>(undefined) as Ref<PatchesDoc<T> | undefined>;
  const data = shallowRef<T | undefined>(undefined) as ShallowRef<T | undefined>;
  const loading = ref<boolean>(true);
  const error = ref<Error | null>(null);
  const rev = ref<number>(0);
  const hasPending = ref<boolean>(false);

  // Track current docId and unsubscribers
  const currentDocId = ref<string>(unref(docId));
  const unsubscribers: Array<() => void> = [];

  // Setup reactivity for a doc
  function setupDoc(patchesDoc: PatchesDoc<T>) {
    // Clear previous subscriptions
    unsubscribers.forEach(unsub => unsub());
    unsubscribers.length = 0;

    doc.value = patchesDoc;

    // Subscribe to state changes
    const unsubState = patchesDoc.subscribe(state => {
      data.value = state;
      rev.value = patchesDoc.committedRev;
      hasPending.value = patchesDoc.hasPending;
    });
    unsubscribers.push(unsubState);

    // Subscribe to sync state changes
    const unsubSync = patchesDoc.onSyncing((syncState: SyncingState) => {
      loading.value = syncState === 'initial' || syncState === 'updating';
      error.value = syncState instanceof Error ? syncState : null;
    });
    unsubscribers.push(unsubSync);

    // Set initial loading state
    loading.value = patchesDoc.syncing !== null;
  }

  // Initialize the document
  async function initDoc(id: string) {
    currentDocId.value = id;

    if (autoClose) {
      // Auto mode: open doc with ref counting
      try {
        const patchesDoc = await manager.openDoc<T>(patches, id);
        setupDoc(patchesDoc);
      } catch (err) {
        error.value = err as Error;
        loading.value = false;
      }
    } else {
      // Explicit mode: doc must already be open
      try {
        const patchesDoc = patches.getOpenDoc<T>(id);
        if (!patchesDoc) {
          throw new Error(
            `Document "${id}" is not open. Either open it with patches.openDoc() first, or use { autoClose: true } option.`
          );
        }
        manager.incrementRefCount(id);
        setupDoc(patchesDoc);
      } catch (err) {
        error.value = err as Error;
        loading.value = false;
      }
    }
  }

  // Change helper
  function change(mutator: ChangeMutator<T>) {
    if (!doc.value) {
      throw new Error('Cannot make changes: document not loaded yet');
    }
    doc.value.change(mutator);
  }

  // Provide the document state BEFORE initializing
  // This allows useCurrentDoc to be called in the same component
  const docReturn: UsePatchesDocReturn<T> = {
    data,
    loading,
    error,
    rev,
    hasPending,
    change,
    doc,
  };

  const key = createDocInjectionKey<T>(name);
  provide(key, docReturn);

  // Initialize with initial docId (async)
  initDoc(unref(docId));

  // Watch for docId changes (only if docId is a ref)
  if (typeof docId !== 'string') {
    watch(docId, async (newDocId, oldDocId) => {
      if (newDocId === oldDocId) return;

      // Clean up old doc
      unsubscribers.forEach(unsub => unsub());
      unsubscribers.length = 0;

      if (autoClose) {
        // Close old doc (ref counted)
        await manager.closeDoc(patches, oldDocId);
      } else {
        // Just decrement ref count
        manager.decrementRefCount(oldDocId);
      }

      // Open new doc
      await initDoc(newDocId);
    });
  }

  // Cleanup on unmount
  onBeforeUnmount(async () => {
    unsubscribers.forEach(unsub => unsub());

    if (autoClose) {
      await manager.closeDoc(patches, currentDocId.value);
    } else {
      manager.decrementRefCount(currentDocId.value);
    }
  });

  return docReturn;
}

/**
 * Injects a Patches document provided by `providePatchesDoc`.
 *
 * Use this in child components to access a document provided higher up in the
 * component tree without passing the docId through props.
 *
 * @example
 * ```typescript
 * // Parent component
 * const whiteboardId = ref('whiteboard-123')
 * providePatchesDoc('whiteboard', whiteboardId)
 *
 * // Child component (anywhere in tree)
 * const { data, loading, change } = useCurrentDoc<WhiteboardDoc>('whiteboard')
 * ```
 *
 * @param name - The name used in providePatchesDoc
 * @returns Reactive document state and utilities
 * @throws Error if no document provided with that name
 */
export function useCurrentDoc<T extends object>(name: string): UsePatchesDocReturn<T> {
  const key = createDocInjectionKey<T>(name);
  const docReturn = inject(key);

  if (!docReturn) {
    throw new Error(
      `No document found for name "${name}". Did you forget to call providePatchesDoc('${name}', docId) in a parent component?`
    );
  }

  return docReturn;
}

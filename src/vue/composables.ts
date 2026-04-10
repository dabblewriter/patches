import type { Unsubscriber } from 'easy-signal';
import {
  inject,
  onBeforeUnmount,
  provide,
  ref,
  shallowRef,
  toValue,
  watch,
  type InjectionKey,
  type MaybeRef,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
} from 'vue';
import type { OpenDocOptions } from '../client/Patches.js';
import type { PatchesDoc } from '../client/PatchesDoc.js';
import type { PatchesSyncState } from '../net/PatchesSync.js';
import type { ChangeMutator, DocSyncStatus } from '../types.js';
import { getDocManager } from './doc-manager.js';
import { usePatchesContext } from './provider.js';

/**
 * Options for usePatchesDoc composable.
 */
export interface UsePatchesDocOptions extends OpenDocOptions {
  /**
   * When true, the document is removed from sync tracking on close.
   * By default documents stay tracked after closing.
   */
  untrack?: boolean;
}

/**
 * Return type for usePatchesDoc composable.
 */
export interface UsePatchesDocReturn<T extends object> {
  /** Reactive reference to the document state. */
  data: ShallowRef<T | undefined>;
  /** Whether the document is currently loading. */
  loading: Ref<boolean>;
  /** Error that occurred during sync, if any. */
  error: Ref<Error | undefined>;
  /** The committed revision number. */
  rev: Ref<number>;
  /** Whether there are pending local changes not yet committed by server. */
  hasPending: Ref<boolean>;
  /** Make changes to the document. No-ops if the document is not loaded. */
  change: (mutator: ChangeMutator<T>) => void;
  /** Close the document and reset state. Useful for explicit cleanup without unmounting. */
  close: () => Promise<void>;
  /** The underlying PatchesDoc instance. */
  doc: ShallowRef<PatchesDoc<T> | undefined>;
}

// --- Shared reactive state factory ---

/**
 * Creates the shared reactive state, subscription wiring, and change helper.
 * @internal
 */
function createDocReactiveState<T extends object>(hasSyncContext: boolean) {
  const doc = shallowRef<PatchesDoc<T> | undefined>(undefined) as ShallowRef<PatchesDoc<T> | undefined>;
  const data = shallowRef<T | undefined>(undefined) as ShallowRef<T | undefined>;
  const loading = ref<boolean>(false);
  const error = ref<Error | undefined>();
  const rev = ref<number>(0);
  const hasPending = ref<boolean>(false);

  function setupDoc(patchesDoc: PatchesDoc<T>): Unsubscriber {
    doc.value = patchesDoc;
    let loaded = false;

    function updateLoading(): void {
      if (loaded) return;
      if (patchesDoc.isLoaded.state) {
        loaded = true;
        loading.value = false;
      } else if (patchesDoc.syncStatus.state === 'syncing') {
        loading.value = true;
      } else if (!hasSyncContext) {
        loaded = true;
        loading.value = false;
      }
    }

    const unsubState = patchesDoc.subscribe(state => {
      data.value = state;
      rev.value = patchesDoc.committedRev;
      hasPending.value = patchesDoc.hasPending;
      updateLoading();
    });

    const unsubSync = patchesDoc.syncStatus.subscribe((status: DocSyncStatus) => {
      updateLoading();
      error.value = status === 'error' ? patchesDoc.syncError.state : undefined;
    }, false);

    return () => {
      unsubState();
      unsubSync();
    };
  }

  function resetRefs() {
    doc.value = undefined;
    data.value = undefined;
    loading.value = false;
    error.value = undefined;
    rev.value = 0;
    hasPending.value = false;
  }

  function change(mutator: ChangeMutator<T>) {
    doc.value?.change(mutator);
  }

  // close is set by usePatchesDoc after construction
  const baseReturn = { data, loading, error, rev, hasPending, change, doc } as UsePatchesDocReturn<T>;

  return { setupDoc, resetRefs, baseReturn };
}

// --- usePatchesDoc ---

/**
 * Vue composable for reactive Patches document state.
 *
 * Opens the document automatically and closes it on unmount (or when the path
 * changes). Accepts a static string, a ref, or a getter. When the value is
 * `null` or `undefined`, no document is loaded.
 *
 * @example
 * ```typescript
 * // Static
 * const { data, change } = usePatchesDoc('doc-123')
 *
 * // Reactive — swaps automatically
 * const { data, change } = usePatchesDoc(() => currentId.value && `projects/${currentId.value}`)
 * ```
 */
export function usePatchesDoc<T extends object>(docId: string, options?: UsePatchesDocOptions): UsePatchesDocReturn<T>;
export function usePatchesDoc<T extends object>(
  docId: MaybeRefOrGetter<string | null | undefined>,
  options?: UsePatchesDocOptions
): UsePatchesDocReturn<T>;
export function usePatchesDoc<T extends object>(
  docId: string | MaybeRefOrGetter<string | null | undefined>,
  options?: UsePatchesDocOptions
): UsePatchesDocReturn<T> {
  const { patches, sync } = usePatchesContext();
  const { untrack: shouldUntrack = false, algorithm, metadata } = options ?? {};
  const openDocOpts: OpenDocOptions = { algorithm, metadata };
  const manager = getDocManager(patches);

  const { setupDoc, resetRefs, baseReturn } = createDocReactiveState<T>(!!sync);

  let unsubscribe: Unsubscriber | null = null;
  let currentDocId: string | null = null;
  let unmounted = false;

  function teardown() {
    unsubscribe?.();
    unsubscribe = null;
  }

  async function openPath(id: string) {
    currentDocId = id;
    baseReturn.loading.value = true;

    try {
      const patchesDoc = await manager.openDoc<T>(patches, id, openDocOpts);
      if (unmounted || currentDocId !== id) {
        manager.closeDoc(patches, id, shouldUntrack);
        return;
      }
      unsubscribe = setupDoc(patchesDoc);
    } catch (err) {
      if (!unmounted && currentDocId === id) {
        baseReturn.error.value = err as Error;
        baseReturn.loading.value = false;
      }
    }
  }

  async function closePath(id: string) {
    teardown();
    resetRefs();
    await manager.closeDoc(patches, id, shouldUntrack);
  }

  baseReturn.close = async () => {
    if (currentDocId) {
      await closePath(currentDocId);
      currentDocId = null;
    }
  };

  const getter = typeof docId === 'string' ? () => docId : () => toValue(docId) || null;

  watch(
    getter,
    async (newId, oldId) => {
      if (newId === oldId) return;
      if (oldId) await closePath(oldId);
      if (newId) await openPath(newId);
    },
    { immediate: true }
  );

  onBeforeUnmount(async () => {
    unmounted = true;
    if (currentDocId) {
      await closePath(currentDocId);
      currentDocId = null;
    }
  });

  return baseReturn;
}

/**
 * Return type for usePatchesSync composable.
 */
export interface UsePatchesSyncReturn {
  connected: Ref<boolean>;
  syncing: Ref<boolean>;
  online: Ref<boolean>;
}

/**
 * Vue composable for reactive Patches sync state.
 *
 * @example
 * ```typescript
 * const { connected, syncing, online } = usePatchesSync()
 * ```
 */
export function usePatchesSync(): UsePatchesSyncReturn {
  const { sync } = usePatchesContext();

  if (!sync) {
    throw new Error('PatchesSync not found in context. Did you forget to pass sync to providePatchesContext()?');
  }

  const connected = ref(sync.state.connected);
  const syncing = ref(sync.state.syncStatus === 'syncing');
  const online = ref(sync.state.online);

  const unsubscribe = sync.subscribe((state: PatchesSyncState) => {
    connected.value = state.connected;
    syncing.value = state.syncStatus === 'syncing';
    online.value = state.online;
  }, false);

  onBeforeUnmount(() => {
    unsubscribe();
  });

  return { connected, syncing, online };
}

// --- providePatchesDoc / useCurrentDoc ---

function createDocInjectionKey<T extends object>(name: string): InjectionKey<UsePatchesDocReturn<T>> {
  return Symbol(`patches-doc-${name}`) as InjectionKey<UsePatchesDocReturn<T>>;
}

/**
 * Provides a Patches document in the component tree with a given name.
 *
 * @example
 * ```typescript
 * // Static
 * providePatchesDoc('user', 'user-123')
 *
 * // Reactive
 * const currentDocId = ref('doc-1')
 * providePatchesDoc('document', currentDocId)
 * ```
 */
export function providePatchesDoc<T extends object>(
  name: string,
  docId: MaybeRef<string>,
  options?: UsePatchesDocOptions
): UsePatchesDocReturn<T> {
  const key = createDocInjectionKey<T>(name);
  const result =
    typeof docId === 'string' ? usePatchesDoc<T>(docId, options) : usePatchesDoc<T>(() => docId.value, options);

  // Provide BEFORE the async open resolves so useCurrentDoc works immediately
  provide(key, result);
  return result;
}

/**
 * Injects a Patches document provided by `providePatchesDoc`.
 *
 * @example
 * ```typescript
 * const { data, loading, change } = useCurrentDoc<WhiteboardDoc>('whiteboard')
 * ```
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

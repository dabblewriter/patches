import {
  createSignal,
  createContext,
  useContext,
  createResource,
  createEffect,
  onCleanup,
  type Accessor,
  type Resource,
} from 'solid-js';
import type { PatchesDoc } from '../client/PatchesDoc.js';
import { JSONPatch } from '../json-patch/JSONPatch.js';
import type { SyncingState, ChangeMutator } from '../types.js';
import type { Unsubscriber } from '../event-signal.js';
import type { PatchesSyncState } from '../net/PatchesSync.js';
import { usePatchesContext } from './context.js';
import { getDocManager } from './doc-manager.js';

/**
 * Options for usePatchesDoc primitive (eager mode with docId).
 */
export interface UsePatchesDocOptions {
  /**
   * Controls document lifecycle management on cleanup.
   *
   * - `false` (default): Explicit mode. Assumes doc is already open. Throws if not.
   * - `true`: Opens doc on mount with ref counting, closes on cleanup (doc stays tracked).
   * - `'untrack'`: Opens doc on mount, closes AND untracks on cleanup (removes from sync).
   *
   * @default false
   */
  autoClose?: boolean | 'untrack';
}

/**
 * Options for usePatchesDoc primitive (lazy mode without docId).
 */
export interface UsePatchesDocLazyOptions {
  /**
   * Inject doc.id into state under this key on every state update.
   * Useful when the document ID is derived from the path but needed in the data.
   */
  idProp?: string;
}

/**
 * Return type for usePatchesDoc primitive (eager mode).
 */
export interface UsePatchesDocReturn<T extends object> {
  /**
   * Accessor for the document state.
   * Updated whenever the document changes (local or remote).
   */
  data: Accessor<T | undefined>;

  /**
   * Whether the document is currently loading/syncing.
   * - `true` during initial load or updates
   * - `false` when fully synced
   */
  loading: Accessor<boolean>;

  /**
   * Error that occurred during sync, if any.
   */
  error: Accessor<Error | null>;

  /**
   * The committed revision number.
   * Increments each time the server confirms changes.
   */
  rev: Accessor<number>;

  /**
   * Whether there are pending local changes not yet committed by server.
   */
  hasPending: Accessor<boolean>;

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
  doc: Accessor<PatchesDoc<T> | undefined>;
}

/**
 * Return type for usePatchesDoc primitive (lazy mode).
 * Extends the eager return type with lifecycle management methods.
 */
export interface UsePatchesDocLazyReturn<T extends object> extends UsePatchesDocReturn<T> {
  /**
   * Current document path. `null` when no document is loaded.
   */
  path: Accessor<string | null>;

  /**
   * Open a document by path. Closes any previously loaded document first.
   *
   * @param docPath - The document path to open
   */
  load: (docPath: string) => Promise<void>;

  /**
   * Close the current document, unsubscribe, and reset all state.
   * Calls `patches.closeDoc()` but does not untrack — tracking is managed separately.
   */
  close: () => Promise<void>;

  /**
   * Create a new document: open it, set initial state, then close it.
   * A one-shot operation that doesn't bind the document to this handle.
   *
   * @param docPath - The document path to create
   * @param initialState - Initial state object or JSONPatch to apply
   */
  create: (docPath: string, initialState: T | JSONPatch) => Promise<void>;
}

// --- Shared reactive state factory ---

interface DocReactiveStateOptions<T extends object> {
  initialLoading?: boolean;
  transformState?: (state: T, doc: PatchesDoc<T>) => T;
  changeBehavior: 'throw' | 'noop';
}

/**
 * Creates the shared reactive state, subscription wiring, and change helper
 * used by all doc primitive modes (eager, lazy, provider).
 * @internal
 */
function createDocReactiveState<T extends object>(options: DocReactiveStateOptions<T>) {
  const { initialLoading = true, transformState, changeBehavior } = options;

  const [doc, setDoc] = createSignal<PatchesDoc<T> | undefined>(undefined);
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [loading, setLoading] = createSignal<boolean>(initialLoading);
  const [error, setError] = createSignal<Error | null>(null);
  const [rev, setRev] = createSignal<number>(0);
  const [hasPending, setHasPending] = createSignal<boolean>(false);

  function setupDoc(patchesDoc: PatchesDoc<T>): Unsubscriber {
    setDoc(patchesDoc);

    const unsubState = patchesDoc.subscribe(state => {
      if (transformState && state) {
        state = transformState(state, patchesDoc);
      }
      setData(() => state as T);
      setRev(patchesDoc.committedRev);
      setHasPending(patchesDoc.hasPending);
    });

    const unsubSync = patchesDoc.onSyncing((syncState: SyncingState) => {
      setLoading(syncState === 'initial' || syncState === 'updating');
      setError(syncState instanceof Error ? syncState : null);
    });

    setLoading(patchesDoc.syncing !== null);

    return () => {
      unsubState();
      unsubSync();
    };
  }

  function resetSignals() {
    setDoc(undefined);
    setData(undefined);
    setLoading(false);
    setError(null);
    setRev(0);
    setHasPending(false);
  }

  function change(mutator: ChangeMutator<T>) {
    if (changeBehavior === 'throw') {
      const currentDoc = doc();
      if (!currentDoc) {
        throw new Error('Cannot make changes: document not loaded yet');
      }
      currentDoc.change(mutator);
    } else {
      doc()?.change(mutator);
    }
  }

  const baseReturn: UsePatchesDocReturn<T> = {
    data,
    loading,
    error,
    rev,
    hasPending,
    change,
    doc,
  };

  return { doc, setDoc, data, setData, loading, setLoading, error, setError, rev, setRev, hasPending, setHasPending, setupDoc, resetSignals, change, baseReturn };
}

// --- usePatchesDoc overloads ---

/**
 * Solid primitive for reactive Patches document state.
 *
 * ## Eager Mode (with docId)
 *
 * Provides reactive access to an already-open Patches document.
 *
 * @example
 * ```tsx
 * // Explicit lifecycle — you control open/close
 * const { data, loading, change } = usePatchesDoc(() => props.docId)
 *
 * // Auto lifecycle — opens on mount, closes on cleanup
 * const { data, loading, change } = usePatchesDoc(() => props.docId, { autoClose: true })
 * ```
 *
 * ## Lazy Mode (without docId)
 *
 * Returns a deferred handle with `load()`, `close()`, and `create()` methods.
 * Does NOT register `onCleanup` — caller manages lifecycle.
 *
 * @example
 * ```tsx
 * const { data, load, close, change, create } = usePatchesDoc<Project>()
 *
 * // Later, when the user navigates:
 * await load('projects/abc/content')
 *
 * // When leaving:
 * await close()
 * ```
 */
export function usePatchesDoc<T extends object>(
  docId: MaybeAccessor<string>,
  options?: UsePatchesDocOptions
): UsePatchesDocReturn<T>;
export function usePatchesDoc<T extends object>(options?: UsePatchesDocLazyOptions): UsePatchesDocLazyReturn<T>;
export function usePatchesDoc<T extends object>(
  docIdOrOptions?: MaybeAccessor<string> | UsePatchesDocLazyOptions,
  options?: UsePatchesDocOptions
): UsePatchesDocReturn<T> | UsePatchesDocLazyReturn<T> {
  // Determine mode based on first argument
  if (typeof docIdOrOptions === 'string' || typeof docIdOrOptions === 'function') {
    return _usePatchesDocEager<T>(docIdOrOptions as MaybeAccessor<string>, options ?? {});
  }
  return _usePatchesDocLazy<T>(docIdOrOptions ?? {});
}

/**
 * Eager mode implementation — the original behavior.
 */
function _usePatchesDocEager<T extends object>(
  docId: MaybeAccessor<string>,
  options: UsePatchesDocOptions
): UsePatchesDocReturn<T> {
  const { patches } = usePatchesContext();
  const autoClose = options.autoClose ?? false;
  const shouldUntrack = autoClose === 'untrack';
  const manager = getDocManager(patches);

  const { setupDoc, setError, setLoading, baseReturn } = createDocReactiveState<T>({ changeBehavior: 'throw' });

  const docIdAccessor = toAccessor(docId);

  if (autoClose) {
    const [docResource] = createResource(docIdAccessor, async id => {
      return await manager.openDoc<T>(patches, id);
    });

    createEffect(() => {
      const loadedDoc = docResource();
      if (loadedDoc) {
        const unsub = setupDoc(loadedDoc);
        onCleanup(() => unsub());
      }
      const resourceError = docResource.error;
      if (resourceError) {
        setError(resourceError);
        setLoading(false);
      }
    });

    onCleanup(() => {
      const id = docIdAccessor();
      manager.closeDoc(patches, id, shouldUntrack);
    });
  } else {
    createEffect(() => {
      const id = docIdAccessor();
      const patchesDoc = patches.getOpenDoc<T>(id);

      if (!patchesDoc) {
        throw new Error(
          `Document "${id}" is not open. Either open it with patches.openDoc() first, or use { autoClose: true } option.`
        );
      }

      manager.incrementRefCount(id);

      const unsub = setupDoc(patchesDoc);

      onCleanup(() => {
        unsub();
        manager.decrementRefCount(id);
      });
    });
  }

  return baseReturn;
}

/**
 * Lazy mode implementation — deferred loading without onCleanup.
 * Caller manages lifecycle via load()/close().
 */
function _usePatchesDocLazy<T extends object>(options: UsePatchesDocLazyOptions): UsePatchesDocLazyReturn<T> {
  const { patches } = usePatchesContext();
  const { idProp } = options;

  const { setupDoc, resetSignals, setError, setLoading, baseReturn } = createDocReactiveState<T>({
    initialLoading: false,
    changeBehavior: 'noop',
    transformState: idProp
      ? (state, patchesDoc) => ({ ...state, [idProp]: patchesDoc.id }) as T
      : undefined,
  });

  let unsubscribe: Unsubscriber | null = null;
  const [path, setPath] = createSignal<string | null>(null);

  function teardown() {
    unsubscribe?.();
    unsubscribe = null;
    resetSignals();
  }

  async function load(docPath: string) {
    if (path()) {
      const prevPath = path()!;
      teardown();
      await patches.closeDoc(prevPath);
    }

    setPath(docPath);

    try {
      const patchesDoc = await patches.openDoc<T>(docPath);
      unsubscribe = setupDoc(patchesDoc);
    } catch (err) {
      setError(err as Error);
      setLoading(false);
    }
  }

  async function close() {
    if (path()) {
      const prevPath = path()!;
      teardown();
      setPath(null);
      await patches.closeDoc(prevPath);
    }
  }

  async function create(docPath: string, initialState: T | JSONPatch) {
    const newDoc = await patches.openDoc<T>(docPath);
    newDoc.change((patch, root) => {
      if (initialState instanceof JSONPatch) {
        patch.ops = initialState.ops;
      } else {
        const state = { ...initialState };
        if (idProp) delete (state as Record<string, unknown>)[idProp];
        patch.replace(root, state);
      }
    });
    await patches.closeDoc(docPath);
  }

  return { ...baseReturn, path, load, close, create };
}

/**
 * Return type for usePatchesSync primitive.
 */
export interface UsePatchesSyncReturn {
  /**
   * Whether the WebSocket connection is established.
   */
  connected: Accessor<boolean>;

  /**
   * Whether documents are currently syncing with the server.
   */
  syncing: Accessor<boolean>;

  /**
   * Whether the client believes it has network connectivity.
   */
  online: Accessor<boolean>;
}

/**
 * Solid primitive for reactive Patches sync state.
 *
 * Provides reactive access to PatchesSync connection and sync status.
 * Useful for showing "Offline" banners, global loading indicators, etc.
 *
 * @example
 * ```tsx
 * const { connected, syncing, online } = usePatchesSync();
 *
 * return (
 *   <Show when={!connected()}>
 *     <div>You are offline</div>
 *   </Show>
 * );
 * ```
 *
 * @returns Reactive sync state
 * @throws Error if Patches context not provided
 * @throws Error if PatchesSync was not provided to context
 */
export function usePatchesSync(): UsePatchesSyncReturn {
  const { sync } = usePatchesContext();

  if (!sync) {
    throw new Error('PatchesSync not found in context. Did you forget to pass sync to PatchesProvider?');
  }

  const [connected, setConnected] = createSignal(sync.state.connected);
  const [syncing, setSyncing] = createSignal(sync.state.syncing === 'updating');
  const [online, setOnline] = createSignal(sync.state.online);

  const unsubscribe = sync.onStateChange((state: PatchesSyncState) => {
    setConnected(state.connected);
    setSyncing(state.syncing === 'updating');
    setOnline(state.online);
  });

  onCleanup(() => {
    unsubscribe();
  });

  return {
    connected,
    syncing,
    online,
  };
}

/**
 * Type for document ID - can be static string or accessor function.
 */
export type MaybeAccessor<T> = T | Accessor<T>;

/**
 * Helper to convert MaybeAccessor to Accessor.
 */
function toAccessor<T>(value: MaybeAccessor<T>): Accessor<T> {
  return typeof value === 'function' ? (value as Accessor<T>) : () => value;
}

/**
 * Context value for named document contexts.
 */
interface NamedDocContext<T extends object> {
  value: UsePatchesDocReturn<T>;
}

/**
 * Props for the Provider component returned by createPatchesDoc.
 */
export interface PatchesDocProviderProps {
  docId: MaybeAccessor<string>;
  autoClose?: boolean | 'untrack';
  children: any;
}

/**
 * Creates a named document context that can be provided to child components.
 *
 * This enables child components to access the document using the returned `useDoc` hook
 * without needing to pass the docId down through props. Supports both static and
 * reactive docIds.
 *
 * ## Use Cases
 *
 * **Static document (user settings):**
 * ```tsx
 * const { Provider, useDoc } = createPatchesDoc<User>('user');
 *
 * <Provider docId="user-123">
 *   <UserProfile />
 * </Provider>
 * ```
 *
 * **Reactive document (multi-tab):**
 * ```tsx
 * const { Provider, useDoc } = createPatchesDoc<Whiteboard>('whiteboard');
 * const [activeTabId, setActiveTabId] = createSignal('design-1');
 *
 * <Provider docId={activeTabId}>
 *   <WhiteboardCanvas />
 * </Provider>
 * ```
 *
 * **With autoClose:**
 * ```tsx
 * const { Provider, useDoc } = createPatchesDoc<Doc>('document');
 * const [currentDocId, setCurrentDocId] = createSignal('doc-1');
 *
 * <Provider docId={currentDocId} autoClose>
 *   <DocumentEditor />
 * </Provider>
 * ```
 *
 * @param name - Unique identifier for this document context (e.g., 'whiteboard', 'user')
 * @returns Object with Provider component and useDoc hook
 */
export function createPatchesDoc<T extends object>(name: string) {
  const Context = createContext<UsePatchesDocReturn<T>>();

  function Provider(props: PatchesDocProviderProps) {
    const { patches } = usePatchesContext();
    const manager = getDocManager(patches);
    const autoClose = props.autoClose ?? false;
    const shouldUntrack = autoClose === 'untrack';

    const { setupDoc, setError, setLoading, baseReturn } = createDocReactiveState<T>({ changeBehavior: 'throw' });

    const docIdAccessor = toAccessor(props.docId);

    if (autoClose) {
      const [docResource] = createResource(docIdAccessor, async id => {
        return await manager.openDoc<T>(patches, id);
      });

      createEffect(() => {
        const loadedDoc = docResource();
        if (loadedDoc) {
          const unsub = setupDoc(loadedDoc);
          onCleanup(() => unsub());
        }
        const resourceError = docResource.error;
        if (resourceError) {
          setError(resourceError);
          setLoading(false);
        }
      });

      createEffect((prevId: string | undefined) => {
        const currentId = docIdAccessor();

        if (prevId && prevId !== currentId) {
          manager.closeDoc(patches, prevId, shouldUntrack);
        }

        return currentId;
      });

      onCleanup(() => {
        const id = docIdAccessor();
        manager.closeDoc(patches, id, shouldUntrack);
      });
    } else {
      createEffect((prevId: string | undefined) => {
        const id = docIdAccessor();

        if (prevId && prevId !== id) {
          manager.decrementRefCount(prevId);
        }

        const patchesDoc = patches.getOpenDoc<T>(id);
        if (!patchesDoc) {
          throw new Error(
            `Document "${id}" is not open. Either open it with patches.openDoc() first, or use autoClose option.`
          );
        }

        manager.incrementRefCount(id);

        const unsub = setupDoc(patchesDoc);

        onCleanup(() => unsub());

        return id;
      });

      onCleanup(() => {
        const id = docIdAccessor();
        manager.decrementRefCount(id);
      });
    }

    return <Context.Provider value={baseReturn} children={props.children} />;
  }

  function useDoc(): UsePatchesDocReturn<T> {
    const context = useContext(Context);

    if (!context) {
      throw new Error(
        `useDoc('${name}') must be called within the corresponding Provider. ` +
          `Did you forget to wrap your component with the Provider from createPatchesDoc('${name}')?`
      );
    }

    return context;
  }

  return {
    Provider,
    useDoc,
  };
}

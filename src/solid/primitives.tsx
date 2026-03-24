import {
  createSignal,
  createContext,
  useContext,
  createResource,
  createEffect,
  onCleanup,
  type Accessor,
} from 'solid-js';
import type { OpenDocOptions } from '../client/Patches.js';
import type { PatchesDoc } from '../client/PatchesDoc.js';
import type { DocSyncStatus, ChangeMutator } from '../types.js';
import type { Unsubscriber } from 'easy-signal';
import type { PatchesSyncState } from '../net/PatchesSync.js';
import { usePatchesContext } from './context.js';
import { getDocManager } from './doc-manager.js';

/**
 * Options for usePatchesDoc primitive.
 */
export interface UsePatchesDocOptions extends OpenDocOptions {
  /**
   * When true, the document is removed from sync tracking on close.
   * By default documents stay tracked after closing.
   */
  untrack?: boolean;
}

/**
 * Return type for usePatchesDoc primitive.
 */
export interface UsePatchesDocReturn<T extends object> {
  /** Accessor for the document state. */
  data: Accessor<T | undefined>;
  /** Whether the document is currently loading. */
  loading: Accessor<boolean>;
  /** Error that occurred during sync, if any. */
  error: Accessor<Error | undefined>;
  /** The committed revision number. */
  rev: Accessor<number>;
  /** Whether there are pending local changes not yet committed by server. */
  hasPending: Accessor<boolean>;
  /** Make changes to the document. No-ops if the document is not loaded. */
  change: (mutator: ChangeMutator<T>) => void;
  /** Close the document and reset state. Useful for explicit cleanup. */
  close: () => Promise<void>;
  /** The underlying PatchesDoc instance. */
  doc: Accessor<PatchesDoc<T> | undefined>;
}

// --- Shared reactive state factory ---

/**
 * Creates the shared reactive state, subscription wiring, and change helper.
 * @internal
 */
function createDocReactiveState<T extends object>(hasSyncContext: boolean) {
  const [doc, setDoc] = createSignal<PatchesDoc<T> | undefined>(undefined);
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [loading, setLoading] = createSignal<boolean>(false);
  const [error, setError] = createSignal<Error | undefined>();
  const [rev, setRev] = createSignal<number>(0);
  const [hasPending, setHasPending] = createSignal<boolean>(false);

  function setupDoc(patchesDoc: PatchesDoc<T>): Unsubscriber {
    setDoc(patchesDoc);
    let loaded = false;

    function updateLoading(): void {
      if (loaded) return;
      if (patchesDoc.isLoaded.state) {
        loaded = true;
        setLoading(false);
      } else if (patchesDoc.syncStatus.state === 'syncing') {
        setLoading(true);
      } else if (!hasSyncContext) {
        loaded = true;
        setLoading(false);
      }
    }

    const unsubState = patchesDoc.subscribe(state => {
      setData(() => state as T);
      setRev(patchesDoc.committedRev);
      setHasPending(patchesDoc.hasPending);
      updateLoading();
    });

    const unsubSync = patchesDoc.syncStatus.subscribe((status: DocSyncStatus) => {
      updateLoading();
      setError(status === 'error' ? patchesDoc.syncError.state : undefined);
    }, false);

    return () => {
      unsubState();
      unsubSync();
    };
  }

  function resetSignals() {
    setDoc(undefined);
    setData(undefined);
    setLoading(false);
    setError(undefined);
    setRev(0);
    setHasPending(false);
  }

  function change(mutator: ChangeMutator<T>) {
    doc()?.change(mutator);
  }

  // close is set by usePatchesDoc after construction
  const baseReturn = { data, loading, error, rev, hasPending, change, doc } as UsePatchesDocReturn<T>;

  return { setupDoc, resetSignals, setError, baseReturn };
}

// --- usePatchesDoc ---

/**
 * Type for document ID — can be a static string or accessor function.
 */
export type MaybeAccessor<T> = T | Accessor<T>;

/**
 * Solid primitive for reactive Patches document state.
 *
 * Opens the document automatically and closes it on cleanup (or when the
 * accessor value changes). Accepts a static string or an accessor. When the
 * value is falsy, no document is loaded.
 *
 * @example
 * ```tsx
 * // Static
 * const { data, change } = usePatchesDoc('doc-123')
 *
 * // Reactive — swaps automatically
 * const [projectId, setProjectId] = createSignal<string | null>('abc')
 * const { data, change } = usePatchesDoc(() => projectId() && `projects/${projectId()}`)
 * ```
 */
export function usePatchesDoc<T extends object>(
  docId: MaybeAccessor<string | null | undefined | false>,
  options?: UsePatchesDocOptions
): UsePatchesDocReturn<T> {
  const { patches, sync } = usePatchesContext();
  const { untrack: shouldUntrack = false, algorithm, metadata } = options ?? {};
  const openDocOpts: OpenDocOptions = { algorithm, metadata };
  const manager = getDocManager(patches);

  const { setupDoc, resetSignals, setError, baseReturn } = createDocReactiveState<T>(!!sync);

  // Normalize to an accessor that returns string | null
  const source = typeof docId === 'string' ? () => docId : () => (docId as Accessor<string | null | undefined | false>)() || null;
  let currentId: string | null = null;

  const [docResource] = createResource(source, async id => {
    return await manager.openDoc<T>(patches, id, openDocOpts);
  });

  createEffect(() => {
    const currentSource = source();
    const loadedDoc = docResource();
    if (currentSource && loadedDoc) {
      currentId = currentSource;
      const unsub = setupDoc(loadedDoc);
      onCleanup(() => unsub());
    } else {
      resetSignals();
    }
    const resourceError = docResource.error;
    if (resourceError) {
      setError(resourceError);
    }
  });

  // Close previous doc when source changes
  createEffect((prevId: string | null | undefined) => {
    const id = source();
    if (prevId && prevId !== id) {
      currentId = null;
      manager.closeDoc(patches, prevId, shouldUntrack);
    }
    return id;
  });

  baseReturn.close = async () => {
    if (currentId) {
      const id = currentId;
      currentId = null;
      resetSignals();
      await manager.closeDoc(patches, id, shouldUntrack);
    }
  };

  onCleanup(() => {
    if (currentId) {
      manager.closeDoc(patches, currentId, shouldUntrack);
      currentId = null;
    }
  });

  return baseReturn;
}

/**
 * Return type for usePatchesSync primitive.
 */
export interface UsePatchesSyncReturn {
  connected: Accessor<boolean>;
  syncing: Accessor<boolean>;
  online: Accessor<boolean>;
}

/**
 * Solid primitive for reactive Patches sync state.
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
 */
export function usePatchesSync(): UsePatchesSyncReturn {
  const { sync } = usePatchesContext();

  if (!sync) {
    throw new Error('PatchesSync not found in context. Did you forget to pass sync to PatchesProvider?');
  }

  const [connected, setConnected] = createSignal(sync.state.connected);
  const [syncing, setSyncing] = createSignal(sync.state.syncStatus === 'syncing');
  const [online, setOnline] = createSignal(sync.state.online);

  const unsubscribe = sync.subscribe((state: PatchesSyncState) => {
    setConnected(state.connected);
    setSyncing(state.syncStatus === 'syncing');
    setOnline(state.online);
  }, false);

  onCleanup(() => {
    unsubscribe();
  });

  return { connected, syncing, online };
}

// --- createPatchesDoc (Provider pattern) ---

/**
 * Props for the Provider component returned by createPatchesDoc.
 */
export interface PatchesDocProviderProps extends OpenDocOptions {
  docId: MaybeAccessor<string>;
  untrack?: boolean;
  children: any;
}

/**
 * Creates a named document context that can be provided to child components.
 *
 * @example
 * ```tsx
 * const { Provider, useDoc } = createPatchesDoc<User>('user');
 *
 * <Provider docId="user-123">
 *   <UserProfile />
 * </Provider>
 *
 * // Reactive
 * const [activeTabId, setActiveTabId] = createSignal('design-1');
 * <Provider docId={activeTabId}>
 *   <WhiteboardCanvas />
 * </Provider>
 * ```
 */
export function createPatchesDoc<T extends object>(name: string) {
  const Context = createContext<UsePatchesDocReturn<T>>();

  function Provider(props: PatchesDocProviderProps) {
    const result = usePatchesDoc<T>(
      typeof props.docId === 'function' ? (props.docId as Accessor<string>) : props.docId,
      { untrack: props.untrack, algorithm: props.algorithm, metadata: props.metadata }
    );

    return <Context.Provider value={result} children={props.children} />;
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

  return { Provider, useDoc };
}

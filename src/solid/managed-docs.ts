import { createSignal, createEffect, onCleanup, type Accessor } from 'solid-js';
import type { PatchesDoc } from '../client/PatchesDoc.js';
import type { Unsubscriber } from '../event-signal.js';
import { usePatchesContext } from './context.js';
import { areSetsEqual } from './utils.js';

/**
 * Options for createManagedDocs primitive.
 */
export interface CreateManagedDocsOptions {
  /**
   * Inject doc.id into state under this key on every state update.
   * Useful when the document ID is derived from the path but needed in the data.
   */
  idProp?: string;
}

/**
 * Return type for createManagedDocs primitive.
 */
export interface CreateManagedDocsReturn<TData> {
  /**
   * Reactive aggregated data from all managed documents.
   * Updated whenever any document changes or the set of documents changes.
   */
  data: Accessor<TData>;

  /**
   * Stop watching paths, unsubscribe from all documents, and close them.
   * Call this when you're done with the managed documents.
   */
  close: () => void;
}

// Sentinel for empty paths to avoid triggering updates when nothing changed
const emptyPaths = new Set<string>();

/**
 * Reactively manages multiple documents based on a reactive list of paths.
 *
 * Opens documents as paths are added, closes them as paths are removed, and
 * aggregates state via a reducer function. Safe against race conditions from
 * async open/close operations.
 *
 * Registers `onCleanup` so it auto-cleans up when the enclosing reactive owner
 * (component, createRoot, etc.) disposes.
 *
 * @example
 * ```tsx
 * const [projectPaths] = createSignal(['projects/abc', 'projects/def']);
 *
 * const { data: projectMetas, close } = createManagedDocs<ProjectMeta, ProjectMetas>(
 *   projectPaths,
 *   {} as ProjectMetas,
 *   (data, path, state) => {
 *     const id = path.split('/').pop()!;
 *     data = { ...data };
 *     state ? (data[id] = state) : delete data[id];
 *     return data;
 *   },
 *   { idProp: 'id' },
 * );
 * ```
 *
 * @param paths - Accessor returning an array of document paths (or null)
 * @param initialData - Initial aggregated data value
 * @param reducer - Called when a document state changes (or is removed with `null`)
 * @param options - Optional configuration
 * @returns Reactive aggregated data and a close function
 */
export function createManagedDocs<TDoc extends object, TData>(
  paths: Accessor<string[] | null>,
  initialData: TData,
  reducer: (data: TData, path: string, state: TDoc | null) => TData,
  options?: CreateManagedDocsOptions
): CreateManagedDocsReturn<TData> {
  const { patches } = usePatchesContext();
  const { idProp } = options ?? {};

  const [data, setData] = createSignal<TData>(initialData);
  const docs = new Map<string, PatchesDoc<TDoc>>();
  const unsubscribes = new Map<string, Unsubscriber>();
  let currentPaths = new Set<string>();
  let closed = false;

  createEffect(() => {
    if (closed) return;

    const rawPaths = paths();
    const newPaths = rawPaths?.length ? new Set(rawPaths) : emptyPaths;
    const oldPaths = currentPaths;

    if (areSetsEqual(newPaths, oldPaths)) {
      return;
    }

    // Snapshot immediately so subsequent reactive triggers see the latest set
    currentPaths = new Set(newPaths);

    const toOpen = [...newPaths].filter(path => !oldPaths.has(path));
    const toClose = [...oldPaths].filter(path => !newPaths.has(path));

    // Open new docs
    for (const path of toOpen) {
      openPath(path);
    }

    // Close old docs
    for (const path of toClose) {
      closePath(path);
    }
  });

  async function openPath(path: string) {
    try {
      const doc = await patches.openDoc<TDoc>(path);

      // Race check: path may have been removed while we were opening
      if (closed || !currentPaths.has(path)) {
        await patches.closeDoc(path);
        return;
      }

      docs.set(path, doc);

      // Apply initial state immediately
      let initialState = doc.state;
      if (idProp && initialState) {
        initialState = { ...initialState, [idProp]: doc.id } as TDoc;
      }
      setData(prev => reducer(prev, path, initialState));

      // Subscribe for future updates
      unsubscribes.set(
        path,
        doc.subscribe(newState => {
          if (currentPaths.has(path)) {
            if (idProp && newState) {
              newState = { ...newState, [idProp]: doc.id } as TDoc;
            }
            setData(prev => reducer(prev, path, newState));
          }
        })
      );
    } catch (error) {
      console.error(`Failed to open doc at path: ${path}`, error);
    }
  }

  async function closePath(path: string) {
    const unsub = unsubscribes.get(path);
    if (unsub) {
      unsub();
      unsubscribes.delete(path);
    }

    const doc = docs.get(path);
    if (doc) {
      try {
        await patches.closeDoc(path);
      } catch (error) {
        console.error(`Failed to close doc at path: ${path}`, error);
      } finally {
        docs.delete(path);
        setData(prev => reducer(prev, path, null));
      }
    } else {
      setData(prev => reducer(prev, path, null));
    }
  }

  function close() {
    closed = true;
    const allPaths = [...docs.keys()];
    for (const path of allPaths) {
      const unsub = unsubscribes.get(path);
      if (unsub) {
        unsub();
        unsubscribes.delete(path);
      }
      const doc = docs.get(path);
      if (doc) {
        patches.closeDoc(path).catch(error => {
          console.error(`Failed to close doc during cleanup at path: ${path}`, error);
        });
        docs.delete(path);
      }
    }
    currentPaths.clear();
    setData(() => initialData);
  }

  onCleanup(close);

  return { data, close };
}

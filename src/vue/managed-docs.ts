import { shallowRef, watchEffect, type Ref, type ShallowRef } from 'vue';
import type { OpenDocOptions } from '../client/Patches.js';
import type { PatchesDoc } from '../client/PatchesDoc.js';
import type { Unsubscriber } from '../event-signal.js';
import { usePatchesContext } from './provider.js';
import { areSetsEqual } from './utils.js';

/**
 * Options for useManagedDocs composable.
 */
export interface UseManagedDocsOptions extends OpenDocOptions {
  /**
   * Inject doc.id into state under this key on every state update.
   * Useful when the document ID is derived from the path but needed in the data.
   */
  idProp?: string;
}

/**
 * Return type for useManagedDocs composable.
 */
export interface UseManagedDocsReturn<TData> {
  /**
   * Reactive aggregated data from all managed documents.
   * Updated whenever any document changes or the set of documents changes.
   */
  data: ShallowRef<TData>;

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
 * Uses `inject()` for the Patches instance and `watchEffect` for reactivity,
 * so it works in both Vue components and Pinia stores (via effectScope).
 *
 * @example
 * ```typescript
 * // In a Pinia store — aggregate project metas into a record
 * const projectPaths = computed(() =>
 *   Object.keys(workspace?.projects || {}).map(id => `projects/${id}`)
 * );
 *
 * const { data: projectMetas, close } = useManagedDocs<ProjectMeta, ProjectMetas>(
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
 * @param pathsRef - Reactive ref to an array of document paths (or null)
 * @param initialData - Initial aggregated data value
 * @param reducer - Called when a document state changes (or is removed with `null`)
 * @param options - Optional configuration
 * @returns Reactive aggregated data and a close function
 */
export function useManagedDocs<TDoc extends object, TData>(
  pathsRef: Readonly<Ref<string[] | null>>,
  initialData: TData,
  reducer: (data: TData, path: string, state: TDoc | null) => TData,
  options?: UseManagedDocsOptions
): UseManagedDocsReturn<TData> {
  const { patches } = usePatchesContext();
  const { idProp, algorithm, metadata } = options ?? {};
  const openDocOpts: OpenDocOptions = { algorithm, metadata };

  const data = shallowRef<TData>(initialData) as ShallowRef<TData>;
  const docs = new Map<string, PatchesDoc<TDoc>>();
  const unsubscribes = new Map<string, Unsubscriber>();
  let currentPaths = new Set<string>();

  const watchStopper = watchEffect(async () => {
    const newPaths = pathsRef.value?.length ? new Set(pathsRef.value) : emptyPaths;
    const oldPaths = currentPaths;

    if (areSetsEqual(newPaths, oldPaths)) {
      return;
    }

    // Snapshot immediately so subsequent reactive triggers see the latest set
    currentPaths = new Set(newPaths);

    const toOpen = new Set([...newPaths].filter(path => !oldPaths.has(path)));
    const toClose = new Set([...oldPaths].filter(path => !newPaths.has(path)));

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
      const doc = await patches.openDoc<TDoc>(path, openDocOpts);

      // Race check: path may have been removed while we were opening
      if (currentPaths.has(path)) {
        docs.set(path, doc);

        // Apply initial state immediately
        let initialState = doc.state;
        if (idProp && initialState) {
          initialState = { ...initialState, [idProp]: doc.id } as TDoc;
        }
        data.value = reducer(data.value, path, initialState);

        // Subscribe for future updates
        unsubscribes.set(
          path,
          doc.subscribe(newState => {
            if (currentPaths.has(path)) {
              if (idProp && newState) {
                newState = { ...newState, [idProp]: doc.id } as TDoc;
              }
              data.value = reducer(data.value, path, newState);
            }
          })
        );
      } else {
        // Path was removed while opening — close immediately
        await patches.closeDoc(path);
      }
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
        data.value = reducer(data.value, path, null);
      }
    } else {
      data.value = reducer(data.value, path, null);
    }
  }

  function close() {
    watchStopper();
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
    data.value = initialData;
  }

  return { data, close };
}

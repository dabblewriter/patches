/**
 * Solid.js integration for Patches.
 *
 * Provides reactive primitives for building real-time collaborative applications with Solid.js.
 *
 * @module @dabble/patches/solid
 *
 * @example
 * ```tsx
 * import { render } from 'solid-js/web';
 * import { Patches, InMemoryStore } from '@dabble/patches/client';
 * import { PatchesProvider, usePatchesDoc } from '@dabble/patches/solid';
 *
 * const patches = new Patches({ store: new InMemoryStore() });
 *
 * function App() {
 *   return (
 *     <PatchesProvider patches={patches}>
 *       <MyComponent />
 *     </PatchesProvider>
 *   );
 * }
 *
 * function MyComponent() {
 *   const { data, loading, change } = usePatchesDoc('doc-123', {
 *     autoClose: true
 *   });
 *
 *   return <Show when={!loading()} fallback={<div>Loading...</div>}>
 *     <div>{data()?.title}</div>
 *   </Show>;
 * }
 *
 * render(() => <App />, document.getElementById('app')!);
 * ```
 */

// Context
export { PatchesProvider, usePatchesContext, type PatchesContextValue, type PatchesProviderProps } from './context.js';

// Primitives
export {
  usePatchesDoc,
  usePatchesSync,
  createPatchesDoc,
  type UsePatchesDocOptions,
  type UsePatchesDocLazyOptions,
  type UsePatchesDocReturn,
  type UsePatchesDocLazyReturn,
  type UsePatchesSyncReturn,
  type PatchesDocProviderProps,
  type MaybeAccessor,
} from './primitives.js'; // .js extension works for both .ts and .tsx

// Managed docs primitive
export { createManagedDocs, type CreateManagedDocsOptions, type CreateManagedDocsReturn } from './managed-docs.js';

// Utilities
export { fillPath } from './utils.js';

// Doc Manager (for advanced use cases)
export { getDocManager, DocManager } from './doc-manager.js';

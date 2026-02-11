/**
 * Vue 3 integration for Patches.
 *
 * Provides composables and utilities for using Patches with Vue's Composition API.
 *
 * @example
 * ```typescript
 * // App setup
 * import { createApp } from 'vue'
 * import { Patches, OTInMemoryStore } from '@dabble/patches/client'
 * import { PatchesSync } from '@dabble/patches/net'
 * import { providePatchesContext } from '@dabble/patches/vue'
 *
 * const patches = new Patches({ store: new OTInMemoryStore() })
 * const sync = new PatchesSync(patches, 'wss://server.com')
 *
 * const app = createApp(App)
 * providePatchesContext(app, patches, sync)
 * app.mount('#app')
 * ```
 *
 * @example
 * ```typescript
 * // Component - explicit lifecycle
 * const { patches } = usePatchesContext()
 * onMounted(() => patches.openDoc('doc-123'))
 * onBeforeUnmount(() => patches.closeDoc('doc-123'))
 * const { data, loading, change } = usePatchesDoc('doc-123')
 * ```
 *
 * @example
 * ```typescript
 * // Component - auto lifecycle
 * const { data, loading, change } = usePatchesDoc('doc-123', {
 *   autoClose: true
 * })
 * ```
 *
 * @module @dabble/patches/vue
 */

// Provider pattern
export {
  PATCHES_KEY,
  PATCHES_SYNC_KEY,
  providePatchesContext,
  providePatches,
  usePatchesContext,
  type PatchesContext,
} from './provider.js';

// Composables
export {
  usePatchesDoc,
  usePatchesSync,
  providePatchesDoc,
  useCurrentDoc,
  type UsePatchesDocOptions,
  type UsePatchesDocLazyOptions,
  type UsePatchesDocReturn,
  type UsePatchesDocLazyReturn,
  type UsePatchesSyncReturn,
} from './composables.js';

// Managed docs composable
export { useManagedDocs, type UseManagedDocsOptions, type UseManagedDocsReturn } from './managed-docs.js';

// Utilities
export { fillPath } from './utils.js';

// Doc manager (for advanced use cases)
export { DocManager, getDocManager } from './doc-manager.js';

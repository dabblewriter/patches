import { inject, provide, type App, type InjectionKey } from 'vue';
import type { Patches } from '../client/Patches.js';
import type { PatchesSync } from '../net/PatchesSync.js';

/**
 * Injection key for Patches instance.
 */
export const PATCHES_KEY: InjectionKey<Patches> = Symbol('patches');

/**
 * Injection key for PatchesSync instance (optional).
 */
export const PATCHES_SYNC_KEY: InjectionKey<PatchesSync | undefined> = Symbol('patches-sync');

/**
 * Context containing Patches and optional PatchesSync instances.
 */
export interface PatchesContext {
  patches: Patches;
  sync?: PatchesSync;
}

/**
 * Provides Patches context to the Vue app.
 *
 * Call this in your app setup to make Patches available to all components via inject.
 *
 * @example
 * ```typescript
 * import { createApp } from 'vue'
 * import { Patches, InMemoryStore } from '@dabble/patches/client'
 * import { PatchesSync } from '@dabble/patches/net'
 * import { providePatchesContext } from '@dabble/patches/vue'
 *
 * const patches = new Patches({ store: new InMemoryStore() })
 * const sync = new PatchesSync(patches, 'wss://your-server.com')
 *
 * const app = createApp(App)
 * providePatchesContext(app, patches, sync)
 * app.mount('#app')
 * ```
 *
 * @param app - Vue app instance
 * @param patches - Patches instance
 * @param sync - Optional PatchesSync instance for network synchronization
 */
export function providePatchesContext(app: App, patches: Patches, sync?: PatchesSync): void {
  app.provide(PATCHES_KEY, patches);
  app.provide(PATCHES_SYNC_KEY, sync);
}

/**
 * Provides Patches context within a component setup function.
 *
 * Use this instead of providePatchesContext when providing from a component
 * rather than at the app level.
 *
 * @example
 * ```typescript
 * // In a component setup
 * providePatches(patches, sync)
 * ```
 */
export function providePatches(patches: Patches, sync?: PatchesSync): void {
  provide(PATCHES_KEY, patches);
  provide(PATCHES_SYNC_KEY, sync);
}

/**
 * Gets the injected Patches context.
 *
 * Throws an error if Patches has not been provided.
 *
 * @returns The Patches context
 * @throws Error if Patches context has not been provided
 *
 * @example
 * ```typescript
 * const { patches, sync } = usePatchesContext()
 *
 * // Use patches to open/close docs
 * await patches.openDoc('doc-123')
 * ```
 */
export function usePatchesContext(): PatchesContext {
  const patches = inject(PATCHES_KEY);
  const sync = inject(PATCHES_SYNC_KEY);

  if (!patches) {
    throw new Error('Patches context not found. Did you forget to call providePatchesContext() in your app setup?');
  }

  return { patches, sync };
}

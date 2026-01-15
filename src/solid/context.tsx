import { createContext, useContext, type JSX } from 'solid-js';
import type { Patches } from '../client/Patches.js';
import type { PatchesSync } from '../net/PatchesSync.js';

/**
 * Context value containing Patches and optional PatchesSync instances.
 */
export interface PatchesContextValue {
  patches: Patches;
  sync?: PatchesSync;
}

/**
 * Context for providing Patches instances to the component tree.
 */
const PatchesContext = createContext<PatchesContextValue>();

/**
 * Props for the PatchesProvider component.
 */
export interface PatchesProviderProps {
  patches: Patches;
  sync?: PatchesSync;
  children: JSX.Element;
}

/**
 * Provider component for making Patches and PatchesSync available to child components.
 *
 * @example
 * ```tsx
 * import { PatchesProvider } from '@dabble/patches/solid';
 * import { Patches, InMemoryStore } from '@dabble/patches/client';
 *
 * const patches = new Patches({ store: new InMemoryStore() });
 *
 * <PatchesProvider patches={patches}>
 *   <App />
 * </PatchesProvider>
 * ```
 */
export function PatchesProvider(props: PatchesProviderProps) {
  const value = { patches: props.patches, sync: props.sync };
  return <PatchesContext.Provider value={value} children={props.children} />;
}

/**
 * Hook to access the Patches context.
 *
 * @throws Error if called outside of a PatchesProvider
 * @returns PatchesContextValue containing patches and optional sync instances
 *
 * @example
 * ```tsx
 * import { usePatchesContext } from '@dabble/patches/solid';
 *
 * function MyComponent() {
 *   const { patches, sync } = usePatchesContext();
 *   // Use patches and sync...
 * }
 * ```
 */
export function usePatchesContext(): PatchesContextValue {
  const context = useContext(PatchesContext);

  if (!context) {
    throw new Error(
      'usePatchesContext must be called within a PatchesProvider. ' +
        'Make sure your component is wrapped with <PatchesProvider>.'
    );
  }

  return context;
}

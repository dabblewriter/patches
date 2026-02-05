import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot, type JSX } from 'solid-js';
import { Patches } from '../../src/client/Patches.js';
import { createOTPatches } from '../../src/client/factories.js';
import { PatchesProvider, usePatchesContext } from '../../src/solid/context.js';

describe('Solid Context', () => {
  let patches: Patches;
  let mockSync: any;

  beforeEach(() => {
    patches = createOTPatches();
    mockSync = { state: { connected: false, syncing: null, online: true } };
  });

  describe('PatchesProvider', () => {
    it('should provide Patches instance', () => {
      createRoot(dispose => {
        const TestComponent = () => {
          const { patches: injectedPatches } = usePatchesContext();
          expect(injectedPatches).toBe(patches);
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();
        dispose();
      });
    });

    it('should provide both Patches and PatchesSync', () => {
      createRoot(dispose => {
        const TestComponent = () => {
          const { patches: injectedPatches, sync } = usePatchesContext();
          expect(injectedPatches).toBe(patches);
          expect(sync).toBe(mockSync);
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches} sync={mockSync}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();
        dispose();
      });
    });

    it('should work without PatchesSync', () => {
      createRoot(dispose => {
        const TestComponent = () => {
          const { patches: injectedPatches, sync } = usePatchesContext();
          expect(injectedPatches).toBe(patches);
          expect(sync).toBeUndefined();
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();
        dispose();
      });
    });
  });

  describe('usePatchesContext', () => {
    it('should throw error when called outside provider', () => {
      createRoot(dispose => {
        expect(() => usePatchesContext()).toThrow('usePatchesContext must be called within a PatchesProvider');
        dispose();
      });
    });

    it('should return context value when inside provider', () => {
      createRoot(dispose => {
        const TestComponent = () => {
          const context = usePatchesContext();
          expect(context.patches).toBe(patches);
          expect(context.sync).toBe(mockSync);
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches} sync={mockSync}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();
        dispose();
      });
    });
  });
});

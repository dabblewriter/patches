import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createSignal, type JSX } from 'solid-js';
import { Patches } from '../../src/client/Patches.js';
import { InMemoryStore } from '../../src/client/InMemoryStore.js';
import { PatchesProvider } from '../../src/solid/context.js';
import { usePatchesDoc, usePatchesSync, createPatchesDoc } from '../../src/solid/primitives.js';
import { getDocManager } from '../../src/solid/doc-manager.js';

describe('Solid Primitives', () => {
  let patches: Patches;

  beforeEach(() => {
    patches = new Patches({ store: new InMemoryStore() });
  });

  afterEach(async () => {
    await patches.close();
  });

  describe('usePatchesDoc - explicit mode (default)', () => {
    it('should throw error if doc not open', () => {
      createRoot(dispose => {
        const TestComponent = () => {
          expect(() => usePatchesDoc('doc-1')).toThrow('Document "doc-1" is not open');
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

    it('should return reactive document state', async () => {
      await patches.openDoc('doc-1');

      createRoot(dispose => {
        let data: any;
        let loading: any;
        let rev: any;

        const TestComponent = () => {
          const doc = usePatchesDoc<any>(() => 'doc-1');
          data = doc.data;
          loading = doc.loading;
          rev = doc.rev;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Initial state
        expect(data() === null || typeof data() === 'object').toBe(true);
        expect(loading()).toBe(false);
        expect(rev()).toBe(0);

        dispose();
      });

      await patches.closeDoc('doc-1');
    });

    it('should update reactively when document changes', async () => {
      await patches.openDoc<{ title?: string }>('doc-1');
      const doc = patches.getOpenDoc<{ title?: string }>('doc-1')!;

      createRoot(dispose => {
        let data: any;

        const TestComponent = () => {
          const docState = usePatchesDoc<{ title?: string }>(() => 'doc-1');
          data = docState.data;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Make a change
        doc.change((patch, root) => {
          patch.replace(root.title!, 'Hello World');
        });

        // Solid's reactivity is synchronous
        expect(data()?.title).toBe('Hello World');

        dispose();
      });

      await patches.closeDoc('doc-1');
    });

    it('should provide change helper', async () => {
      await patches.openDoc<{ count?: number }>('doc-1');

      createRoot(dispose => {
        let change: any;
        let data: any;

        const TestComponent = () => {
          const docState = usePatchesDoc<{ count?: number }>(() => 'doc-1');
          change = docState.change;
          data = docState.data;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Use change helper
        change((patch: any, root: any) => {
          patch.replace(root.count!, 42);
        });

        expect(data()?.count).toBe(42);

        dispose();
      });

      await patches.closeDoc('doc-1');
    });

    it('should increment and decrement ref count', async () => {
      await patches.openDoc('doc-1');
      const manager = getDocManager(patches);

      expect(manager.getRefCount('doc-1')).toBe(0);

      createRoot(dispose => {
        const TestComponent = () => {
          usePatchesDoc('doc-1');
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Should increment ref count
        expect(manager.getRefCount('doc-1')).toBe(1);

        dispose();

        // Should decrement ref count on cleanup
        expect(manager.getRefCount('doc-1')).toBe(0);
      });

      await patches.closeDoc('doc-1');
    });
  });

  describe('usePatchesDoc - auto mode', () => {
    it('should open document on mount', async () => {
      createRoot(async dispose => {
        let doc: any;

        const TestComponent = () => {
          const docState = usePatchesDoc<any>(() => 'doc-1', { autoClose: true });
          doc = docState.doc;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Wait for async open (createResource)
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(doc()).toBeDefined();
        expect(patches.getOpenDoc('doc-1')).toBeDefined();

        dispose();
      });
    });

    it('should close document on unmount', async () => {
      createRoot(async dispose => {
        const TestComponent = () => {
          usePatchesDoc<any>(() => 'doc-1', { autoClose: true });
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Wait for async open
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(patches.getOpenDoc('doc-1')).toBeDefined();

        dispose();

        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(patches.getOpenDoc('doc-1')).toBeUndefined();
      });
    });

    it('should use reference counting for multiple components', async () => {
      const manager = getDocManager(patches);

      createRoot(async dispose => {
        const TestComponent1 = () => {
          usePatchesDoc<any>(() => 'doc-1', { autoClose: true });
          return null;
        };

        const TestComponent2 = () => {
          usePatchesDoc<any>(() => 'doc-1', { autoClose: true });
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent1 />
              <TestComponent2 />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Wait for async opens
        await new Promise(resolve => setTimeout(resolve, 20));

        // Should have ref count of 2
        expect(manager.getRefCount('doc-1')).toBe(2);
        expect(patches.getOpenDoc('doc-1')).toBeDefined();

        dispose();

        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 10));

        // Should be closed now
        expect(manager.getRefCount('doc-1')).toBe(0);
        expect(patches.getOpenDoc('doc-1')).toBeUndefined();
      });
    });

    it('should handle errors gracefully', async () => {
      createRoot(async dispose => {
        let error: any;
        let loading: any;

        const TestComponent = () => {
          const docState = usePatchesDoc<any>(() => 'non-existent-doc', {
            autoClose: true,
          });
          error = docState.error;
          loading = docState.loading;
          return null;
        };

        // Mock openDoc to fail
        vi.spyOn(patches, 'openDoc').mockRejectedValue(new Error('Doc not found'));

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Wait for async operation to fail
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(error()).toBeInstanceOf(Error);
        expect(error().message).toBe('Doc not found');
        expect(loading()).toBe(false);

        dispose();
      });
    });
  });

  describe('usePatchesSync', () => {
    it('should throw error if sync not provided', () => {
      createRoot(dispose => {
        const TestComponent = () => {
          expect(() => usePatchesSync()).toThrow('PatchesSync not found in context');
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

    it('should return reactive sync state', () => {
      const mockSync: any = {
        state: { connected: true, syncing: 'updating', online: true },
        onStateChange: vi.fn(() => () => {}),
      };

      createRoot(dispose => {
        let connected: any;
        let syncing: any;
        let online: any;

        const TestComponent = () => {
          const syncState = usePatchesSync();
          connected = syncState.connected;
          syncing = syncState.syncing;
          online = syncState.online;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches} sync={mockSync}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        expect(connected()).toBe(true);
        expect(syncing()).toBe(true); // 'updating' → true
        expect(online()).toBe(true);
        expect(mockSync.onStateChange).toHaveBeenCalled();

        dispose();
      });
    });

    it('should update reactively on state changes', () => {
      let stateChangeCallback: any;
      const mockSync: any = {
        state: { connected: false, syncing: null, online: false },
        onStateChange: vi.fn((cb: any) => {
          stateChangeCallback = cb;
          return () => {};
        }),
      };

      createRoot(dispose => {
        let connected: any;

        const TestComponent = () => {
          const syncState = usePatchesSync();
          connected = syncState.connected;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches} sync={mockSync}>
              <TestComponent />
            </PatchesProvider>
          ) as JSX.Element;

        App();

        expect(connected()).toBe(false);

        // Trigger state change
        stateChangeCallback({ connected: true, syncing: null, online: true });

        expect(connected()).toBe(true);

        dispose();
      });
    });
  });

  describe('createPatchesDoc', () => {
    it('should provide document context to children', async () => {
      await patches.openDoc<{ title?: string }>('doc-1');

      const { Provider, useDoc } = createPatchesDoc<{ title?: string }>('test');

      createRoot(dispose => {
        let data: any;

        const ChildComponent = () => {
          const docState = useDoc();
          data = docState.data;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <Provider docId="doc-1">
                <ChildComponent />
              </Provider>
            </PatchesProvider>
          ) as JSX.Element;

        App();

        expect(data()).toBeDefined();

        dispose();
      });

      await patches.closeDoc('doc-1');
    });

    it('should throw error if useDoc called outside Provider', () => {
      const { useDoc } = createPatchesDoc<any>('test');

      createRoot(dispose => {
        const TestComponent = () => {
          expect(() => useDoc()).toThrow("useDoc('test') must be called within the corresponding Provider");
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

    it('should support reactive docId', async () => {
      await patches.openDoc<{ title?: string }>('doc-1');
      await patches.openDoc<{ title?: string }>('doc-2');

      const doc1 = patches.getOpenDoc<{ title?: string }>('doc-1')!;
      const doc2 = patches.getOpenDoc<{ title?: string }>('doc-2')!;

      doc1.change((patch, root) => patch.replace(root.title!, 'Doc 1'));
      doc2.change((patch, root) => patch.replace(root.title!, 'Doc 2'));

      const { Provider, useDoc } = createPatchesDoc<{ title?: string }>('test');

      createRoot(dispose => {
        const [docId, setDocId] = createSignal('doc-1');
        let data: any;

        const ChildComponent = () => {
          const docState = useDoc();
          data = docState.data;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <Provider docId={docId}>
                <ChildComponent />
              </Provider>
            </PatchesProvider>
          ) as JSX.Element;

        App();

        expect(data()?.title).toBe('Doc 1');

        // Switch to doc-2
        setDocId('doc-2');

        // Wait for effect to run
        setTimeout(() => {
          expect(data()?.title).toBe('Doc 2');
        }, 10);

        dispose();
      });

      await patches.closeDoc('doc-1');
      await patches.closeDoc('doc-2');
    });

    it('should support autoClose option', async () => {
      const { Provider, useDoc } = createPatchesDoc<any>('test');

      createRoot(async dispose => {
        let data: any;

        const ChildComponent = () => {
          const docState = useDoc();
          data = docState.data;
          return null;
        };

        const App = () =>
          (
            <PatchesProvider patches={patches}>
              <Provider docId="doc-1" autoClose>
                <ChildComponent />
              </Provider>
            </PatchesProvider>
          ) as JSX.Element;

        App();

        // Wait for async open
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(patches.getOpenDoc('doc-1')).toBeDefined();
        expect(data()).toBeDefined();

        dispose();

        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(patches.getOpenDoc('doc-1')).toBeUndefined();
      });
    });
  });
});

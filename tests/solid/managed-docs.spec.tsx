import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createSignal, type JSX } from 'solid-js';
import { Patches } from '../../src/client/Patches.js';
import { createOTPatches } from '../../src/client/factories.js';
import { PatchesProvider } from '../../src/solid/context.js';
import { createManagedDocs } from '../../src/solid/managed-docs.js';

// Helper to wait for effects + async ops
const wait = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

describe('createManagedDocs', () => {
  let patches: Patches;

  beforeEach(() => {
    patches = createOTPatches();
  });

  afterEach(async () => {
    await patches.close();
  });

  function setupManagedDocs<TDoc extends object, TData>(
    pathsAccessor: () => string[] | null,
    initialData: TData,
    reducer: (data: TData, path: string, state: TDoc | null) => TData,
    options?: { idProp?: string },
  ) {
    let result: ReturnType<typeof createManagedDocs<TDoc, TData>>;

    const TestComponent = () => {
      result = createManagedDocs<TDoc, TData>(pathsAccessor, initialData, reducer, options);
      return null;
    };

    const App = () =>
      (
        <PatchesProvider patches={patches}>
          <TestComponent />
        </PatchesProvider>
      ) as JSX.Element;

    return { App, getResult: () => result! };
  }

  it('should start with initial data', async () => {
    const [paths] = createSignal<string[] | null>(null);

    await createRoot(async dispose => {
      const { App, getResult } = setupManagedDocs<any, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();
      await wait(0);

      expect(getResult().data()).toEqual({});
      dispose();
    });
  });

  it('should open docs when paths are added', async () => {
    const [paths, setPaths] = createSignal<string[] | null>(null);

    await createRoot(async dispose => {
      const { App, getResult } = setupManagedDocs<{ name?: string }, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();

      // Add paths
      setPaths(['doc-1', 'doc-2']);

      await wait();

      expect(patches.getOpenDoc('doc-1')).toBeDefined();
      expect(patches.getOpenDoc('doc-2')).toBeDefined();

      // Data should have both docs
      expect(getResult().data()).toHaveProperty('doc-1');
      expect(getResult().data()).toHaveProperty('doc-2');

      dispose();
    });
  });

  it('should close docs when paths are removed', async () => {
    const [paths, setPaths] = createSignal<string[] | null>(['doc-1', 'doc-2']);

    await createRoot(async dispose => {
      const { App, getResult } = setupManagedDocs<any, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();
      await wait();

      expect(patches.getOpenDoc('doc-1')).toBeDefined();
      expect(patches.getOpenDoc('doc-2')).toBeDefined();

      // Remove doc-2
      setPaths(['doc-1']);
      await wait();

      expect(patches.getOpenDoc('doc-1')).toBeDefined();
      expect(patches.getOpenDoc('doc-2')).toBeUndefined();

      // Data should reflect removal
      expect(getResult().data()).toHaveProperty('doc-1');
      expect(getResult().data()).not.toHaveProperty('doc-2');

      dispose();
    });
  });

  it('should call reducer with null when doc is removed', async () => {
    const reducer = vi.fn((data: Record<string, any>, path: string, state: any) => {
      data = { ...data };
      state ? (data[path] = state) : delete data[path];
      return data;
    });

    const [paths, setPaths] = createSignal<string[] | null>(['doc-1']);

    await createRoot(async dispose => {
      const { App } = setupManagedDocs<any, Record<string, any>>(paths, {}, reducer);

      App();
      await wait();

      // Remove doc-1
      setPaths([]);
      await wait();

      // Should have been called with null state for removal
      const removeCalls = reducer.mock.calls.filter(([_, __, state]) => state === null);
      expect(removeCalls.length).toBeGreaterThan(0);
      expect(removeCalls[0][1]).toBe('doc-1');

      dispose();
    });
  });

  it('should update data when managed documents change', async () => {
    const [paths] = createSignal<string[] | null>(['doc-1']);

    await createRoot(async dispose => {
      const { App, getResult } = setupManagedDocs<{ title?: string }, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();
      await wait();

      // Make a change to doc-1
      const doc = patches.getOpenDoc<{ title?: string }>('doc-1')!;
      doc.change((patch, root) => {
        patch.replace(root.title!, 'Hello');
      });

      await wait(10);

      expect(getResult().data()['doc-1'].title).toBe('Hello');

      dispose();
    });
  });

  it('should inject idProp into state', async () => {
    const [paths] = createSignal<string[] | null>(['my-doc']);

    await createRoot(async dispose => {
      const { App, getResult } = setupManagedDocs<{ id?: string; name?: string }, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
        { idProp: 'id' },
      );

      App();
      await wait();

      expect(getResult().data()['my-doc'].id).toBe('my-doc');

      dispose();
    });
  });

  it('should close all docs and stop watching on close()', async () => {
    const [paths] = createSignal<string[] | null>(['doc-1', 'doc-2']);

    await createRoot(async dispose => {
      const { App, getResult } = setupManagedDocs<any, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();
      await wait();

      expect(patches.getOpenDoc('doc-1')).toBeDefined();
      expect(patches.getOpenDoc('doc-2')).toBeDefined();

      getResult().close();
      await wait();

      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
      expect(patches.getOpenDoc('doc-2')).toBeUndefined();
      expect(getResult().data()).toEqual({});

      dispose();
    });
  });

  it('should handle null paths', async () => {
    const [paths] = createSignal<string[] | null>(null);

    await createRoot(async dispose => {
      const { App, getResult } = setupManagedDocs<any, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();
      await wait(0);

      expect(getResult().data()).toEqual({});

      dispose();
    });
  });

  it('should handle empty paths array', async () => {
    const [paths] = createSignal<string[] | null>([]);

    await createRoot(async dispose => {
      const { App, getResult } = setupManagedDocs<any, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();
      await wait(0);

      expect(getResult().data()).toEqual({});

      dispose();
    });
  });

  it('should not reopen docs that are already managed', async () => {
    const openDocSpy = vi.spyOn(patches, 'openDoc');
    const [paths, setPaths] = createSignal<string[] | null>(['doc-1']);

    await createRoot(async dispose => {
      const { App } = setupManagedDocs<any, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();
      await wait();

      const initialCallCount = openDocSpy.mock.calls.length;

      // Trigger with same paths — should not reopen
      setPaths(['doc-1']);
      await wait();

      expect(openDocSpy.mock.calls.length).toBe(initialCallCount);

      dispose();
    });

    openDocSpy.mockRestore();
  });

  it('should auto-cleanup via onCleanup when owner disposes', async () => {
    const [paths] = createSignal<string[] | null>(['doc-1']);

    await createRoot(async dispose => {
      const { App } = setupManagedDocs<any, Record<string, any>>(
        paths,
        {},
        (data, path, state) => {
          data = { ...data };
          state ? (data[path] = state) : delete data[path];
          return data;
        },
      );

      App();
      await wait();

      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      // Disposing the root should trigger onCleanup → close()
      dispose();
      await wait();

      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
    });
  });
});

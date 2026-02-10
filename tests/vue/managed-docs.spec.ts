import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent, h, ref, nextTick } from 'vue';
import { Patches } from '../../src/client/Patches.js';
import { createOTPatches } from '../../src/client/factories.js';
import { providePatchesContext } from '../../src/vue/provider.js';
import { useManagedDocs } from '../../src/vue/managed-docs.js';

describe('useManagedDocs', () => {
  let patches: Patches;

  beforeEach(() => {
    patches = createOTPatches();
  });

  afterEach(async () => {
    await patches.close();
  });

  function mountWithManagedDocs<TDoc extends object, TData>(
    pathsRef: ReturnType<typeof ref<string[] | null>>,
    initialData: TData,
    reducer: (data: TData, path: string, state: TDoc | null) => TData,
    options?: { idProp?: string },
  ) {
    let result: ReturnType<typeof useManagedDocs<TDoc, TData>>;

    const TestComponent = defineComponent({
      setup() {
        result = useManagedDocs<TDoc, TData>(pathsRef, initialData, reducer, options);
        return () => h('div');
      },
    });

    const app = createApp(TestComponent);
    providePatchesContext(app, patches);

    const el = document.createElement('div');
    app.mount(el);

    return { app, result: result! };
  }

  it('should start with initial data', () => {
    const paths = ref<string[] | null>(null);
    const { app, result } = mountWithManagedDocs<any, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
    );

    expect(result.data.value).toEqual({});
    app.unmount();
  });

  it('should open docs when paths are added', async () => {
    const paths = ref<string[] | null>(null);
    const { app, result } = mountWithManagedDocs<{ name?: string }, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
    );

    // Add paths
    paths.value = ['doc-1', 'doc-2'];

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(patches.getOpenDoc('doc-1')).toBeDefined();
    expect(patches.getOpenDoc('doc-2')).toBeDefined();

    // Data should have both docs
    expect(result.data.value).toHaveProperty('doc-1');
    expect(result.data.value).toHaveProperty('doc-2');

    app.unmount();
  });

  it('should close docs when paths are removed', async () => {
    const paths = ref<string[] | null>(['doc-1', 'doc-2']);
    const { app, result } = mountWithManagedDocs<any, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
    );

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(patches.getOpenDoc('doc-1')).toBeDefined();
    expect(patches.getOpenDoc('doc-2')).toBeDefined();

    // Remove doc-2
    paths.value = ['doc-1'];

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(patches.getOpenDoc('doc-1')).toBeDefined();
    expect(patches.getOpenDoc('doc-2')).toBeUndefined();

    // Data should reflect removal
    expect(result.data.value).toHaveProperty('doc-1');
    expect(result.data.value).not.toHaveProperty('doc-2');

    app.unmount();
  });

  it('should call reducer with null when doc is removed', async () => {
    const reducer = vi.fn((data: Record<string, any>, path: string, state: any) => {
      data = { ...data };
      state ? (data[path] = state) : delete data[path];
      return data;
    });

    const paths = ref<string[] | null>(['doc-1']);
    const { app } = mountWithManagedDocs<any, Record<string, any>>(paths, {}, reducer);

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Remove doc-1
    paths.value = [];

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Should have been called with null state for removal
    const removeCalls = reducer.mock.calls.filter(([_, __, state]) => state === null);
    expect(removeCalls.length).toBeGreaterThan(0);
    expect(removeCalls[0][1]).toBe('doc-1');

    app.unmount();
  });

  it('should update data when managed documents change', async () => {
    const paths = ref<string[] | null>(['doc-1']);
    const { app, result } = mountWithManagedDocs<{ title?: string }, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
    );

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Make a change to doc-1
    const doc = patches.getOpenDoc<{ title?: string }>('doc-1')!;
    doc.change((patch, root) => {
      patch.replace(root.title!, 'Hello');
    });

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(result.data.value['doc-1'].title).toBe('Hello');

    app.unmount();
  });

  it('should inject idProp into state', async () => {
    const paths = ref<string[] | null>(['my-doc']);
    const { app, result } = mountWithManagedDocs<{ id?: string; name?: string }, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
      { idProp: 'id' },
    );

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(result.data.value['my-doc'].id).toBe('my-doc');

    app.unmount();
  });

  it('should close all docs and stop watching on close()', async () => {
    const paths = ref<string[] | null>(['doc-1', 'doc-2']);
    const { app, result } = mountWithManagedDocs<any, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
    );

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(patches.getOpenDoc('doc-1')).toBeDefined();
    expect(patches.getOpenDoc('doc-2')).toBeDefined();

    result.close();

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(patches.getOpenDoc('doc-1')).toBeUndefined();
    expect(patches.getOpenDoc('doc-2')).toBeUndefined();
    expect(result.data.value).toEqual({});

    app.unmount();
  });

  it('should handle null paths', () => {
    const paths = ref<string[] | null>(null);
    const { app, result } = mountWithManagedDocs<any, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
    );

    expect(result.data.value).toEqual({});
    app.unmount();
  });

  it('should handle empty paths array', async () => {
    const paths = ref<string[] | null>([]);
    const { app, result } = mountWithManagedDocs<any, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
    );

    await nextTick();
    expect(result.data.value).toEqual({});
    app.unmount();
  });

  it('should not reopen docs that are already managed', async () => {
    const openDocSpy = vi.spyOn(patches, 'openDoc');

    const paths = ref<string[] | null>(['doc-1']);
    const { app } = mountWithManagedDocs<any, Record<string, any>>(
      paths,
      {},
      (data, path, state) => {
        data = { ...data };
        state ? (data[path] = state) : delete data[path];
        return data;
      },
    );

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    const initialCallCount = openDocSpy.mock.calls.length;

    // Trigger with same paths — should not reopen
    paths.value = ['doc-1'];
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(openDocSpy.mock.calls.length).toBe(initialCallCount);

    app.unmount();
  });
});

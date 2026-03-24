import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { store } from 'easy-signal';
import { Patches } from '../../src/client/Patches.js';
import { createOTPatches } from '../../src/client/factories.js';
import { providePatchesContext } from '../../src/vue/provider.js';
import { usePatchesDoc, usePatchesSync, providePatchesDoc, useCurrentDoc } from '../../src/vue/composables.js';
import { getDocManager } from '../../src/vue/doc-manager.js';
import type { PatchesSyncState } from '../../src/net/PatchesSync.js';

describe('Vue Composables', () => {
  let patches: Patches;

  beforeEach(() => {
    patches = createOTPatches();
  });

  afterEach(async () => {
    await patches.close();
  });

  describe('usePatchesDoc - static string', () => {
    it('should auto-open and return reactive document state', async () => {
      let capturedData: any;
      let capturedLoading: any;
      let capturedDoc: any;

      const TestComponent = defineComponent({
        setup() {
          const { data, loading, doc } = usePatchesDoc<any>('doc-1');
          capturedData = data;
          capturedLoading = loading;
          capturedDoc = doc;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      // Initially loading
      expect(capturedLoading.value).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(capturedDoc.value).toBeDefined();
      expect(capturedLoading.value).toBe(false);
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      app.unmount();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
    });

    it('should update reactively when document changes', async () => {
      let capturedData: any;

      const TestComponent = defineComponent({
        setup() {
          const { data } = usePatchesDoc<{ title?: string }>('doc-1');
          capturedData = data;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await new Promise(resolve => setTimeout(resolve, 10));

      const doc = patches.getOpenDoc<{ title?: string }>('doc-1')!;
      doc.change((patch, root) => {
        patch.replace(root.title!, 'Hello World');
      });

      await nextTick();
      expect(capturedData.value.title).toBe('Hello World');

      app.unmount();
    });

    it('should provide change helper', async () => {
      let capturedChange: any;
      let capturedData: any;

      const TestComponent = defineComponent({
        setup() {
          const { change, data } = usePatchesDoc<{ count?: number }>('doc-1');
          capturedChange = change;
          capturedData = data;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await new Promise(resolve => setTimeout(resolve, 10));

      capturedChange((patch: any, root: any) => {
        patch.replace(root.count!, 42);
      });

      await nextTick();
      expect(capturedData.value.count).toBe(42);

      app.unmount();
    });

    it('should use ref counting for multiple components', async () => {
      const Component1 = defineComponent({
        setup() {
          usePatchesDoc<any>('doc-1');
          return () => h('div');
        },
      });

      const Component2 = defineComponent({
        setup() {
          usePatchesDoc<any>('doc-1');
          return () => h('div');
        },
      });

      const ParentComponent = defineComponent({
        setup() {
          return () => h('div', [h(Component1), h(Component2)]);
        },
      });

      const app = createApp(ParentComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      app.unmount();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
    });

    it('should handle errors during open', async () => {
      let capturedError: any;
      let capturedLoading: any;

      vi.spyOn(patches, 'openDoc').mockRejectedValue(new Error('Open failed'));

      const TestComponent = defineComponent({
        setup() {
          const { error, loading } = usePatchesDoc<any>('bad-doc');
          capturedError = error;
          capturedLoading = loading;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(capturedError.value).toBeInstanceOf(Error);
      expect(capturedError.value.message).toBe('Open failed');
      expect(capturedLoading.value).toBe(false);

      app.unmount();
    });

    it('should no-op change before doc is loaded', () => {
      let capturedChange: any;

      const TestComponent = defineComponent({
        setup() {
          const { change } = usePatchesDoc<any>('doc-1');
          capturedChange = change;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      // Should not throw — doc not loaded yet
      expect(() => {
        capturedChange((patch: any, root: any) => {
          patch.replace(root.title!, 'test');
        });
      }).not.toThrow();

      app.unmount();
    });
  });

  describe('usePatchesDoc - untrack option', () => {
    it('should not untrack on close by default', async () => {
      const TestComponent = defineComponent({
        setup() {
          usePatchesDoc<any>('doc-1');
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await new Promise(resolve => setTimeout(resolve, 10));

      const manager = getDocManager(patches);
      const closeDocSpy = vi.spyOn(manager, 'closeDoc');

      app.unmount();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(closeDocSpy).toHaveBeenCalledWith(patches, 'doc-1', false);
    });

    it('should untrack on close with untrack: true', async () => {
      const TestComponent = defineComponent({
        setup() {
          usePatchesDoc<any>('doc-1', { untrack: true });
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await new Promise(resolve => setTimeout(resolve, 10));

      const manager = getDocManager(patches);
      const closeDocSpy = vi.spyOn(manager, 'closeDoc');

      app.unmount();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(closeDocSpy).toHaveBeenCalledWith(patches, 'doc-1', true);
    });
  });

  describe('usePatchesDoc - reactive mode', () => {
    it('should start with no doc when ref is null', () => {
      let capturedData: any;
      let capturedLoading: any;

      const docId = ref<string | null>(null);

      const TestComponent = defineComponent({
        setup() {
          const result = usePatchesDoc<any>(docId);
          capturedData = result.data;
          capturedLoading = result.loading;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      expect(capturedData.value).toBeUndefined();
      expect(capturedLoading.value).toBe(false);

      app.unmount();
    });

    it('should open a document when ref becomes non-null', async () => {
      const docId = ref<string | null>(null);
      let capturedDoc: any;

      const TestComponent = defineComponent({
        setup() {
          const result = usePatchesDoc<any>(docId);
          capturedDoc = result.doc;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      docId.value = 'doc-1';

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(capturedDoc.value).toBeDefined();
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      app.unmount();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
    });

    it('should close doc when ref becomes null', async () => {
      const docId = ref<string | null>('doc-1');
      let capturedData: any;

      const TestComponent = defineComponent({
        setup() {
          const result = usePatchesDoc<any>(docId);
          capturedData = result.data;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      docId.value = null;

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(capturedData.value).toBeUndefined();
      expect(patches.getOpenDoc('doc-1')).toBeUndefined();

      app.unmount();
    });

    it('should swap documents when ref changes', async () => {
      const docId = ref<string | null>('doc-1');

      const TestComponent = defineComponent({
        setup() {
          usePatchesDoc<any>(docId);
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      docId.value = 'doc-2';

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
      expect(patches.getOpenDoc('doc-2')).toBeDefined();

      app.unmount();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-2')).toBeUndefined();
    });

    it('should accept a getter function', async () => {
      const projectId = ref<string | null>('abc');
      let capturedDoc: any;

      const TestComponent = defineComponent({
        setup() {
          const result = usePatchesDoc<any>(() => projectId.value && `projects/${projectId.value}`);
          capturedDoc = result.doc;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(capturedDoc.value).toBeDefined();
      expect(patches.getOpenDoc('projects/abc')).toBeDefined();

      projectId.value = null;

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(capturedDoc.value).toBeUndefined();
      expect(patches.getOpenDoc('projects/abc')).toBeUndefined();

      app.unmount();
    });
  });

  describe('usePatchesSync', () => {
    it('should throw error if sync not provided', () => {
      const TestComponent = defineComponent({
        setup() {
          expect(() => usePatchesSync()).toThrow('PatchesSync not found in context');
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);
      app.unmount();
    });

    it('should return reactive sync state', () => {
      const mockSync = store<PatchesSyncState>({
        connected: true,
        syncStatus: 'syncing' as const,
        online: true,
      });

      let capturedConnected: any;
      let capturedSyncing: any;
      let capturedOnline: any;

      const TestComponent = defineComponent({
        setup() {
          const { connected, syncing, online } = usePatchesSync();
          capturedConnected = connected;
          capturedSyncing = syncing;
          capturedOnline = online;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches, mockSync as any);

      const el = document.createElement('div');
      app.mount(el);

      expect(capturedConnected.value).toBe(true);
      expect(capturedSyncing.value).toBe(true);
      expect(capturedOnline.value).toBe(true);

      app.unmount();
    });
  });

  describe('providePatchesDoc and useCurrentDoc', () => {
    it('should provide a document with static docId', async () => {
      let capturedData: any;
      let capturedChange: any;

      const TestComponent = defineComponent({
        setup() {
          const { data, change } = providePatchesDoc<any>('test', 'doc-1');
          capturedData = data;
          capturedChange = change;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));

      capturedChange((patch: any, root: any) => {
        patch.replace(root.title!, 'Test Title');
      });

      await nextTick();
      expect(capturedData.value.title).toBe('Test Title');

      app.unmount();
    });

    it('should throw if useCurrentDoc is called without provide', () => {
      const TestComponent = defineComponent({
        setup() {
          expect(() => useCurrentDoc('nonexistent')).toThrow('No document found for name "nonexistent"');
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);
      app.unmount();
    });

    it('should handle reactive docId changes', async () => {
      const docIdRef = ref('doc-1');

      const TestComponent = defineComponent({
        setup() {
          providePatchesDoc<any>('test', docIdRef);
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      docIdRef.value = 'doc-2';

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
      expect(patches.getOpenDoc('doc-2')).toBeDefined();

      app.unmount();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(patches.getOpenDoc('doc-2')).toBeUndefined();
    });

    it('should support multiple named contexts without collision', async () => {
      let capturedUserData: any;
      let capturedWorkspaceData: any;

      const TestComponent = defineComponent({
        setup() {
          const user = providePatchesDoc<any>('user', 'user-1');
          const workspace = providePatchesDoc<any>('workspace', 'workspace-1');
          capturedUserData = user.data;
          capturedWorkspaceData = workspace.data;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(capturedUserData).toBeDefined();
      expect(capturedWorkspaceData).toBeDefined();

      app.unmount();
    });

    it('should handle loading state in provided doc', async () => {
      let capturedLoading: any;

      const TestComponent = defineComponent({
        setup() {
          const { loading } = providePatchesDoc<any>('test', 'doc-1');
          capturedLoading = loading;
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);

      expect(capturedLoading.value).toBe(true);

      await nextTick();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(capturedLoading.value).toBe(false);

      app.unmount();
    });
  });
});

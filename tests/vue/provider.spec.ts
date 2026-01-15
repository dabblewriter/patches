import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import { Patches } from '../../src/client/Patches.js';
import { InMemoryStore } from '../../src/client/InMemoryStore.js';
import {
  providePatchesContext,
  providePatches,
  usePatchesContext,
  PATCHES_KEY,
  PATCHES_SYNC_KEY,
} from '../../src/vue/provider.js';

describe('Vue Provider', () => {
  let patches: Patches;
  let mockSync: any;

  beforeEach(() => {
    patches = new Patches({ store: new InMemoryStore() });
    mockSync = { state: { connected: false, syncing: null, online: true } };
  });

  describe('providePatchesContext', () => {
    it('should provide Patches instance at app level', () => {
      const TestComponent = defineComponent({
        setup() {
          const { patches: injectedPatches } = usePatchesContext();
          expect(injectedPatches).toBe(patches);
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      // Mount to trigger setup
      const el = document.createElement('div');
      app.mount(el);
      app.unmount();
    });

    it('should provide both Patches and PatchesSync', () => {
      const TestComponent = defineComponent({
        setup() {
          const { patches: injectedPatches, sync } = usePatchesContext();
          expect(injectedPatches).toBe(patches);
          expect(sync).toBe(mockSync);
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches, mockSync);

      const el = document.createElement('div');
      app.mount(el);
      app.unmount();
    });

    it('should work without PatchesSync', () => {
      const TestComponent = defineComponent({
        setup() {
          const { patches: injectedPatches, sync } = usePatchesContext();
          expect(injectedPatches).toBe(patches);
          expect(sync).toBeUndefined();
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);
      app.unmount();
    });
  });

  describe('providePatches', () => {
    it('should provide context from component setup', () => {
      const TestComponent = defineComponent({
        setup() {
          providePatches(patches, mockSync);
          return () => h('div');
        },
      });

      const ChildComponent = defineComponent({
        setup() {
          const { patches: injectedPatches, sync } = usePatchesContext();
          expect(injectedPatches).toBe(patches);
          expect(sync).toBe(mockSync);
          return () => h('div');
        },
      });

      const ParentComponent = defineComponent({
        setup() {
          return () => h(TestComponent, null, () => h(ChildComponent));
        },
      });

      const app = createApp(ParentComponent);
      const el = document.createElement('div');
      app.mount(el);
      app.unmount();
    });
  });

  describe('usePatchesContext', () => {
    it('should throw error if Patches not provided', () => {
      const TestComponent = defineComponent({
        setup() {
          expect(() => usePatchesContext()).toThrow(
            'Patches context not found. Did you forget to call providePatchesContext()'
          );
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      const el = document.createElement('div');
      app.mount(el);
      app.unmount();
    });

    it('should return patches from context', () => {
      const TestComponent = defineComponent({
        setup() {
          const { patches: injectedPatches } = usePatchesContext();
          expect(injectedPatches).toBe(patches);
          expect(injectedPatches).toBeInstanceOf(Patches);
          return () => h('div');
        },
      });

      const app = createApp(TestComponent);
      providePatchesContext(app, patches);

      const el = document.createElement('div');
      app.mount(el);
      app.unmount();
    });
  });

  describe('Injection keys', () => {
    it('should export unique symbol keys', () => {
      expect(PATCHES_KEY).toBeTypeOf('symbol');
      expect(PATCHES_SYNC_KEY).toBeTypeOf('symbol');
      expect(PATCHES_KEY).not.toBe(PATCHES_SYNC_KEY);
    });
  });
});

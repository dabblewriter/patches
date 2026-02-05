import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Patches } from '../../src/client/Patches.js';
import { createOTPatches } from '../../src/client/factories.js';
import { OTDoc } from '../../src/client/OTDoc.js';
import { DocManager, getDocManager } from '../../src/vue/doc-manager.js';

describe('DocManager', () => {
  let patches: Patches;
  let manager: DocManager;

  beforeEach(() => {
    patches = createOTPatches();
    manager = new DocManager();
  });

  afterEach(async () => {
    await patches.close();
  });

  describe('openDoc', () => {
    it('should open document on first call', async () => {
      const doc = await manager.openDoc(patches, 'doc-1');

      expect(doc).toBeInstanceOf(OTDoc);
      expect(manager.getRefCount('doc-1')).toBe(1);
    });

    it('should return same instance on second call', async () => {
      const doc1 = await manager.openDoc(patches, 'doc-1');
      const doc2 = await manager.openDoc(patches, 'doc-1');

      expect(doc1).toBe(doc2);
      expect(manager.getRefCount('doc-1')).toBe(2);
    });

    it('should increment ref count for each open', async () => {
      await manager.openDoc(patches, 'doc-1');
      expect(manager.getRefCount('doc-1')).toBe(1);

      await manager.openDoc(patches, 'doc-1');
      expect(manager.getRefCount('doc-1')).toBe(2);

      await manager.openDoc(patches, 'doc-1');
      expect(manager.getRefCount('doc-1')).toBe(3);
    });

    it('should handle concurrent opens to same doc', async () => {
      const [doc1, doc2, doc3] = await Promise.all([
        manager.openDoc(patches, 'doc-1'),
        manager.openDoc(patches, 'doc-1'),
        manager.openDoc(patches, 'doc-1'),
      ]);

      expect(doc1).toBe(doc2);
      expect(doc2).toBe(doc3);
      expect(manager.getRefCount('doc-1')).toBe(3);
    });

    it('should handle concurrent opens to different docs', async () => {
      const [doc1, doc2, doc3] = await Promise.all([
        manager.openDoc(patches, 'doc-1'),
        manager.openDoc(patches, 'doc-2'),
        manager.openDoc(patches, 'doc-3'),
      ]);

      expect(doc1).not.toBe(doc2);
      expect(doc2).not.toBe(doc3);
      expect(manager.getRefCount('doc-1')).toBe(1);
      expect(manager.getRefCount('doc-2')).toBe(1);
      expect(manager.getRefCount('doc-3')).toBe(1);
    });

    it('should not increment ref count on failed open', async () => {
      // Create a doc that will fail to open
      const badPatches = createOTPatches();
      vi.spyOn(badPatches, 'openDoc').mockRejectedValue(new Error('Open failed'));

      await expect(manager.openDoc(badPatches, 'bad-doc')).rejects.toThrow('Open failed');
      expect(manager.getRefCount('bad-doc')).toBe(0);
    });
  });

  describe('closeDoc', () => {
    it('should decrement ref count', async () => {
      await manager.openDoc(patches, 'doc-1');
      await manager.openDoc(patches, 'doc-1');

      await manager.closeDoc(patches, 'doc-1');
      expect(manager.getRefCount('doc-1')).toBe(1);
    });

    it('should actually close doc when ref count reaches zero', async () => {
      await manager.openDoc(patches, 'doc-1');

      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      await manager.closeDoc(patches, 'doc-1');

      expect(manager.getRefCount('doc-1')).toBe(0);
      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
    });

    it('should not close doc while other references exist', async () => {
      await manager.openDoc(patches, 'doc-1');
      await manager.openDoc(patches, 'doc-1');

      await manager.closeDoc(patches, 'doc-1');

      expect(patches.getOpenDoc('doc-1')).toBeDefined();
      expect(manager.getRefCount('doc-1')).toBe(1);
    });

    it('should handle closing unopened doc gracefully', async () => {
      await expect(manager.closeDoc(patches, 'never-opened')).resolves.toBeUndefined();
      expect(manager.getRefCount('never-opened')).toBe(0);
    });

    it('should handle multiple closes of same doc', async () => {
      await manager.openDoc(patches, 'doc-1');
      await manager.closeDoc(patches, 'doc-1');

      // Second close should be a no-op
      await expect(manager.closeDoc(patches, 'doc-1')).resolves.toBeUndefined();
      expect(manager.getRefCount('doc-1')).toBe(0);
    });

    it('should handle full open/close lifecycle', async () => {
      // Open 3 times
      const doc1 = await manager.openDoc(patches, 'doc-1');
      const doc2 = await manager.openDoc(patches, 'doc-1');
      const doc3 = await manager.openDoc(patches, 'doc-1');

      expect(doc1).toBe(doc2);
      expect(doc2).toBe(doc3);
      expect(manager.getRefCount('doc-1')).toBe(3);
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      // Close 2 times - should still be open
      await manager.closeDoc(patches, 'doc-1');
      await manager.closeDoc(patches, 'doc-1');

      expect(manager.getRefCount('doc-1')).toBe(1);
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      // Close last time - should actually close
      await manager.closeDoc(patches, 'doc-1');

      expect(manager.getRefCount('doc-1')).toBe(0);
      expect(patches.getOpenDoc('doc-1')).toBeUndefined();
    });
  });

  describe('getRefCount', () => {
    it('should return 0 for unopened doc', () => {
      expect(manager.getRefCount('never-opened')).toBe(0);
    });

    it('should return current ref count', async () => {
      await manager.openDoc(patches, 'doc-1');
      expect(manager.getRefCount('doc-1')).toBe(1);

      await manager.openDoc(patches, 'doc-1');
      expect(manager.getRefCount('doc-1')).toBe(2);
    });
  });

  describe('reset', () => {
    it('should clear all ref counts', async () => {
      await manager.openDoc(patches, 'doc-1');
      await manager.openDoc(patches, 'doc-2');

      manager.reset();

      expect(manager.getRefCount('doc-1')).toBe(0);
      expect(manager.getRefCount('doc-2')).toBe(0);
    });

    it('should not close actual documents', async () => {
      await manager.openDoc(patches, 'doc-1');
      expect(patches.getOpenDoc('doc-1')).toBeDefined();

      manager.reset();

      // Doc still open in Patches, just ref count cleared
      expect(patches.getOpenDoc('doc-1')).toBeDefined();
    });
  });

  describe('getDocManager', () => {
    it('should return singleton manager per Patches instance', () => {
      const manager1 = getDocManager(patches);
      const manager2 = getDocManager(patches);

      expect(manager1).toBe(manager2);
    });

    it('should return different managers for different Patches instances', () => {
      const patches1 = createOTPatches();
      const patches2 = createOTPatches();

      const manager1 = getDocManager(patches1);
      const manager2 = getDocManager(patches2);

      expect(manager1).not.toBe(manager2);
    });

    it('should create new manager on first call', () => {
      const manager = getDocManager(patches);
      expect(manager).toBeInstanceOf(DocManager);
    });
  });
});

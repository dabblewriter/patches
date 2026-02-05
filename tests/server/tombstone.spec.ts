import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTombstoneIfSupported, isTombstoneStore, removeTombstoneIfExists } from '../../src/server/tombstone';
import type { ServerStoreBackend, TombstoneStoreBackend } from '../../src/server/types';

describe('tombstone utilities', () => {
  describe('isTombstoneStore', () => {
    it('should return true for store with all tombstone methods', () => {
      const store = {
        deleteDoc: vi.fn(),
        createTombstone: vi.fn(),
        getTombstone: vi.fn(),
        removeTombstone: vi.fn(),
      } as ServerStoreBackend & TombstoneStoreBackend;

      expect(isTombstoneStore(store)).toBe(true);
    });

    it('should return false for store without tombstone methods', () => {
      const store = {
        deleteDoc: vi.fn(),
      } as ServerStoreBackend;

      expect(isTombstoneStore(store)).toBe(false);
    });

    it('should return false for store with only some tombstone methods', () => {
      const store = {
        deleteDoc: vi.fn(),
        createTombstone: vi.fn(),
        // missing getTombstone and removeTombstone
      } as any;

      expect(isTombstoneStore(store)).toBe(false);
    });
  });

  describe('createTombstoneIfSupported', () => {
    let tombstoneStore: ServerStoreBackend & TombstoneStoreBackend;
    let basicStore: ServerStoreBackend;

    beforeEach(() => {
      tombstoneStore = {
        deleteDoc: vi.fn(),
        createTombstone: vi.fn(),
        getTombstone: vi.fn(),
        removeTombstone: vi.fn(),
      };

      basicStore = {
        deleteDoc: vi.fn(),
      };
    });

    it('should create tombstone when store supports it', async () => {
      const result = await createTombstoneIfSupported(tombstoneStore, 'doc1', 5, 'client1');

      expect(result).toBe(true);
      expect(tombstoneStore.createTombstone).toHaveBeenCalledWith({
        docId: 'doc1',
        deletedAt: expect.any(Number),
        lastRev: 5,
        deletedByClientId: 'client1',
      });
    });

    it('should return false when store does not support tombstones', async () => {
      const result = await createTombstoneIfSupported(basicStore, 'doc1', 5, 'client1');

      expect(result).toBe(false);
    });

    it('should skip tombstone when skipTombstone is true', async () => {
      const result = await createTombstoneIfSupported(tombstoneStore, 'doc1', 5, 'client1', true);

      expect(result).toBe(false);
      expect(tombstoneStore.createTombstone).not.toHaveBeenCalled();
    });

    it('should work without clientId', async () => {
      const result = await createTombstoneIfSupported(tombstoneStore, 'doc1', 5);

      expect(result).toBe(true);
      expect(tombstoneStore.createTombstone).toHaveBeenCalledWith({
        docId: 'doc1',
        deletedAt: expect.any(Number),
        lastRev: 5,
        deletedByClientId: undefined,
      });
    });
  });

  describe('removeTombstoneIfExists', () => {
    let tombstoneStore: ServerStoreBackend & TombstoneStoreBackend;
    let basicStore: ServerStoreBackend;

    beforeEach(() => {
      tombstoneStore = {
        deleteDoc: vi.fn(),
        createTombstone: vi.fn(),
        getTombstone: vi.fn(),
        removeTombstone: vi.fn(),
      };

      basicStore = {
        deleteDoc: vi.fn(),
      };
    });

    it('should remove tombstone when it exists', async () => {
      vi.mocked(tombstoneStore.getTombstone).mockResolvedValue({
        docId: 'doc1',
        deletedAt: Date.now(),
        lastRev: 5,
      });

      const result = await removeTombstoneIfExists(tombstoneStore, 'doc1');

      expect(result).toBe(true);
      expect(tombstoneStore.getTombstone).toHaveBeenCalledWith('doc1');
      expect(tombstoneStore.removeTombstone).toHaveBeenCalledWith('doc1');
    });

    it('should return false when tombstone does not exist', async () => {
      vi.mocked(tombstoneStore.getTombstone).mockResolvedValue(undefined);

      const result = await removeTombstoneIfExists(tombstoneStore, 'doc1');

      expect(result).toBe(false);
      expect(tombstoneStore.getTombstone).toHaveBeenCalledWith('doc1');
      expect(tombstoneStore.removeTombstone).not.toHaveBeenCalled();
    });

    it('should return false when store does not support tombstones', async () => {
      const result = await removeTombstoneIfExists(basicStore, 'doc1');

      expect(result).toBe(false);
    });
  });
});

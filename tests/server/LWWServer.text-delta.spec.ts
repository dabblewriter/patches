import { Delta } from '@dabble/delta';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthContext, setAuthContext } from '../../src/net/serverContext';
import { LWWServer } from '../../src/server/LWWServer';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend';
import type { ChangeInput } from '../../src/types';

describe('LWWServer - @txt rich text support', () => {
  let store: LWWMemoryStoreBackend;
  let server: LWWServer;

  beforeEach(() => {
    store = new LWWMemoryStoreBackend();
    server = new LWWServer(store);
    vi.clearAllMocks();
  });

  describe('commitChanges with @txt', () => {
    it('should store @txt as composed text in field store', async () => {
      const change: ChangeInput = {
        id: 'txt1',
        ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
      };

      await server.commitChanges('doc1', [change]);

      // Field store should have the composed text value
      const ops = await store.listOps('doc1');
      const bodyOp = ops.find(op => op.path === '/body');
      expect(bodyOp).toBeDefined();
      // The stored value should represent the composed delta (contains "hello")
      const delta = new Delta(bodyOp!.value);
      const text = delta.ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');
      expect(text).toContain('hello');
    });

    it('should append delta to text delta log', async () => {
      const change: ChangeInput = {
        id: 'txt2',
        ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
      };

      const result = await server.commitChanges('doc1', [change]);
      const newRev = result[0].rev;

      // Delta log should have the entry
      const deltas = await store.getTextDeltasSince('doc1', '/body', 0);
      expect(deltas).toHaveLength(1);
      expect(deltas[0].path).toBe('/body');
      expect(deltas[0].rev).toBe(newRev);
    });

    it('should transform @txt against concurrent server deltas', async () => {
      // First commit: insert "hello"
      await server.commitChanges('doc1', [
        {
          id: 'txt3a',
          ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
        },
      ]);

      // Second commit from a client at rev 0 (didn't see the first)
      // This inserts "world" - but since it's based on empty text, needs transform
      const result = await server.commitChanges('doc1', [
        {
          id: 'txt3b',
          baseRev: 0,
          rev: 0,
          ops: [{ op: '@txt', path: '/body', value: [{ insert: 'world' }], ts: 2000 }],
        },
      ]);

      expect(result).toHaveLength(1);

      // The final state should contain both insertions
      const { state } = await server.getDoc('doc1');
      const bodyDelta = new Delta(state.body);
      const text = bodyDelta.ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');
      // Both "hello" and "world" should be present (order depends on transform priority)
      expect(text).toContain('hello');
      expect(text).toContain('world');
    });

    it('should handle mixed @txt and non-@txt ops in same change', async () => {
      const change: ChangeInput = {
        id: 'mixed1',
        ops: [
          { op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 },
          { op: 'replace', path: '/title', value: 'My Doc', ts: 1000 },
        ],
      };

      await server.commitChanges('doc1', [change]);

      const { state } = await server.getDoc('doc1');
      expect(state.title).toBe('My Doc');
      // body should have the delta
      expect(state.body).toBeDefined();
    });

    it('should compose sequential @txt on same field', async () => {
      // First edit
      await server.commitChanges('doc1', [
        {
          id: 'seq1',
          ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
        },
      ]);

      // Second edit (from same client, knows about first)
      const currentRev = await store.getCurrentRev('doc1');
      await server.commitChanges('doc1', [
        {
          id: 'seq2',
          baseRev: currentRev,
          rev: currentRev,
          ops: [{ op: '@txt', path: '/body', value: [{ retain: 5 }, { insert: ' world' }], ts: 2000 }],
        },
      ]);

      const { state } = await server.getDoc('doc1');
      const bodyDelta = new Delta(state.body);
      const text = bodyDelta.ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');
      expect(text).toContain('hello world');
    });

    it('should broadcast @txt ops (not replace) to other clients', async () => {
      const emitSpy = vi.spyOn(server.onChangesCommitted, 'emit').mockResolvedValue();

      setAuthContext({ clientId: 'client1', metadata: {} });
      try {
        await server.commitChanges('doc1', [
          {
            id: 'broadcast1',
            ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
          },
        ]);

        expect(emitSpy).toHaveBeenCalled();
        const broadcastChanges = emitSpy.mock.calls[0][1] as any[];
        const broadcastOps = broadcastChanges[0].ops;
        // Should broadcast @txt op, not replace
        expect(broadcastOps.some((op: any) => op.op === '@txt' && op.path === '/body')).toBe(true);
      } finally {
        clearAuthContext();
        emitSpy.mockRestore();
      }
    });

    it('should handle @txt on multiple different paths', async () => {
      const change: ChangeInput = {
        id: 'multi1',
        ops: [
          { op: '@txt', path: '/body', value: [{ insert: 'body content' }], ts: 1000 },
          { op: '@txt', path: '/title', value: [{ insert: 'My Title' }], ts: 1000 },
        ],
      };

      await server.commitChanges('doc1', [change]);

      const { state } = await server.getDoc('doc1');
      expect(state.body).toBeDefined();
      expect(state.title).toBeDefined();

      // Both should have delta log entries
      const bodyDeltas = await store.getTextDeltasSince('doc1', '/body', 0);
      const titleDeltas = await store.getTextDeltasSince('doc1', '/title', 0);
      expect(bodyDeltas).toHaveLength(1);
      expect(titleDeltas).toHaveLength(1);
    });
  });

  describe('getChangesSince with @txt', () => {
    it('should return composed text deltas instead of full text', async () => {
      // Make two text edits
      await server.commitChanges('doc1', [
        {
          id: 'gc1',
          ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
        },
      ]);

      const rev1 = await store.getCurrentRev('doc1');

      await server.commitChanges('doc1', [
        {
          id: 'gc2',
          baseRev: rev1,
          rev: rev1,
          ops: [{ op: '@txt', path: '/body', value: [{ retain: 5 }, { insert: ' world' }], ts: 2000 }],
        },
      ]);

      // Get changes since rev 0 - should get composed text deltas
      const changes = await server.getChangesSince('doc1', 0);
      expect(changes).toHaveLength(1);

      // Should contain @txt op, not replace
      const textOp = changes[0].ops.find((op: any) => op.path === '/body');
      expect(textOp).toBeDefined();
      expect(textOp!.op).toBe('@txt');
    });

    it('should include both text and non-text ops', async () => {
      await server.commitChanges('doc1', [
        {
          id: 'gc3',
          ops: [
            { op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 },
            { op: 'replace', path: '/title', value: 'My Doc', ts: 1000 },
          ],
        },
      ]);

      const changes = await server.getChangesSince('doc1', 0);
      expect(changes[0].ops).toHaveLength(2);
    });

    it('should return empty when no changes since rev', async () => {
      const changes = await server.getChangesSince('doc1', 0);
      expect(changes).toHaveLength(0);
    });

    it('should return composed delta for partial catchup', async () => {
      // First edit
      await server.commitChanges('doc1', [
        {
          id: 'partial1',
          ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
        },
      ]);

      const rev1 = await store.getCurrentRev('doc1');

      // Second edit
      await server.commitChanges('doc1', [
        {
          id: 'partial2',
          baseRev: rev1,
          rev: rev1,
          ops: [{ op: '@txt', path: '/body', value: [{ retain: 5 }, { insert: ' world' }], ts: 2000 }],
        },
      ]);

      // Client already has rev1, get only changes since rev1
      const changes = await server.getChangesSince('doc1', rev1);
      expect(changes).toHaveLength(1);

      // Should only contain the second delta (not the full text)
      const textOp = changes[0].ops.find((op: any) => op.path === '/body');
      expect(textOp).toBeDefined();
      expect(textOp!.op).toBe('@txt');
    });
  });

  describe('text field deletion', () => {
    it('should clean up delta log when text field is overwritten by replace', async () => {
      // Create text field
      await server.commitChanges('doc1', [
        {
          id: 'del1',
          ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
        },
      ]);

      // Verify delta log has entry
      let deltas = await store.getAllTextDeltasSince('doc1', 0);
      expect(deltas.length).toBeGreaterThan(0);

      // Overwrite text field with plain replace
      const currentRev = await store.getCurrentRev('doc1');
      await server.commitChanges('doc1', [
        {
          id: 'del2',
          baseRev: currentRev,
          rev: currentRev,
          ops: [{ op: 'replace', path: '/body', value: 'plain text', ts: 2000 }],
        },
      ]);

      // Delta log for /body should be cleaned up
      deltas = await store.getTextDeltasSince('doc1', '/body', 0);
      expect(deltas).toHaveLength(0);
    });

    it('should clean up delta log when parent path is overwritten', async () => {
      // Create text field at /content/body
      await server.commitChanges('doc1', [
        {
          id: 'del3',
          ops: [{ op: '@txt', path: '/content/body', value: [{ insert: 'hello' }], ts: 1000 }],
        },
      ]);

      // Overwrite /content entirely
      const currentRev = await store.getCurrentRev('doc1');
      await server.commitChanges('doc1', [
        {
          id: 'del4',
          baseRev: currentRev,
          rev: currentRev,
          ops: [{ op: 'replace', path: '/content', value: { title: 'new' }, ts: 2000 }],
        },
      ]);

      // Delta log for /content/body should be cleaned up
      const deltas = await store.getTextDeltasSince('doc1', '/content/body', 0);
      expect(deltas).toHaveLength(0);
    });
  });

  describe('compaction with @txt', () => {
    it('should prune text deltas after snapshot', async () => {
      const serverWith5 = new LWWServer(store, { snapshotInterval: 5 });

      // Create 5 text edits to trigger compaction
      for (let i = 0; i < 5; i++) {
        const currentRev = await store.getCurrentRev('doc1');
        await serverWith5.commitChanges('doc1', [
          {
            id: `compact${i}`,
            baseRev: currentRev,
            rev: currentRev,
            ops: [{ op: '@txt', path: '/body', value: [{ insert: `text${i}` }], ts: 1000 + i }],
          },
        ]);
      }

      // After compaction, delta log should be pruned
      const deltas = await store.getAllTextDeltasSince('doc1', 0);
      // All deltas up to snapshot rev should be pruned
      expect(deltas).toHaveLength(0);
    });
  });

  describe('fallback without TextDeltaStoreBackend', () => {
    it('should treat @txt as regular LWW when store lacks text delta support', async () => {
      // Create a store that does NOT implement TextDeltaStoreBackend
      const basicStore = {
        getCurrentRev: vi.fn(async () => 0),
        getSnapshot: vi.fn(async () => null),
        saveSnapshot: vi.fn(async () => {}),
        listOps: vi.fn(async () => []),
        saveOps: vi.fn(async (_docId: string, _ops: any[]) => {
          return 1; // Return new rev
        }),
        deleteDoc: vi.fn(async () => {}),
      };

      const basicServer = new LWWServer(basicStore);

      const change: ChangeInput = {
        id: 'fallback1',
        ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
      };

      // Should not throw - @txt treated as regular op through consolidateOps
      await basicServer.commitChanges('doc1', [change]);

      // saveOps should have been called (op goes through normal LWW path)
      expect(basicStore.saveOps).toHaveBeenCalled();
    });
  });

  describe('concurrent @txt edits from multiple clients', () => {
    it('should correctly merge three concurrent text edits', async () => {
      // Client A inserts "hello" at the beginning
      await server.commitChanges('doc1', [
        {
          id: 'concurrent1',
          ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 }],
        },
      ]);

      const rev1 = await store.getCurrentRev('doc1');

      // Client B (at rev1) inserts " world" after "hello"
      await server.commitChanges('doc1', [
        {
          id: 'concurrent2',
          baseRev: rev1,
          rev: rev1,
          ops: [{ op: '@txt', path: '/body', value: [{ retain: 5 }, { insert: ' world' }], ts: 2000 }],
        },
      ]);

      // Client C (also at rev1, hasn't seen client B's edit) inserts "!" after "hello"
      await server.commitChanges('doc1', [
        {
          id: 'concurrent3',
          baseRev: rev1,
          rev: rev1,
          ops: [{ op: '@txt', path: '/body', value: [{ retain: 5 }, { insert: '!' }], ts: 3000 }],
        },
      ]);

      const { state } = await server.getDoc('doc1');
      const bodyDelta = new Delta(state.body);
      const text = bodyDelta.ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');

      // All three insertions should be present
      expect(text).toContain('hello');
      expect(text).toContain(' world');
      expect(text).toContain('!');
    });

    it('should handle delete operations in @txt deltas', async () => {
      // First: insert "hello world"
      await server.commitChanges('doc1', [
        {
          id: 'delop1',
          ops: [{ op: '@txt', path: '/body', value: [{ insert: 'hello world' }], ts: 1000 }],
        },
      ]);

      const rev1 = await store.getCurrentRev('doc1');

      // Client deletes " world" (retain 5, delete 6)
      await server.commitChanges('doc1', [
        {
          id: 'delop2',
          baseRev: rev1,
          rev: rev1,
          ops: [{ op: '@txt', path: '/body', value: [{ retain: 5 }, { delete: 6 }], ts: 2000 }],
        },
      ]);

      const { state } = await server.getDoc('doc1');
      const bodyDelta = new Delta(state.body);
      const text = bodyDelta.ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');
      // "hello world" -> retain 5 delete 6 -> "hello" + newline from base
      expect(text).toContain('hello');
      expect(text).not.toContain('world');
    });
  });

  describe('getDoc state reconstruction with @txt', () => {
    it('should reconstruct state correctly with text fields', async () => {
      await server.commitChanges('doc1', [
        {
          id: 'state1',
          ops: [
            { op: '@txt', path: '/body', value: [{ insert: 'hello' }], ts: 1000 },
            { op: 'replace', path: '/title', value: 'My Doc', ts: 1000 },
          ],
        },
      ]);

      const { state, rev } = await server.getDoc('doc1');
      expect(rev).toBeGreaterThan(0);
      expect(state.title).toBe('My Doc');
      expect(state.body).toBeDefined();

      // The body should contain the composed text
      const bodyDelta = new Delta(state.body);
      const text = bodyDelta.ops.map((op: any) => (typeof op.insert === 'string' ? op.insert : '')).join('');
      expect(text).toContain('hello');
    });

    it('should return empty state for nonexistent doc', async () => {
      const { state, rev } = await server.getDoc('nonexistent');
      expect(state).toEqual({});
      expect(rev).toBe(0);
    });
  });
});

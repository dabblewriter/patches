/**
 * LWW Integration Tests
 *
 * End-to-end tests that verify the full LWW flow works correctly:
 * Client changes → LWWAlgorithm consolidates → Server commits → Client receives
 *
 * These tests use real implementations (not mocks) for all core components:
 * - LWWAlgorithm (client)
 * - LWWInMemoryStore (client storage)
 * - LWWServer (server)
 * - LWWMemoryStoreBackend (server storage)
 *
 * Only the transport layer is simulated with direct function calls.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm.js';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore.js';
import { LWWDoc } from '../../src/client/LWWDoc.js';
import { LWWServer } from '../../src/server/LWWServer.js';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend.js';
import type { Change } from '../../src/types.js';
import type { JSONPatchOp } from '../../src/json-patch/types.js';

interface TestDoc {
  title?: string;
  count?: number;
  status?: string;
  nested?: { value?: number };
}

/**
 * Test harness that wires up LWW clients to a server.
 * Simulates network communication with direct function calls.
 */
class LWWTestHarness {
  server: LWWServer;
  serverStore: LWWMemoryStoreBackend;
  clients: Map<string, { algorithm: LWWAlgorithm; store: LWWInMemoryStore; doc: LWWDoc<TestDoc> }> = new Map();
  lastBroadcast: { docId: string; changes: Change[] } | null = null;

  getBroadcastChanges(): Change[] {
    return this.lastBroadcast?.changes ?? [];
  }

  constructor() {
    this.serverStore = new LWWMemoryStoreBackend();
    this.server = new LWWServer(this.serverStore);

    // Capture broadcast changes for distribution to other clients
    this.server.onChangesCommitted((docId, changes) => {
      this.lastBroadcast = { docId, changes };
    });
  }

  /**
   * Create a new client connected to the server.
   */
  createClient(clientId: string, docId: string, initialState: TestDoc = {}): LWWDoc<TestDoc> {
    const store = new LWWInMemoryStore();
    const algorithm = new LWWAlgorithm(store);
    const doc = algorithm.createDoc<TestDoc>(docId, { state: initialState, rev: 0, changes: [] }) as LWWDoc<TestDoc>;

    this.clients.set(clientId, { algorithm, store, doc });
    return doc;
  }

  /**
   * Get client's algorithm by client ID.
   */
  getAlgorithm(clientId: string): LWWAlgorithm {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client ${clientId} not found`);
    return client.algorithm;
  }

  /**
   * Get client's doc by client ID.
   */
  getDoc(clientId: string): LWWDoc<TestDoc> {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client ${clientId} not found`);
    return client.doc;
  }

  /**
   * Make a change on a client and process it through the algorithm.
   * Returns the uncommitted changes.
   */
  async makeChange(
    clientId: string,
    mutator: (doc: LWWDoc<TestDoc>) => void
  ): Promise<{ ops: JSONPatchOp[]; changes: Change[] }> {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client ${clientId} not found`);

    const { algorithm, doc } = client;
    const docId = doc.id;

    // Capture ops emitted by doc.change()
    let emittedOps: JSONPatchOp[] = [];
    const unsubscribe = doc.onChange(ops => {
      emittedOps = ops;
    });

    // Make the change
    mutator(doc);
    unsubscribe();

    if (emittedOps.length === 0) {
      return { ops: [], changes: [] };
    }

    // Process through algorithm
    const changes = await algorithm.handleDocChange(docId, emittedOps, doc, {});
    return { ops: emittedOps, changes };
  }

  /**
   * Send pending changes from client to server.
   * Returns the broadcast change (for other clients) and applies the server response to the sender.
   */
  async sendToServer(clientId: string): Promise<Change[]> {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client ${clientId} not found`);

    const { algorithm, doc } = client;
    const docId = doc.id;

    // Get pending changes to send
    const pendingChanges = await algorithm.getPendingToSend(docId);
    if (!pendingChanges || pendingChanges.length === 0) {
      return [];
    }

    // Clear last broadcast
    this.lastBroadcast = null;

    // Server commits the changes - this triggers onChangesCommitted
    const responseChanges = await this.server.commitChanges(docId, pendingChanges);

    // Confirm sent to client
    await algorithm.confirmSent(docId, responseChanges);

    // Apply server response to sending client (updates committedRev, applies catchup ops)
    await algorithm.applyServerChanges(docId, responseChanges, doc);

    // Return the broadcast change (contains the actual committed ops)
    // This is what should be sent to OTHER clients
    return this.getBroadcastChanges();
  }

  /**
   * Apply server changes to a client (simulates receiving broadcast).
   */
  async receiveFromServer(clientId: string, changes: Change[]): Promise<Change[]> {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client ${clientId} not found`);

    const { algorithm, doc } = client;
    return algorithm.applyServerChanges(doc.id, changes, doc);
  }

  /**
   * Full round-trip: make change, send to server.
   * Note: The sending client doesn't need to receive their own broadcast -
   * they already applied the change locally in makeChange/handleDocChange.
   */
  async roundTrip(clientId: string, mutator: (doc: LWWDoc<TestDoc>) => void): Promise<{ committed: Change[] }> {
    await this.makeChange(clientId, mutator);
    const committed = await this.sendToServer(clientId);
    return { committed };
  }
}

describe('LWW Integration', () => {
  let harness: LWWTestHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
    harness = new LWWTestHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic round-trip', () => {
    it('should commit a simple change and receive confirmation', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { title: 'Hello' });

      // Make a change
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'World');
        });
      });

      // Doc should show pending state
      expect(doc.state.title).toBe('World');
      expect(doc.hasPending).toBe(true);

      // Send to server
      const committed = await harness.sendToServer('clientA');
      expect(committed).toHaveLength(1);
      expect(committed[0].committedAt).toBeGreaterThan(0);

      // Receive server confirmation
      await harness.receiveFromServer('clientA', committed);

      // Doc should show committed state
      expect(doc.state.title).toBe('World');
      expect(doc.committedRev).toBe(committed[0].rev);
      expect(doc.hasPending).toBe(false);
    });

    it('should handle multiple changes in sequence', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { title: 'One', count: 1 });

      // First change
      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'Two');
        });
      });

      expect(doc.state.title).toBe('Two');
      expect(doc.committedRev).toBe(1);

      // Second change
      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.count, 2);
        });
      });

      expect(doc.state).toEqual({ title: 'Two', count: 2 });
      expect(doc.committedRev).toBe(2);
    });

    it('should handle adding new fields', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { title: 'Test' });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.add((path as any).status, 'active');
        });
      });

      expect(doc.state.status).toBe('active');
      expect(doc.committedRev).toBe(1);
    });

    it('should handle removing fields', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { title: 'Test', status: 'active' });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.remove(path.status);
        });
      });

      expect(doc.state.status).toBeUndefined();
      expect(doc.committedRev).toBe(1);
    });
  });

  describe('concurrent changes to different fields', () => {
    it('should allow both clients to succeed when changing different fields', async () => {
      const docId = 'doc1';
      const docA = harness.createClient('clientA', docId, { title: 'Hello', count: 0 });
      const docB = harness.createClient('clientB', docId, { title: 'Hello', count: 0 });

      // Client A changes title
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'World');
        });
      });

      // Client B changes count
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientB', d => {
        d.change((patch, path) => {
          patch.replace(path.count, 5);
        });
      });

      // Both send to server
      const committedA = await harness.sendToServer('clientA');
      const committedB = await harness.sendToServer('clientB');

      // Both should succeed
      expect(committedA).toHaveLength(1);
      expect(committedB).toHaveLength(1);

      // Cross-apply changes
      await harness.receiveFromServer('clientA', committedA);
      await harness.receiveFromServer('clientA', committedB);
      await harness.receiveFromServer('clientB', committedA);
      await harness.receiveFromServer('clientB', committedB);

      // Both clients should have same final state
      expect(docA.state).toEqual({ title: 'World', count: 5 });
      expect(docB.state).toEqual({ title: 'World', count: 5 });
    });
  });

  describe('same-field conflict resolution', () => {
    it('should resolve conflicts with timestamp-higher wins', async () => {
      const docId = 'doc1';
      const docA = harness.createClient('clientA', docId, { title: 'Original' });
      const docB = harness.createClient('clientB', docId, { title: 'Original' });

      // Client A changes title at time 1000
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'From A');
        });
      });

      // Client B changes title at time 2000 (later timestamp)
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientB', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'From B');
        });
      });

      // Client A sends first
      const committedA = await harness.sendToServer('clientA');
      expect(committedA).toHaveLength(1);

      // Client B sends second - B should win because of higher timestamp
      const committedB = await harness.sendToServer('clientB');
      expect(committedB).toHaveLength(1);

      // Apply all changes to both clients
      await harness.receiveFromServer('clientA', committedA);
      await harness.receiveFromServer('clientA', committedB);
      await harness.receiveFromServer('clientB', committedA);
      await harness.receiveFromServer('clientB', committedB);

      // Both should have B's value (higher timestamp wins)
      expect(docA.state.title).toBe('From B');
      expect(docB.state.title).toBe('From B');
    });

    it('should keep earlier value when later client sends first', async () => {
      const docId = 'doc1';
      const docA = harness.createClient('clientA', docId, { title: 'Original' });
      const docB = harness.createClient('clientB', docId, { title: 'Original' });

      // Client A changes title at time 2000 (later)
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'From A (later)');
        });
      });

      // Client B changes title at time 1000 (earlier)
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientB', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'From B (earlier)');
        });
      });

      // B sends first (even though it has earlier timestamp)
      const committedB = await harness.sendToServer('clientB');

      // A sends second - A should win because of higher timestamp
      const committedA = await harness.sendToServer('clientA');

      // Apply all changes
      await harness.receiveFromServer('clientA', committedB);
      await harness.receiveFromServer('clientA', committedA);
      await harness.receiveFromServer('clientB', committedB);
      await harness.receiveFromServer('clientB', committedA);

      // Both should have A's value (higher timestamp wins regardless of send order)
      expect(docA.state.title).toBe('From A (later)');
      expect(docB.state.title).toBe('From A (later)');
    });
  });

  describe('delta operations (combinable ops)', () => {
    it('should combine @inc operations', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { count: 10 });

      // Increment multiple times before sending
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.increment('/count', 5);
        });
      });

      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.increment('/count', 3);
        });
      });

      // Local state should reflect both increments
      expect(doc.state.count).toBe(18); // 10 + 5 + 3

      // Send to server - ops should be consolidated
      const broadcast = await harness.sendToServer('clientA');
      expect(broadcast).toHaveLength(1);

      // The broadcast contains converted replace ops (delta ops become concrete values)
      // Since initial was 0 (no previous value on server), @inc 8 → replace 8
      const ops = broadcast[0].ops;
      expect(ops).toHaveLength(1);
      expect(ops[0].op).toBe('replace');
      expect(ops[0].value).toBe(8); // Delta applied to 0 = 8

      // After sending, client's state should still be 18 (local state preserved)
      // The sending client already applied changes locally, doesn't need broadcast
      expect(doc.state.count).toBe(18);
      expect(doc.committedRev).toBe(1);
    });

    it('should combine @max operations', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { count: 10 });

      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.max('/count', 15);
        });
      });

      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.max('/count', 12);
        });
      });

      // Local state should reflect max
      expect(doc.state.count).toBe(15); // max(10, 15, 12)

      const committed = await harness.sendToServer('clientA');
      const ops = committed[0].ops;
      expect(ops[0].value).toBe(15); // max of 15 and 12

      await harness.receiveFromServer('clientA', committed);
      expect(doc.state.count).toBe(15);
    });

    it('should combine @min operations', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { count: 10 });

      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.min('/count', 5);
        });
      });

      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.min('/count', 8);
        });
      });

      // Local state should reflect min
      expect(doc.state.count).toBe(5); // min(10, 5, 8)

      const broadcast = await harness.sendToServer('clientA');
      const ops = broadcast[0].ops;
      // The broadcast contains converted replace ops
      // @min combines to min(5, 8) = 5, then applied to 0 (no server value) = min(0, 5) = 0
      expect(ops[0].op).toBe('replace');
      expect(ops[0].value).toBe(0); // min(0, 5) where 0 is the default

      // After sending, client's state should still be 5 (local state preserved)
      expect(doc.state.count).toBe(5);
      expect(doc.committedRev).toBe(1);
    });

    it('should apply local delta ops on top of server changes', async () => {
      const docId = 'doc1';
      const docA = harness.createClient('clientA', docId, { count: 10 });
      const docB = harness.createClient('clientB', docId, { count: 10 });

      // Client A sets count to 100
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.count, 100);
        });
      });

      // Client B increments by 5 (while still seeing old value)
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientB', d => {
        d.change(patch => {
          patch.increment('/count', 5);
        });
      });

      // Client A commits first
      const committedA = await harness.sendToServer('clientA');
      await harness.receiveFromServer('clientA', committedA);

      // Client B receives A's change while still having pending @inc
      await harness.receiveFromServer('clientB', committedA);

      // Client B's state should show server value + pending delta
      expect(docB.state.count).toBe(105); // 100 (from A) + 5 (pending @inc)

      // When B commits, it should add 5 to the current server value
      const committedB = await harness.sendToServer('clientB');
      await harness.receiveFromServer('clientB', committedB);

      // Final state should be 105
      expect(docB.state.count).toBe(105);
    });
  });

  describe('offline simulation', () => {
    it('should queue changes while offline and sync when reconnected', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { title: 'Original', count: 0 });

      // Make multiple changes while "offline" (not sending to server)
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'Updated');
        });
      });

      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.increment('/count', 1);
        });
      });

      vi.setSystemTime(1700000003000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.increment('/count', 2);
        });
      });

      // Local state should reflect all changes
      expect(doc.state).toEqual({ title: 'Updated', count: 3 });
      expect(doc.hasPending).toBe(true);

      // "Reconnect" - send all pending changes
      const committed = await harness.sendToServer('clientA');
      expect(committed).toHaveLength(1); // All ops consolidated into one change

      await harness.receiveFromServer('clientA', committed);

      // Final state should match local
      expect(doc.state).toEqual({ title: 'Updated', count: 3 });
      expect(doc.hasPending).toBe(false);
      expect(doc.committedRev).toBe(1);
    });

    it('should handle offline changes conflicting with server changes', async () => {
      const docId = 'doc1';
      const docA = harness.createClient('clientA', docId, { title: 'Original', count: 0 });
      const docB = harness.createClient('clientB', docId, { title: 'Original', count: 0 });

      // Client A goes offline and makes changes
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'Offline A');
        });
      });

      // Meanwhile, client B makes and commits a change
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientB', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'Online B');
        });
      });
      const committedB = await harness.sendToServer('clientB');

      // Client A comes back online, receives B's change first
      await harness.receiveFromServer('clientA', committedB);

      // A's local state should still show pending value (merged with server)
      // Since A's timestamp (1000) < B's timestamp (2000), B wins on server
      // But A still has pending change that shows locally
      expect(docA.state.title).toBe('Online B'); // B's value wins because higher timestamp

      // A sends its change - server will reject because B has higher timestamp
      const committedA = await harness.sendToServer('clientA');
      await harness.receiveFromServer('clientA', committedA);

      // A's change had lower timestamp, so B's value should persist
      expect(docA.state.title).toBe('Online B');
    });

    it('should preserve delta ops across reconnection', async () => {
      const docId = 'doc1';
      const docA = harness.createClient('clientA', docId, { count: 10 });
      const docB = harness.createClient('clientB', docId, { count: 10 });

      // Client A goes offline and increments
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change(patch => {
          patch.increment('/count', 5);
        });
      });

      // Client B sets count to 100
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientB', d => {
        d.change((patch, path) => {
          patch.replace(path.count, 100);
        });
      });
      const committedB = await harness.sendToServer('clientB');

      // A receives B's change
      await harness.receiveFromServer('clientA', committedB);

      // A's state should show B's value + A's pending increment
      expect(docA.state.count).toBe(105); // 100 + 5

      // A sends its increment
      const committedA = await harness.sendToServer('clientA');
      await harness.receiveFromServer('clientA', committedA);

      // Final value should be 105 (B's 100 + A's 5)
      expect(docA.state.count).toBe(105);
    });
  });

  describe('edge cases', () => {
    it('should handle empty change gracefully', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { title: 'Hello' });

      // Make a no-op change
      const { ops, changes } = await harness.makeChange('clientA', d => {
        d.change(() => {
          // No actual changes
        });
      });

      expect(ops).toHaveLength(0);
      expect(changes).toHaveLength(0);
      expect(doc.hasPending).toBe(false);
    });

    it('should handle nested object changes', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { nested: { value: 1 } });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.replace((path as any).nested.value, 42);
        });
      });

      expect(doc.state.nested?.value).toBe(42);
    });

    it('should handle parent overwriting children', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { nested: { value: 1 } });

      // First set a nested value
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace((path as any).nested.value, 10);
        });
      });

      // Then replace the entire parent
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.nested, { value: 99 });
        });
      });

      const committed = await harness.sendToServer('clientA');
      await harness.receiveFromServer('clientA', committed);

      // Parent replacement should have cleared child ops
      expect(doc.state.nested).toEqual({ value: 99 });
    });
  });
});

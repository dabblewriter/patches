/**
 * OT Integration Tests
 *
 * End-to-end tests that verify the full OT flow works correctly:
 * Client changes → OTAlgorithm packages → Server transforms/commits → Client rebases
 *
 * These tests use real implementations (not mocks) for all core components:
 * - OTAlgorithm (client)
 * - InMemoryStore (client storage)
 * - OTServer (server)
 * - OTMemoryStoreBackend (server storage - test-only implementation)
 *
 * Only the transport layer is simulated with direct function calls.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { InMemoryStore } from '../../src/client/InMemoryStore.js';
import { OTDoc } from '../../src/client/OTDoc.js';
import { OTServer } from '../../src/server/OTServer.js';
import type { OTStoreBackend } from '../../src/server/types.js';
import type { Change, VersionMetadata, EditableVersionMetadata, ListVersionsOptions, ListChangesOptions } from '../../src/types.js';
import type { JSONPatchOp } from '../../src/json-patch/types.js';

interface TestDoc {
  title?: string;
  count?: number;
  items?: string[];
  nested?: { value?: number };
}

/**
 * Minimal in-memory OT store backend for testing.
 * Implements just enough to support basic integration tests.
 */
class OTMemoryStoreBackend implements OTStoreBackend {
  private docs: Map<
    string,
    { changes: Change[]; versions: Map<string, { metadata: VersionMetadata; state: any; changes: Change[] }> }
  > = new Map();

  private getOrCreateDoc(docId: string) {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { changes: [], versions: new Map() };
      this.docs.set(docId, doc);
    }
    return doc;
  }

  /**
   * Initialize a document with a base state. This simulates having
   * a document already exist on the server before clients connect.
   */
  initializeDoc(docId: string, state: any): void {
    const doc = this.getOrCreateDoc(docId);
    // Create a version at rev 0 with the initial state
    const versionId = `v0-${docId}`;
    const now = Date.now();
    doc.versions.set(versionId, {
      metadata: {
        id: versionId,
        startedAt: now,
        endedAt: now,
        startRev: 0,
        endRev: 0,
        origin: 'main',
      },
      state,
      changes: [],
    });
  }

  async saveChanges(docId: string, changes: Change[]): Promise<void> {
    const doc = this.getOrCreateDoc(docId);
    doc.changes.push(...changes);
  }

  async listChanges(docId: string, options: ListChangesOptions): Promise<Change[]> {
    const doc = this.docs.get(docId);
    if (!doc) return [];

    let changes = doc.changes;
    if (options.startAfter !== undefined) {
      changes = changes.filter(c => c.rev > options.startAfter!);
    }
    if (options.endBefore !== undefined) {
      changes = changes.filter(c => c.rev < options.endBefore!);
    }
    return changes;
  }

  async deleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId);
  }

  async createVersion(docId: string, metadata: VersionMetadata, state: any, changes?: Change[]): Promise<void> {
    const doc = this.getOrCreateDoc(docId);
    doc.versions.set(metadata.id, { metadata, state, changes: changes ?? [] });
  }

  async listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]> {
    const doc = this.docs.get(docId);
    if (!doc) return [];
    let versions = Array.from(doc.versions.values()).map(v => v.metadata);
    // Filter by origin if specified
    if (options.origin) {
      versions = versions.filter(v => v.origin === options.origin);
    }
    // Sort by endRev (descending for reverse)
    if (options.reverse) {
      versions.sort((a, b) => b.endRev - a.endRev);
    }
    // Apply limit
    if (options.limit) {
      versions = versions.slice(0, options.limit);
    }
    return versions;
  }

  async loadVersionState(docId: string, versionId: string): Promise<any | undefined> {
    const doc = this.docs.get(docId);
    return doc?.versions.get(versionId)?.state;
  }

  async loadVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    const doc = this.docs.get(docId);
    return doc?.versions.get(versionId)?.changes ?? [];
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    const doc = this.docs.get(docId);
    const version = doc?.versions.get(versionId);
    if (version) {
      version.metadata = { ...version.metadata, ...metadata };
    }
  }

  async appendVersionChanges(
    docId: string,
    versionId: string,
    changes: Change[],
    newEndedAt: number,
    newEndRev: number,
    newState: any
  ): Promise<void> {
    const doc = this.docs.get(docId);
    const version = doc?.versions.get(versionId);
    if (version) {
      version.changes.push(...changes);
      version.metadata.endedAt = newEndedAt;
      version.metadata.endRev = newEndRev;
      version.state = newState;
    }
  }
}

/**
 * Test harness that wires up OT clients to a server.
 * Simulates network communication with direct function calls.
 */
class OTTestHarness {
  server: OTServer;
  serverStore: OTMemoryStoreBackend;
  clients: Map<string, { algorithm: OTAlgorithm; store: InMemoryStore; doc: OTDoc<TestDoc> }> = new Map();
  lastBroadcast: { docId: string; changes: Change[] } | null = null;

  getBroadcastChanges(): Change[] {
    return this.lastBroadcast?.changes ?? [];
  }

  constructor() {
    this.serverStore = new OTMemoryStoreBackend();
    this.server = new OTServer(this.serverStore);

    // Capture broadcast changes for distribution to other clients
    this.server.onChangesCommitted((docId, changes) => {
      this.lastBroadcast = { docId, changes };
    });
  }

  /** Track which docs have been initialized on the server */
  private initializedDocs: Set<string> = new Set();

  /**
   * Create a new client connected to the server.
   * The first client for a given docId initializes the document on the server.
   */
  createClient(clientId: string, docId: string, initialState: TestDoc = {}): OTDoc<TestDoc> {
    const store = new InMemoryStore();
    const algorithm = new OTAlgorithm(store);
    const doc = algorithm.createDoc<TestDoc>(docId, { state: initialState, rev: 0, changes: [] }) as OTDoc<TestDoc>;

    // First client for this doc initializes the server state
    if (!this.initializedDocs.has(docId)) {
      this.serverStore.initializeDoc(docId, initialState);
      this.initializedDocs.add(docId);
    }

    this.clients.set(clientId, { algorithm, store, doc });
    return doc;
  }

  /**
   * Make a change on a client and process it through the strategy.
   */
  async makeChange(
    clientId: string,
    mutator: (doc: OTDoc<TestDoc>) => void
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
   * Returns the broadcast change (for other clients) and applies server response to sender.
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

    // Apply server response to sending client (includes catchup + committed changes)
    await algorithm.applyServerChanges(docId, responseChanges, doc);

    // Return the broadcast change (contains the newly committed ops)
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
   */
  async roundTrip(clientId: string, mutator: (doc: OTDoc<TestDoc>) => void): Promise<{ committed: Change[] }> {
    await this.makeChange(clientId, mutator);
    const committed = await this.sendToServer(clientId);
    return { committed };
  }
}

describe('OT Integration', () => {
  let harness: OTTestHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
    harness = new OTTestHarness();
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
      const broadcast = await harness.sendToServer('clientA');
      expect(broadcast).toHaveLength(1);
      expect(broadcast[0].committedAt).toBeGreaterThan(0);

      // After sending, doc should show committed state
      expect(doc.state.title).toBe('World');
      expect(doc.committedRev).toBe(1);
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
          patch.add((path as any).count, 5);
        });
      });

      expect(doc.state.count).toBe(5);
      expect(doc.committedRev).toBe(1);
    });

    it('should handle removing fields', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { title: 'Test', count: 10 });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.remove(path.count);
        });
      });

      expect(doc.state.count).toBeUndefined();
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

      // A sends first
      const broadcastA = await harness.sendToServer('clientA');
      expect(broadcastA).toHaveLength(1);

      // B sends second - needs to be transformed against A's change
      const broadcastB = await harness.sendToServer('clientB');
      expect(broadcastB).toHaveLength(1);

      // Cross-apply broadcasts so both clients converge
      await harness.receiveFromServer('clientA', broadcastB);
      await harness.receiveFromServer('clientB', broadcastA);

      // Both clients should have same final state
      expect(docA.state).toEqual({ title: 'World', count: 5 });
      expect(docB.state).toEqual({ title: 'World', count: 5 });
    });
  });

  describe('same-field conflict resolution with OT', () => {
    it('should transform concurrent changes to the same field', async () => {
      const docId = 'doc1';
      const docA = harness.createClient('clientA', docId, { title: 'Original' });
      const docB = harness.createClient('clientB', docId, { title: 'Original' });

      // Client A changes title
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'From A');
        });
      });

      // Client B changes title concurrently
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientB', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'From B');
        });
      });

      // A commits first - wins
      const broadcastA = await harness.sendToServer('clientA');
      expect(docA.state.title).toBe('From A');
      expect(docA.committedRev).toBe(1);

      // B commits second - B's change transforms against A's
      // For replace operations, B's change will override A's (last writer wins in OT)
      const broadcastB = await harness.sendToServer('clientB');
      expect(docB.state.title).toBe('From B');
      expect(docB.committedRev).toBe(2);

      // A receives B's change
      await harness.receiveFromServer('clientA', broadcastB);
      expect(docA.state.title).toBe('From B');
      expect(docA.committedRev).toBe(2);
    });
  });

  describe('array operations', () => {
    it('should handle array append operations', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { items: ['a', 'b'] });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.add((path as any).items['-'], 'c');
        });
      });

      expect(doc.state.items).toEqual(['a', 'b', 'c']);
      expect(doc.committedRev).toBe(1);
    });

    it('should handle array remove operations', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { items: ['a', 'b', 'c'] });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.remove((path as any).items[1]);
        });
      });

      expect(doc.state.items).toEqual(['a', 'c']);
      expect(doc.committedRev).toBe(1);
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
        d.change((patch, path) => {
          patch.replace(path.count, 1);
        });
      });

      vi.setSystemTime(1700000003000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.count, 2);
        });
      });

      // Local state should reflect all changes
      expect(doc.state).toEqual({ title: 'Updated', count: 2 });
      expect(doc.hasPending).toBe(true);
      expect(doc.getPendingChanges()).toHaveLength(3);

      // "Reconnect" - send all pending changes
      const broadcast = await harness.sendToServer('clientA');
      expect(broadcast).toHaveLength(3); // OT sends each change separately

      // Final state should match local
      expect(doc.state).toEqual({ title: 'Updated', count: 2 });
      expect(doc.hasPending).toBe(false);
      expect(doc.committedRev).toBe(3);
    });

    it('should rebase offline changes against server changes', async () => {
      const docId = 'doc1';
      const docA = harness.createClient('clientA', docId, { title: 'Original', count: 0 });
      const docB = harness.createClient('clientB', docId, { title: 'Original', count: 0 });

      // Client A goes offline and makes a change
      vi.setSystemTime(1700000001000);
      await harness.makeChange('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'Offline A');
        });
      });

      // Meanwhile, client B makes and commits a change to count
      vi.setSystemTime(1700000002000);
      await harness.makeChange('clientB', d => {
        d.change((patch, path) => {
          patch.replace(path.count, 10);
        });
      });
      const broadcastB = await harness.sendToServer('clientB');

      // A comes online, receives B's change first
      await harness.receiveFromServer('clientA', broadcastB);

      // A's state should include B's change + A's pending change
      expect(docA.state.count).toBe(10); // From B
      expect(docA.state.title).toBe('Offline A'); // A's pending
      expect(docA.hasPending).toBe(true);

      // A sends its change - it will be rebased against B's
      const broadcastA = await harness.sendToServer('clientA');

      // A should now have both changes committed
      expect(docA.state).toEqual({ title: 'Offline A', count: 10 });
      expect(docA.committedRev).toBe(2);
      expect(docA.hasPending).toBe(false);
    });
  });

  describe('nested object changes', () => {
    it('should handle nested object updates', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { nested: { value: 1 } });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.replace((path as any).nested.value, 42);
        });
      });

      expect(doc.state.nested?.value).toBe(42);
    });

    it('should handle replacing entire nested object', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { nested: { value: 1 } });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.nested, { value: 99 });
        });
      });

      expect(doc.state.nested).toEqual({ value: 99 });
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

    it('should handle multiple operations in single change', async () => {
      const docId = 'doc1';
      const doc = harness.createClient('clientA', docId, { title: 'Hello', count: 0 });

      await harness.roundTrip('clientA', d => {
        d.change((patch, path) => {
          patch.replace(path.title, 'World');
          patch.replace(path.count, 5);
        });
      });

      expect(doc.state).toEqual({ title: 'World', count: 5 });
      expect(doc.committedRev).toBe(1);
    });
  });
});

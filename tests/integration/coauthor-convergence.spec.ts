/**
 * Co-authoring convergence fuzz harness (DAB-858 / DAB-854).
 *
 * Two real OT clients (OTAlgorithm + OTInMemoryStore + OTDoc) commit interleaved edits
 * through a real OTServer, with the delivery layer simulating production's failure
 * surface: SENDER-EXCLUDED broadcasts (a client never receives its own commit event —
 * pup's fan-out since DAB-773), DEFERRED deliveries that later COALESCE into one batch
 * (concatenating two foreign batches around the recipient's own interleaved commit —
 * the interior-gap shape), and DROPPED broadcasts (recovered via the getChangesSince
 * path, like PatchesSync.syncDoc).
 *
 * After every quiesce the harness asserts full convergence:
 *   client A doc == client B doc == server head, and each open doc == its own store
 *   (the equal-rev doc-vs-store invariant dw3's `equal_rev_content_heal` backstop
 *   exists to repair — this harness exists to catch its producer deterministically).
 *
 * Deterministic: seeded PRNG, fixed timers. A failure prints the seed, round, and the
 * delivery trace, so any divergence found here is replayable as-is.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import { OTDoc } from '../../src/client/OTDoc.js';
import { OTServer } from '../../src/server/OTServer.js';
import { MissingChangesError } from '../../src/algorithms/ot/client/applyCommittedChanges.js';
import type { OTStoreBackend } from '../../src/server/types.js';
import type {
  Change,
  VersionMetadata,
  EditableVersionMetadata,
  ListVersionsOptions,
  ListChangesOptions,
} from '../../src/types.js';

interface FuzzDoc {
  title?: string;
  count?: number;
  items?: string[];
  nested?: { value?: number };
}

/** Minimal in-memory OT server backend (mirrors ot-integration.spec.ts). */
class OTMemoryStoreBackend implements OTStoreBackend {
  private docs: Map<
    string,
    { changes: Change[]; versions: Map<string, { metadata: VersionMetadata; state?: any; changes: Change[] }> }
  > = new Map();

  private getOrCreateDoc(docId: string) {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { changes: [], versions: new Map() };
      this.docs.set(docId, doc);
    }
    return doc;
  }

  initializeDoc(docId: string, state: any): void {
    const doc = this.getOrCreateDoc(docId);
    const versionId = `v0-${docId}`;
    const now = Date.now();
    doc.versions.set(versionId, {
      metadata: { id: versionId, startedAt: now, endedAt: now, startRev: 0, endRev: 0, origin: 'main' },
      state,
      changes: [],
    });
  }

  async getCurrentRev(docId: string): Promise<number> {
    const doc = this.docs.get(docId);
    if (!doc) return 0;
    if (doc.changes.length > 0) return doc.changes[doc.changes.length - 1].rev;
    const versions = Array.from(doc.versions.values());
    if (versions.length > 0) return Math.max(...versions.map(v => v.metadata.endRev));
    return 0;
  }

  async saveChanges(docId: string, changes: Change[]): Promise<void> {
    this.getOrCreateDoc(docId).changes.push(...changes);
  }

  async listChanges(docId: string, options: ListChangesOptions): Promise<Change[]> {
    const doc = this.docs.get(docId);
    if (!doc) return [];
    let changes = doc.changes;
    if (options.startAfter !== undefined) changes = changes.filter(c => c.rev > options.startAfter!);
    if (options.endBefore !== undefined) changes = changes.filter(c => c.rev < options.endBefore!);
    return changes;
  }

  async deleteDoc(docId: string): Promise<void> {
    this.docs.delete(docId);
  }

  async createVersion(docId: string, metadata: VersionMetadata, changes?: Change[]): Promise<void> {
    this.getOrCreateDoc(docId).versions.set(metadata.id, { metadata, changes: changes ?? [] });
  }

  async listVersions(docId: string, options: ListVersionsOptions): Promise<VersionMetadata[]> {
    const doc = this.docs.get(docId);
    if (!doc) return [];
    let versions = Array.from(doc.versions.values()).map(v => v.metadata);
    if (options.origin) versions = versions.filter(v => v.origin === options.origin);
    if (options.reverse) versions.sort((a, b) => b.endRev - a.endRev);
    if (options.limit) versions = versions.slice(0, options.limit);
    return versions;
  }

  async loadVersion(docId: string, versionId: string): Promise<VersionMetadata | undefined> {
    return this.docs.get(docId)?.versions.get(versionId)?.metadata;
  }

  async loadVersionState(docId: string, versionId: string): Promise<string | undefined> {
    const state = this.docs.get(docId)?.versions.get(versionId)?.state;
    return state !== undefined ? JSON.stringify(state) : undefined;
  }

  async loadVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    return this.docs.get(docId)?.versions.get(versionId)?.changes ?? [];
  }

  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata): Promise<void> {
    const doc = this.docs.get(docId);
    const version = doc?.versions.get(versionId);
    if (version) version.metadata = { ...version.metadata, ...metadata };
  }
}

/** mulberry32 — tiny deterministic PRNG so every failure is replayable by seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ClientId = 'A' | 'B';

interface FuzzClient {
  algorithm: OTAlgorithm;
  store: OTInMemoryStore;
  doc: OTDoc<FuzzDoc>;
  /** Foreign broadcasts deferred by the bus, awaiting (possibly coalesced) delivery. */
  deferred: Change[][];
}

const DOC_ID = 'projects/fuzz/content';

/** Full shape up front so PRNG-picked `replace` ops always target existing paths. */
const INITIAL: FuzzDoc = { title: 't0', count: 0, items: [], nested: { value: 0 } };

class ConvergenceHarness {
  readonly server: OTServer;
  readonly backend = new OTMemoryStoreBackend();
  readonly clients = new Map<ClientId, FuzzClient>();
  readonly trace: string[] = [];
  private lastBroadcast: Change[] = [];

  constructor(private rand: () => number) {
    this.server = new OTServer(this.backend);
    this.server.onChangesCommitted((_docId, changes) => {
      this.lastBroadcast = changes;
    });
    this.backend.initializeDoc(DOC_ID, structuredClone(INITIAL));
    for (const id of ['A', 'B'] as const) {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      const doc = algorithm.createDoc<FuzzDoc>(DOC_ID, {
        state: structuredClone(INITIAL),
        rev: 0,
        changes: [],
      }) as OTDoc<FuzzDoc>;
      this.clients.set(id, { algorithm, store, doc, deferred: [] });
    }
  }

  log(line: string): void {
    this.trace.push(line);
    // 30 rounds emit well under this; the cap only guards a future much-longer fuzz.
    if (this.trace.length > 500) this.trace.shift();
  }

  other(id: ClientId): ClientId {
    return id === 'A' ? 'B' : 'A';
  }

  /** Mutate one client's doc with a PRNG-picked edit (mix of colliding and disjoint paths). */
  async mutate(id: ClientId, round: number): Promise<void> {
    const client = this.clients.get(id)!;
    const { doc, algorithm } = client;
    let ops: unknown[] = [];
    const unsubscribe = doc.onChange(emitted => {
      ops = emitted;
    });
    const pick = Math.floor(this.rand() * 4);
    doc.change((patch, path) => {
      if (pick === 0) patch.replace(path.title, `t-${id}-${round}`);
      else if (pick === 1) patch.replace(path.count, (doc.state.count ?? 0) + 1);
      else if (pick === 2) patch.replace(path.items, [...(doc.state.items ?? []), `i-${id}-${round}`]);
      else patch.replace(path.nested.value, round);
    });
    unsubscribe();
    if (ops.length > 0) {
      await algorithm.handleDocChange(DOC_ID, ops as never, doc, {});
      this.log(`r${round} ${id} mutates (${pick})`);
    }
  }

  /**
   * Flush a client's pending to the server. The ack (catchup + own transformed changes)
   * applies to the sender; the committed broadcast goes to the OTHER client only —
   * sender exclusion, exactly like pup's fan-out.
   */
  async flush(id: ClientId, round: number): Promise<void> {
    const client = this.clients.get(id)!;
    const pending = await client.algorithm.getPendingToSend(DOC_ID, client.doc);
    if (!pending || pending.length === 0) return;
    this.lastBroadcast = [];
    const response = await this.server.commitChanges(DOC_ID, pending);
    await this.applyWithRecovery(id, response.changes, round, 'ack');
    const broadcast = this.lastBroadcast;
    if (broadcast.length === 0) return;
    const revs = `${broadcast[0].rev}..${broadcast[broadcast.length - 1].rev}`;
    const to = this.other(id);
    const mode = this.rand();
    if (mode < 0.5) {
      this.log(`r${round} bus ${revs} -> ${to} direct`);
      await this.applyWithRecovery(to, broadcast, round, 'sse');
    } else if (mode < 0.85) {
      this.log(`r${round} bus ${revs} -> ${to} deferred`);
      this.clients.get(to)!.deferred.push(broadcast);
    } else {
      this.log(`r${round} bus ${revs} -> ${to} DROPPED`);
    }
  }

  /**
   * Deliver a client's deferred broadcasts. COALESCED into one apply call — two foreign
   * batches concatenated around the recipient's own interleaved commit is the exact
   * interior-gap shape sender exclusion produces in production.
   */
  async deliverDeferred(id: ClientId, round: number): Promise<void> {
    const client = this.clients.get(id)!;
    if (client.deferred.length === 0) return;
    const batch = client.deferred.flat();
    client.deferred.length = 0;
    this.log(`r${round} ${id} deferred x${batch.length} coalesced ${batch[0].rev}..${batch[batch.length - 1].rev}`);
    await this.applyWithRecovery(id, batch, round, 'coalesced');
  }

  /**
   * applyServerChanges with the production recovery loop: a MissingChangesError pulls the
   * authoritative tail from the server (the getChangesSince path PatchesSync.syncDoc
   * takes) and applies that instead. Any OTHER throw is a real defect — surface it.
   */
  private async applyWithRecovery(id: ClientId, changes: Change[], round: number, via: string): Promise<void> {
    const client = this.clients.get(id)!;
    try {
      await client.algorithm.applyServerChanges(DOC_ID, changes, client.doc);
    } catch (err) {
      if (!(err instanceof MissingChangesError)) throw err;
      this.log(`r${round} ${id} gap on ${via} (expected ${err.expectedRev}, got ${err.gotRev}) -> recover since ${err.sinceRev}`);
      const tail = await this.backend.listChanges(DOC_ID, { startAfter: err.sinceRev });
      await client.algorithm.applyServerChanges(DOC_ID, tail, client.doc);
    }
  }

  /** Flush everything outstanding: pendings, deferred deliveries, and dropped-event catch-up. */
  async quiesce(round: number): Promise<void> {
    for (const id of ['A', 'B'] as const) await this.flush(id, round);
    for (const id of ['A', 'B'] as const) await this.deliverDeferred(id, round);
    // Dropped broadcasts never re-deliver; every client pulls the tail it is missing —
    // the reconnect catch-up. Contiguous from the server, own echoes included (stale for
    // the sender), exactly like a getChangesSince response.
    for (const id of ['A', 'B'] as const) {
      const client = this.clients.get(id)!;
      const tail = await this.backend.listChanges(DOC_ID, { startAfter: client.doc.committedRev });
      if (tail.length > 0) {
        this.log(`r${round} ${id} catchup ${tail[0].rev}..${tail[tail.length - 1].rev}`);
        await this.applyWithRecovery(id, tail, round, 'catchup');
      }
    }
  }

  failureContext(): string {
    return `trace:\n${this.trace.join('\n')}`;
  }
}

/** Materialize the server's head state by folding its committed rows from scratch. */
async function serverHeadState(backend: OTMemoryStoreBackend): Promise<unknown> {
  const { applyChanges } = await import('../../src/algorithms/ot/shared/applyChanges.js');
  const changes = await backend.listChanges(DOC_ID, {});
  return applyChanges(structuredClone(INITIAL), changes);
}

describe('co-author convergence under sender-excluded, coalesced, and dropped fan-out', () => {
  // Cross-seed accumulator: the suite is only meaningful if the hostile delivery paths
  // actually fired. Checked in afterAll (cumulative across seeds) so per-seed PRNG drift
  // from future op-shape tweaks can't make this brittle.
  const exercised = { coalesced: false, dropped: false, gapRecovered: false };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    expect(exercised.coalesced, 'fuzz never coalesced a deferred delivery — hostile paths not exercised').toBe(true);
    expect(exercised.dropped, 'fuzz never dropped a broadcast — hostile paths not exercised').toBe(true);
    expect(exercised.gapRecovered, 'fuzz never hit MissingChangesError recovery — hostile paths not exercised').toBe(
      true
    );
  });

  for (const seed of [1, 2026, 858]) {
    it(`converges across 30 interleaved rounds (seed ${seed})`, async () => {
      const rand = prng(seed);
      const harness = new ConvergenceHarness(rand);

      for (let round = 0; round < 30; round++) {
        // Interleaved authorship: both clients usually edit before either flushes, and
        // flush order flips randomly — maximizing commits landing BETWEEN a peer's
        // commits (the interleave sender exclusion turns into holes).
        const first: ClientId = rand() < 0.5 ? 'A' : 'B';
        const second = first === 'A' ? 'B' : 'A';
        await harness.mutate(first, round);
        await harness.mutate(second, round);
        await harness.flush(first, round);
        if (rand() < 0.4) await harness.mutate(first, round);
        await harness.flush(second, round);
        if (rand() < 0.7) {
          await harness.deliverDeferred(first, round);
          await harness.deliverDeferred(second, round);
        }

        // Periodic quiesce + convergence check (not just at the end): divergence must be
        // caught in the round that produced it for the trace to name the producer.
        if (round % 5 === 4) {
          await harness.quiesce(round);
          const a = harness.clients.get('A')!;
          const b = harness.clients.get('B')!;
          const server = await serverHeadState(harness.backend);

          expect(a.doc.hasPending, `A still pending after quiesce r${round}\n${harness.failureContext()}`).toBe(false);
          expect(b.doc.hasPending, `B still pending after quiesce r${round}\n${harness.failureContext()}`).toBe(false);
          expect(a.doc.state, `A doc != server @r${round} (seed ${seed})\n${harness.failureContext()}`).toEqual(server);
          expect(b.doc.state, `B doc != server @r${round} (seed ${seed})\n${harness.failureContext()}`).toEqual(server);

          // The equal-rev doc-vs-store invariant — the exact divergence dw3's
          // equal_rev_content_heal backstop repairs in production.
          for (const [id, client] of [
            ['A', a],
            ['B', b],
          ] as const) {
            const snapshot = await client.algorithm.loadDoc(DOC_ID);
            expect(snapshot?.rev, `${id} store rev != doc rev @r${round}\n${harness.failureContext()}`).toBe(
              client.doc.committedRev
            );
            expect(client.doc.state, `${id} doc != own store @r${round} (seed ${seed})\n${harness.failureContext()}`).toEqual(
              snapshot?.state
            );
          }
        }
      }

      const trace = harness.trace.join('\n');
      if (trace.includes('coalesced')) exercised.coalesced = true;
      if (trace.includes('DROPPED')) exercised.dropped = true;
      if (trace.includes('gap on')) exercised.gapRecovered = true;
    });
  }
});

import { vi } from 'vitest';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges.js';
import { MissingChangesError } from '../../src/algorithms/ot/client/applyCommittedChanges.js';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm.js';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore.js';
import type { LWWDoc } from '../../src/client/LWWDoc.js';
import type { JSONPatch } from '../../src/json-patch/JSONPatch.js';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend.js';
import { LWWServer } from '../../src/server/LWWServer.js';
import type { Change, PatchesSnapshot } from '../../src/types.js';
import { createFaultInjector, isInjectedFault, withInjectedFaults, type FaultInjector } from './faultInjection.js';
import type { PRNG } from './prng.js';
import { describeChanges, readAll, stableStringify, wire } from './support.js';

/** Settings-ish document shape edited by the LWW fuzzer. */
export interface LWWFuzzDoc {
  theme?: string;
  fontSize?: number;
  counters?: Record<string, number>;
  flags?: Record<string, boolean>;
}

export interface LWWFuzzConfig {
  seed: number;
  clients: number;
  actions: number;
  /** Per-delivery probability the packet is dropped (healed by reconnect/quiesce catch-up). */
  dropP: number;
  /** Per-delivery probability the just-delivered packet is immediately redelivered. */
  dupP: number;
  /** Per-flush probability the commit RPC response is lost after the server committed. */
  lostResponseP: number;
  /** Per-flush probability the commit RPC request never reaches the server. */
  lostRequestP: number;
  /**
   * Process already-arrived broadcasts before issuing a flush. Both settings are fuzzed:
   * without draining, a queued broadcast older than the flush's commit response is applied
   * after it — a real window in production, where a broadcast can be in flight while the
   * commit RPC is outstanding (PatchesSync's blockable receive defers, but does not
   * reorder, a broadcast arriving mid-flush). The engine now skips such stale batches
   * wholesale (FINDING-2, fixed in convergence.spec.ts history).
   */
  drainInboxBeforeFlush: boolean;
  /**
   * Include mid-run parent-path replaces (replace /counters) in the edit mix, exercising
   * parent writes racing newer child writes (server-side child pruning, correction echoes,
   * doc subtree shielding — FINDING-4/FINDING-6, fixed).
   */
  parentOps: boolean;
  /**
   * Per-call probability a client store write (savePendingOps, saveSendingChange,
   * applyServerChanges, confirmSendingChange) rejects before mutating — the IndexedDB
   * transaction-abort shape (see faultInjection.ts). 0 disables (byte-identical runs).
   */
  clientStoreFailP: number;
  /**
   * Per-call probability a server backend method (saveOps, listOps, getCurrentRev,
   * seenChangeIds) rejects before mutating — the Firestore contention/abort shape. The
   * post-commit resend this forces is the change-id dedup path (the seenChangeIds TOCTOU
   * class pup guards with its in-transaction marker read).
   */
  serverBackendFailP: number;
}

interface Packet {
  seq: number;
  changes: Change[];
}

interface LWWFuzzClient {
  name: string;
  store: LWWInMemoryStore;
  algorithm: LWWAlgorithm;
  doc: LWWDoc<LWWFuzzDoc>;
  connected: boolean;
  inbox: Packet[];
}

const DOC_ID = 'fuzz-settings';
const BASE_TIME = 1700000000000;
const THEMES = ['light', 'dark', 'sepia', 'auto', 'ocean'];
const COUNTER_KEYS = ['words', 'sessions', 'streak'];
const FLAG_KEYS = ['spellcheck', 'autosave', 'focus', 'typewriter'];

/**
 * LWW convergence fuzz harness: N in-memory clients (LWWAlgorithm + LWWInMemoryStore +
 * LWWDoc) against a real LWWServer over the real LWWMemoryStoreBackend, joined by a
 * virtual network.
 *
 * Network model: per-client delivery stays FIFO (no cross-packet reorder) — the production
 * transports (WebSocket, SSE) are ordered per connection, so ordered delivery is part of
 * the engine's contract. Within that contract the engine now defends itself at the batch
 * level: a stale batch (rev already covered by committedRev) is skipped wholesale, and a
 * rev GAP (a dropped broadcast) raises MissingChangesError, which `deliver` answers with
 * the same recovery PatchesSync uses (flush pending or pull the tail via getChangesSince).
 * Drops, duplicate redelivery of the latest packet, disconnects, and lost commit
 * request/response legs are all fair game and are fuzzed here.
 */
export class LWWFuzzHarness {
  readonly backend = new LWWMemoryStoreBackend();
  readonly server: LWWServer;
  readonly clients: LWWFuzzClient[] = [];
  readonly trace: string[] = [];

  private readonly faults: FaultInjector;
  private now = BASE_TIME;
  private packetSeq = 0;
  private broadcastBuffer: Change[][] = [];

  constructor(
    private rng: PRNG,
    private cfg: LWWFuzzConfig
  ) {
    // Substrate faults draw from their own PRNG (see faultInjection.ts) and start
    // inactive: bootstrap runs fault-free, run() arms them, quiesce disarms them.
    this.faults = createFaultInjector(cfg.seed);
    this.faults.active = false;
    const serverBackend = withInjectedFaults(
      this.backend,
      ['saveOps', 'listOps', 'getCurrentRev', 'seenChangeIds'],
      this.faults,
      cfg.serverBackendFailP,
      method => this.tr(`FAULT server backend ${method} (injected)`)
    );
    this.server = new LWWServer(serverBackend);
    this.server.onChangesCommitted((_docId, changes) => {
      this.broadcastBuffer.push(wire(changes));
    });
    vi.setSystemTime(this.now);

    for (let i = 0; i < cfg.clients; i++) {
      const store = withInjectedFaults(
        new LWWInMemoryStore(),
        ['savePendingOps', 'saveSendingChange', 'applyServerChanges', 'confirmSendingChange'],
        this.faults,
        cfg.clientStoreFailP,
        method => this.tr(`FAULT c${i} store ${method} (injected)`)
      );
      const algorithm = new LWWAlgorithm(store);
      const doc = algorithm.createDoc<LWWFuzzDoc>(DOC_ID, {
        state: {} as LWWFuzzDoc,
        rev: 0,
        changes: [],
      }) as LWWDoc<LWWFuzzDoc>;
      this.clients.push({ name: `c${i}`, store, algorithm, doc, connected: true, inbox: [] });
    }
  }

  async run(): Promise<void> {
    await this.bootstrap();
    this.faults.active = true;
    for (let i = 0; i < this.cfg.actions; i++) {
      this.advance(this.rng.intBetween(50, 2000));
      await this.step();
    }
    await this.quiesce();
  }

  private advance(ms: number): void {
    this.now += ms;
    vi.setSystemTime(this.now);
  }

  private tr(line: string): void {
    this.trace.push(`#${this.trace.length + 1} t+${((this.now - BASE_TIME) / 1000).toFixed(1)}s ${line}`);
  }

  private pickWhere(predicate: (c: LWWFuzzClient) => boolean): LWWFuzzClient | undefined {
    const eligible = this.clients.filter(predicate);
    return eligible.length ? this.rng.pick(eligible) : undefined;
  }

  /** Client 0 seeds the base fields; everyone else receives the broadcast. Fault-free. */
  private async bootstrap(): Promise<void> {
    const creator = this.clients[0];
    await this.mint(
      creator,
      patch => {
        patch.replace('/theme', 'light');
        patch.replace('/fontSize', 16);
        patch.replace('/counters', { words: 0, sessions: 0, streak: 0 });
        patch.replace('/flags', { spellcheck: true, autosave: true });
      },
      'seed base fields'
    );
    await this.flush(creator, false);
    for (const client of this.clients) {
      while (client.inbox.length > 0) await this.deliver(client, false);
    }
    this.tr('bootstrap complete');
  }

  private async step(): Promise<void> {
    const action = this.rng.weighted([46, 18, 22, 5, 5, 4]);
    switch (action) {
      case 0:
        return this.edit(this.rng.pick(this.clients));
      case 1: {
        const client = this.pickWhere(c => c.connected);
        if (client && (await this.flush(client, true))) return;
        return this.edit(this.rng.pick(this.clients));
      }
      case 2: {
        const client = this.pickWhere(c => c.connected && c.inbox.length > 0);
        if (client) return this.deliver(client, true);
        return this.edit(this.rng.pick(this.clients));
      }
      case 3: {
        const client = this.pickWhere(c => c.connected);
        if (client) {
          client.connected = false;
          client.inbox = [];
          this.tr(`disconnect ${client.name}`);
          return;
        }
        return this.edit(this.rng.pick(this.clients));
      }
      case 4: {
        const client = this.pickWhere(c => !c.connected);
        if (client) return this.reconnect(client, true);
        return this.edit(this.rng.pick(this.clients));
      }
      case 5: {
        this.advance(this.rng.intBetween(2, 45) * 60_000);
        this.tr('time-jump');
        return;
      }
    }
  }

  private async mint(client: LWWFuzzClient, mutate: (patch: JSONPatch) => void, desc: string): Promise<void> {
    let ops: any[] = [];
    const unsubscribe = client.doc.onChange(emitted => {
      ops = emitted;
    });
    client.doc.change(patch => mutate(patch));
    unsubscribe();
    if (ops.length === 0) return;
    // Mirror Patches._processDocChange (#85): a store fault at the mint path keeps the
    // optimistic ops and re-submits — nothing rejected the work, discarding it is data loss.
    // The fault fails before any write, so the retry re-mints from a clean slate.
    for (;;) {
      try {
        await client.algorithm.handleDocChange(DOC_ID, ops, client.doc, {});
        break;
      } catch (err) {
        if (!isInjectedFault(err)) throw err;
        this.tr(`edit ${client.name}: mint STORE FAULT — kept ops, retrying (#85)`);
      }
    }
    this.tr(`edit ${client.name}: ${desc}`);
  }

  private async edit(client: LWWFuzzClient): Promise<void> {
    const state = client.doc.state;
    const kind = this.rng.weighted([20, 15, 30, 20, this.cfg.parentOps ? 10 : 0, 5]);
    switch (kind) {
      case 0:
        return this.mint(client, patch => patch.replace('/theme', this.rng.pick(THEMES)), 'replace /theme');
      case 1:
        return this.mint(client, patch => patch.replace('/fontSize', 12 + this.rng.int(20)), 'replace /fontSize');
      case 2: {
        const key = this.rng.pick(COUNTER_KEYS);
        const amount = 1 + this.rng.int(10);
        return this.mint(
          client,
          patch => patch.increment(`/counters/${key}`, amount),
          `@inc /counters/${key} +${amount}`
        );
      }
      case 3: {
        const key = this.rng.pick(FLAG_KEYS);
        const flags = state.flags ?? {};
        if (key in flags && this.rng.chance(0.3)) {
          return this.mint(client, patch => patch.remove(`/flags/${key}`), `remove /flags/${key}`);
        }
        return this.mint(client, patch => patch.replace(`/flags/${key}`, this.rng.chance(0.5)), `set /flags/${key}`);
      }
      case 4:
        // Parent replace — exercises server-side child-path pruning.
        return this.mint(
          client,
          patch => patch.replace('/counters', { words: this.rng.int(1000), sessions: this.rng.int(50), streak: 0 }),
          'replace /counters (parent)'
        );
      case 5:
        return this.mint(
          client,
          patch => {
            patch.replace('/theme', this.rng.pick(THEMES));
            patch.increment(`/counters/${this.rng.pick(COUNTER_KEYS)}`, 1);
          },
          'multi-op theme + @inc'
        );
    }
  }

  private async flush(client: LWWFuzzClient, faults: boolean): Promise<boolean> {
    if (!client.connected) return false;
    if (this.cfg.drainInboxBeforeFlush) {
      // Model a client that processes already-delivered events before committing (see
      // the drainInboxBeforeFlush doc — the un-drained ordering exposes FINDING-2).
      while (client.inbox.length > 0) await this.deliver(client, false);
    }
    let pending;
    try {
      pending = await client.algorithm.getPendingToSend(DOC_ID);
    } catch (err) {
      if (!isInjectedFault(err)) throw err;
      // saveSendingChange died moving pending ops into the sending slot — nothing left the
      // device; the ops are still pending and a later flush repeats the move.
      this.tr(`flush ${client.name}: STORE FAULT moving pending to sending — retried on a later flush`);
      return true;
    }
    if (!pending || pending.length === 0) return false;

    if (faults && this.rng.chance(this.cfg.lostRequestP)) {
      this.tr(`flush ${client.name}: REQUEST LOST (${describeChanges(pending)})`);
      return true;
    }

    this.broadcastBuffer = [];
    let result;
    try {
      result = await this.server.commitChanges(DOC_ID, wire(pending));
    } catch (err) {
      this.broadcastBuffer = [];
      if (isInjectedFault(err)) {
        // Mirror PatchesSync's retry ladder: a transient server/backend failure leaves the
        // change in the sending slot; the next flush re-sends the SAME change id, which is
        // exactly the change-id dedup path (the seenChangeIds TOCTOU class).
        this.tr(`flush ${client.name}: SERVER FAULT (injected) — sending kept for a later flush`);
        return true;
      }
      throw err;
    }
    for (const batch of this.broadcastBuffer) this.fanOut(batch, client);
    this.broadcastBuffer = [];

    if (faults && this.rng.chance(this.cfg.lostResponseP)) {
      // The sending change stays in the sending slot; a later flush retries it and the
      // server's consolidation resolves it (per-path, timestamp-based).
      this.tr(`flush ${client.name}: RESPONSE LOST (server committed ${describeChanges(result.changes)})`);
      return true;
    }

    // Mirror PatchesSync.flushDoc for LWW: confirm sent first, then apply the response so
    // server corrections are the last writer for corrected fields.
    try {
      await client.algorithm.confirmSent(DOC_ID, pending);
      await client.algorithm.applyServerChanges(DOC_ID, wire(result.changes), client.doc);
    } catch (err) {
      if (isInjectedFault(err)) {
        // The server committed but the client-side bookkeeping died mid-way (the crash
        // window between ack and persist). The change stays in the sending slot; the next
        // flush re-sends it and the server's change-id dedup answers idempotently. If the
        // confirm landed but the response apply died, the response's effects arrive later
        // via broadcast/catch-up instead.
        this.tr(`flush ${client.name}: STORE FAULT after commit (injected) — resend hits change-id dedup`);
        return true;
      }
      throw err;
    }
    this.tr(`flush ${client.name}: sent ${pending.length}, response ${describeChanges(result.changes)}`);
    return true;
  }

  private fanOut(changes: Change[], sender: LWWFuzzClient): void {
    for (const client of this.clients) {
      if (client === sender || !client.connected) continue;
      client.inbox.push({ seq: ++this.packetSeq, changes: wire(changes) });
    }
  }

  /** Deliver the next packet FIFO (LWW transports are ordered — see class docs). */
  private async deliver(client: LWWFuzzClient, faults: boolean): Promise<void> {
    if (!client.connected || client.inbox.length === 0) return;
    const packet = client.inbox.shift()!;

    if (faults && this.rng.chance(this.cfg.dropP)) {
      this.tr(`deliver ${client.name}: pkt#${packet.seq} DROPPED (${describeChanges(packet.changes)})`);
      return;
    }

    await this.applyDelivery(client, packet.changes, `pkt#${packet.seq}`);
    this.tr(`deliver ${client.name}: pkt#${packet.seq} ${describeChanges(packet.changes)}`);

    if (faults && this.rng.chance(this.cfg.dupP)) {
      // Immediate redelivery of the same packet (e.g. an SSE replay overlap).
      await this.applyDelivery(client, packet.changes, `pkt#${packet.seq} (dup)`);
      this.tr(`deliver ${client.name}: pkt#${packet.seq} REDELIVERED`);
    }
  }

  /**
   * Apply a delivered broadcast, answering a MissingChangesError (an earlier packet was
   * dropped — the batch's baseRev is ahead of committedRev) the way PatchesSync's
   * _receiveCommittedChanges does: re-enter syncDoc, which flushes pending if any (the
   * commit response carries the catch-up window) or pulls the tail via getChangesSince.
   */
  private async applyDelivery(client: LWWFuzzClient, changes: Change[], what: string): Promise<void> {
    try {
      await client.algorithm.applyServerChanges(DOC_ID, wire(changes), client.doc);
    } catch (err) {
      if (isInjectedFault(err)) {
        // The store rejected the apply before mutating: committedRev did not advance, so
        // this packet is effectively lost — the next contiguous packet raises
        // MissingChangesError and the gap recovery below (or quiesce catch-up) heals it.
        this.tr(`deliver ${client.name}: ${what} STORE FAULT on apply (injected) — gap recovery later`);
        return;
      }
      if (!(err instanceof MissingChangesError)) throw err;
      this.tr(`gap ${client.name}: ${what} ahead of committedRev — recovering`);
      try {
        if (await client.algorithm.hasPending(DOC_ID)) {
          await this.flush(client, false);
        } else {
          await this.catchup(client);
        }
      } catch (recoveryErr) {
        if (!isInjectedFault(recoveryErr)) throw recoveryErr;
        // Recovery itself died on a fault — the client stays behind; a later gap
        // recovery or the final quiesce catch-up (faults off) closes it.
        this.tr(`gap ${client.name}: recovery FAULT (injected) — remaining behind, retry later`);
      }
    }
  }

  /** Reconnect + catch up from the server (LWW getChangesSince synthesizes the tail). */
  private async reconnect(client: LWWFuzzClient, faults: boolean): Promise<void> {
    client.connected = true;
    this.tr(`reconnect ${client.name}`);
    try {
      const pending = await client.algorithm.getPendingToSend(DOC_ID);
      if (pending && pending.length > 0) {
        await this.flush(client, faults);
      } else {
        await this.catchup(client);
      }
    } catch (err) {
      if (!isInjectedFault(err)) throw err;
      // Reconnect sync died on a fault — the client stays behind/pending; the next
      // flush/deliver or the final quiesce (faults off) completes the sync.
      this.tr(`reconnect ${client.name}: FAULT (injected) — remaining behind, retry later`);
    }
  }

  private async catchup(client: LWWFuzzClient): Promise<void> {
    const committedRev = await client.algorithm.getCommittedRev(DOC_ID);
    const tail = wire(await this.server.getChangesSince(DOC_ID, committedRev));
    if (tail.length > 0) {
      await client.algorithm.applyServerChanges(DOC_ID, tail, client.doc);
      this.tr(`catchup ${client.name}: since ${committedRev} (${describeChanges(tail)})`);
    }
  }

  private async quiesce(): Promise<void> {
    this.faults.active = false; // runs must always drain — faults only perturb the action phase
    this.tr('--- quiesce ---');
    for (const client of this.clients) {
      if (!client.connected) await this.reconnect(client, false);
    }
    for (let round = 0; ; round++) {
      if (round >= 100) throw new Error('quiesce failed to drain after 100 rounds (livelock)');
      let busy = false;
      for (const client of this.clients) {
        while (client.inbox.length > 0) {
          await this.deliver(client, false);
          busy = true;
        }
      }
      for (const client of this.clients) {
        if (await client.algorithm.hasPending(DOC_ID)) {
          await this.flush(client, false);
          busy = true;
        }
      }
      if (!busy) break;
    }
    for (const client of this.clients) {
      await this.catchup(client);
    }
  }

  /** Assert convergence: all clients' committed state === server state, nothing pending. */
  async assertConverged(): Promise<void> {
    const envelope = JSON.parse(await readAll(await this.server.getDoc(DOC_ID))) as PatchesSnapshot;
    const headJson = stableStringify(applyChanges(envelope.state ?? {}, envelope.changes));
    const headRev = envelope.changes[envelope.changes.length - 1]?.rev ?? envelope.rev;

    for (const client of this.clients) {
      if (await client.algorithm.hasPending(DOC_ID)) {
        throw new Error(`P2 violated: ${client.name} still has pending/sending work`);
      }
      const snapshot = (await client.algorithm.loadDoc(DOC_ID))!;
      if (snapshot.changes.length > 0 || client.doc.hasPending) {
        throw new Error(`P2 violated: ${client.name} snapshot still carries ${snapshot.changes.length} changes`);
      }
      if (snapshot.rev !== headRev) {
        throw new Error(`P1 violated: ${client.name} committedRev ${snapshot.rev} != server head ${headRev}`);
      }
      const clientJson = stableStringify(snapshot.state);
      if (clientJson !== headJson) {
        throw new Error(
          `P1 violated: ${client.name} committed state diverged from server\n` +
            `server: ${headJson}\n${client.name}: ${clientJson}`
        );
      }
      const liveJson = stableStringify(client.doc.state);
      if (liveJson !== headJson) {
        throw new Error(
          `P1 violated: ${client.name} live doc state diverged from server\n` +
            `server: ${headJson}\n${client.name}: ${liveJson}`
        );
      }
    }
  }
}

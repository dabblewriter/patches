import { vi } from 'vitest';
import { MissingChangesError } from '../../src/algorithms/ot/client/applyCommittedChanges.js';
import { getSnapshotAtRevision } from '../../src/algorithms/ot/server/getSnapshotAtRevision.js';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges.js';
import { OTAlgorithm } from '../../src/client/OTAlgorithm.js';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore.js';
import type { OTDoc } from '../../src/client/OTDoc.js';
import type { JSONPatch } from '../../src/json-patch/JSONPatch.js';
import { OTServer } from '../../src/server/OTServer.js';
import type { Change, PatchesSnapshot, PatchesState } from '../../src/types.js';
import { OTFuzzBackend } from './otFuzzBackend.js';
import type { PRNG } from './prng.js';
import { describeChanges, readAll, stableStringify, wire } from './support.js';

/** Text-ish document shape edited by the fuzzer. */
export interface FuzzDoc {
  title?: string;
  count?: number;
  /** Delta text document, edited via `@txt` ops. */
  text?: { insert?: string | object; retain?: number; delete?: number }[] | { ops?: any[] };
  sections?: Record<string, { name?: string; words?: number }>;
  tags?: string[];
}

export interface OTFuzzConfig {
  seed: number;
  /** Number of simulated clients (2+). */
  clients: number;
  /** Number of scheduler actions to run after bootstrap. */
  actions: number;
  /** Per-delivery probability the packet is dropped (client must gap-resync later). */
  dropP: number;
  /** Per-delivery probability the packet is duplicated (redelivered again later). */
  dupP: number;
  /** Per-delivery probability of picking an out-of-order packet from the inbox. */
  reorderP: number;
  /** Per-flush probability the commit RPC response is lost after the server committed. */
  lostResponseP: number;
  /** Per-flush probability the commit RPC request never reaches the server. */
  lostRequestP: number;
  /** OTServer option — small values force count-based version snapshots mid-run. */
  maxChangesPerVersion: number;
  /** OTServer option — small values + time jumps force session-gap/offline versioning. */
  sessionTimeoutMinutes: number;
  /**
   * Include `move` ops in the edit mix. Disabled in the CI panel: concurrent moves expose a
   * known divergence (see the FINDINGS section of convergence.spec.ts) where the stateless
   * server transform commits a move whose source no longer exists, producing a committed
   * change that fails strict apply on every client.
   */
  moveOps: boolean;
}

interface Packet {
  seq: number;
  changes: Change[];
  duped?: boolean;
}

interface FuzzClient {
  name: string;
  store: OTInMemoryStore;
  algorithm: OTAlgorithm;
  doc: OTDoc<FuzzDoc>;
  connected: boolean;
  inbox: Packet[];
  /** Ids of every change this client minted (from handleDocChange). */
  minted: Set<string>;
  /** Minted ids observed to be legitimately resolved to no-ops (rebased away). */
  eliminated: Set<string>;
}

const DOC_ID = 'fuzz-doc';
const BASE_TIME = 1700000000000;
const WORDS = ['storm', 'night', 'writer', 'plot', 'scene', 'draft', 'quill', 'ink', 'page', 'muse'];

const INITIAL_DOC: FuzzDoc = {
  title: 'Chapter One',
  count: 0,
  text: [{ insert: 'It was a dark and stormy night.\n' }],
  sections: { intro: { name: 'Intro', words: 6 } },
  tags: ['draft'],
};

function textLength(text: FuzzDoc['text']): number {
  const ops = Array.isArray(text) ? text : text?.ops;
  if (!Array.isArray(ops)) return 0;
  return ops.reduce(
    (n: number, op: any) => n + (typeof op.insert === 'string' ? op.insert.length : op.insert !== undefined ? 1 : 0),
    0
  );
}

/**
 * OT convergence fuzz harness: N in-memory clients (OTAlgorithm + OTInMemoryStore + OTDoc)
 * against a real OTServer over an in-memory backend, joined by a virtual network the
 * scheduler perturbs (delay/reorder/duplication/drop, disconnects, lost RPC legs, doc
 * reloads). Fully deterministic given a PRNG: time advances via vi.setSystemTime and ids
 * come from the deterministic crypto-id mock.
 *
 * The per-client sync flow intentionally mirrors PatchesSync:
 * - flush: getPendingToSend → commitChanges → confirmSent → applyServerChanges →
 *   dropResolvedPending (see PatchesSync.flushDoc)
 * - broadcast receive: applyServerChanges; on MissingChangesError pull the authoritative
 *   tail via getChangesSince (see PatchesSync._receiveCommittedChanges / syncDoc)
 * - reconnect: pending ? flush : getChangesSince catch-up (see PatchesSync.syncDoc)
 * - reload: getDoc → reconcilePending against the covered tail → saveDoc → doc.import
 *   (see PatchesSync._reloadDocFromServer)
 */
export class OTFuzzHarness {
  readonly backend = new OTFuzzBackend();
  readonly server: OTServer;
  readonly clients: FuzzClient[] = [];
  readonly trace: string[] = [];

  private now = BASE_TIME;
  private packetSeq = 0;
  private broadcastBuffer: Change[][] = [];

  constructor(
    private rng: PRNG,
    private cfg: OTFuzzConfig
  ) {
    this.server = new OTServer(this.backend, {
      maxChangesPerVersion: cfg.maxChangesPerVersion,
      sessionTimeoutMinutes: cfg.sessionTimeoutMinutes,
    });
    this.server.onChangesCommitted((_docId, changes) => {
      this.broadcastBuffer.push(wire(changes));
    });
    vi.setSystemTime(this.now);

    for (let i = 0; i < cfg.clients; i++) {
      const store = new OTInMemoryStore();
      const algorithm = new OTAlgorithm(store);
      const snapshot: PatchesSnapshot<FuzzDoc> = { state: {} as FuzzDoc, rev: 0, changes: [] };
      const doc = algorithm.createDoc<FuzzDoc>(DOC_ID, snapshot) as OTDoc<FuzzDoc>;
      this.clients.push({
        name: `c${i}`,
        store,
        algorithm,
        doc,
        connected: true,
        inbox: [],
        minted: new Set(),
        eliminated: new Set(),
      });
    }
  }

  // ─── Script execution ─────────────────────────────────────────────────────

  async run(): Promise<void> {
    await this.bootstrap();
    for (let i = 0; i < this.cfg.actions; i++) {
      this.advance(this.rng.intBetween(50, 2000));
      await this.step();
    }
    await this.quiesce();
  }

  private async step(): Promise<void> {
    const action = this.rng.weighted([46, 16, 22, 4, 4, 4, 4]);
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
        if (client) return this.disconnect(client);
        return this.edit(this.rng.pick(this.clients));
      }
      case 4: {
        const client = this.pickWhere(c => !c.connected);
        if (client) return this.reconnect(client, true);
        return this.edit(this.rng.pick(this.clients));
      }
      case 5: {
        const client = this.pickWhere(c => c.connected);
        if (client) return this.reload(client);
        return this.edit(this.rng.pick(this.clients));
      }
      case 6: {
        // Time jump: crosses the session timeout so session-gap versioning and
        // offline-session classification paths run mid-script.
        const minutes = this.rng.intBetween(this.cfg.sessionTimeoutMinutes + 1, 90);
        this.advance(minutes * 60_000);
        this.tr(`time-jump +${minutes}m`);
        return;
      }
    }
  }

  private pickWhere(predicate: (c: FuzzClient) => boolean): FuzzClient | undefined {
    const eligible = this.clients.filter(predicate);
    return eligible.length ? this.rng.pick(eligible) : undefined;
  }

  private advance(ms: number): void {
    this.now += ms;
    vi.setSystemTime(this.now);
  }

  private tr(line: string): void {
    this.trace.push(`#${this.trace.length + 1} t+${((this.now - BASE_TIME) / 1000).toFixed(1)}s ${line}`);
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  /**
   * Client 0 creates the document (root replace at baseRev 0) and commits it; the other
   * clients hydrate from the server like PatchesSync's new-doc path. Runs fault-free.
   */
  private async bootstrap(): Promise<void> {
    const creator = this.clients[0];
    await this.mint(creator, patch => patch.replace('', INITIAL_DOC), "replace '' (create doc)");
    await this.flush(creator, false);
    for (const client of this.clients.slice(1)) {
      await this.reload(client);
      client.inbox = []; // the bootstrap broadcast is already covered by the reload
    }
    this.tr('bootstrap complete: all clients at rev 1');
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  private async mint(client: FuzzClient, mutate: (patch: JSONPatch) => void, desc: string): Promise<void> {
    let ops: any[] = [];
    const unsubscribe = client.doc.onChange(emitted => {
      ops = emitted;
    });
    client.doc.change(patch => mutate(patch));
    unsubscribe();
    if (ops.length === 0) return;
    const changes = await client.algorithm.handleDocChange(DOC_ID, ops, client.doc, {});
    for (const change of changes) client.minted.add(change.id);
    this.tr(`edit ${client.name}: ${desc}`);
  }

  private async edit(client: FuzzClient): Promise<void> {
    const state = client.doc.state;
    const kind = this.rng.weighted([40, 12, 8, 18, 12, this.cfg.moveOps ? 5 : 0, 5]);
    const word = this.rng.pick(WORDS);
    switch (kind) {
      case 0: {
        // @txt edit on /text
        const len = textLength(state.text);
        if (this.rng.chance(0.7) || len <= 2) {
          const pos = this.rng.int(Math.max(1, len));
          const delta = pos > 0 ? [{ retain: pos }, { insert: word + ' ' }] : [{ insert: word + ' ' }];
          return this.mint(client, patch => patch.text('/text', delta as any), `@txt insert "${word}" @${pos}`);
        }
        const pos = this.rng.int(len - 1);
        const count = 1 + this.rng.int(Math.min(5, len - 1 - pos));
        const delta = pos > 0 ? [{ retain: pos }, { delete: count }] : [{ delete: count }];
        return this.mint(client, patch => patch.text('/text', delta as any), `@txt delete ${count} @${pos}`);
      }
      case 1:
        return this.mint(client, patch => patch.replace('/title', `${word} ${this.rng.int(100)}`), 'replace /title');
      case 2:
        return this.mint(client, patch => patch.replace('/count', this.rng.int(1000)), 'replace /count');
      case 3: {
        const keys = Object.keys(state.sections ?? {});
        const op = this.rng.weighted([keys.length ? 30 : 100, keys.length ? 30 : 0, keys.length ? 25 : 0, 15]);
        if (op === 0 || keys.length === 0) {
          const id = `s${this.rng.int(50)}`;
          return this.mint(
            client,
            patch => patch.add(`/sections/${id}`, { name: word, words: 0 }),
            `add /sections/${id}`
          );
        }
        const key = this.rng.pick(keys);
        if (op === 1)
          return this.mint(client, patch => patch.replace(`/sections/${key}/name`, word), `rename /sections/${key}`);
        if (op === 2) return this.mint(client, patch => patch.remove(`/sections/${key}`), `remove /sections/${key}`);
        return this.mint(
          client,
          patch => patch.replace(`/sections/${key}/words`, this.rng.int(500)),
          `words /sections/${key}`
        );
      }
      case 4: {
        const tags = state.tags ?? [];
        const op = this.rng.weighted([35, tags.length ? 25 : 0, tags.length ? 20 : 0, tags.length ? 20 : 0]);
        if (op === 0 || tags.length === 0)
          return this.mint(client, patch => patch.add('/tags/-', `${word}-${this.rng.int(30)}`), 'append /tags/-');
        const i = this.rng.int(tags.length);
        if (op === 1) return this.mint(client, patch => patch.add(`/tags/${i}`, word), `insert /tags/${i}`);
        if (op === 2) return this.mint(client, patch => patch.remove(`/tags/${i}`), `remove /tags/${i}`);
        return this.mint(client, patch => patch.replace(`/tags/${i}`, word), `replace /tags/${i}`);
      }
      case 5: {
        // Occasional move: rekey a section, or reorder tags.
        const keys = Object.keys(state.sections ?? {});
        const tags = state.tags ?? [];
        if (keys.length > 0 && (this.rng.chance(0.5) || tags.length < 2)) {
          const from = this.rng.pick(keys);
          const to = `m${this.rng.int(50)}`;
          if (from === to || (state.sections && to in state.sections)) {
            return this.mint(client, patch => patch.replace('/title', word), 'replace /title (move collision)');
          }
          return this.mint(
            client,
            patch => patch.move(`/sections/${from}`, `/sections/${to}`),
            `move /sections/${from} -> ${to}`
          );
        }
        if (tags.length >= 2) {
          const from = this.rng.int(tags.length);
          const to = this.rng.int(tags.length);
          return this.mint(client, patch => patch.move(`/tags/${from}`, `/tags/${to}`), `move /tags/${from} -> ${to}`);
        }
        return this.mint(client, patch => patch.replace('/title', word), 'replace /title (fallback)');
      }
      case 6: {
        // Multi-op change on distinct scalar paths.
        return this.mint(
          client,
          patch => {
            patch.replace('/title', `${word} ${this.rng.int(100)}`);
            patch.replace('/count', this.rng.int(1000));
          },
          'multi-op replace /title + /count'
        );
      }
    }
  }

  /**
   * Flush pending changes to the server, mirroring PatchesSync.flushDoc. With faults
   * enabled the request or response leg may be "lost" — the retry path is a later flush,
   * which exercises the server's id-based idempotency.
   */
  private async flush(client: FuzzClient, faults: boolean): Promise<boolean> {
    if (!client.connected) return false;
    const pending = await client.algorithm.getPendingToSend(DOC_ID);
    if (!pending || pending.length === 0) return false;

    if (faults && this.rng.chance(this.cfg.lostRequestP)) {
      this.tr(`flush ${client.name}: REQUEST LOST (${describeChanges(pending)})`);
      return true;
    }

    this.broadcastBuffer = [];
    const result = await this.server.commitChanges(DOC_ID, wire(pending));
    for (const batch of this.broadcastBuffer) this.fanOut(batch, client);
    this.broadcastBuffer = [];

    if (faults && this.rng.chance(this.cfg.lostResponseP)) {
      this.tr(`flush ${client.name}: RESPONSE LOST (server committed ${describeChanges(result.changes)})`);
      return true;
    }

    if (result.docReloadRequired) {
      // Should be unreachable in this harness (all clients bootstrap past rev 0); if the
      // engine ever asks for it here, that is itself a finding.
      throw new Error(`Unexpected docReloadRequired for ${client.name}`);
    }

    const resp = wire(result.changes);
    await client.algorithm.confirmSent(DOC_ID, pending);
    await this.applyServerTracked(client, resp);

    // Mirror flushDoc's dropResolvedPending: sent changes the server didn't echo back were
    // rebased away to no-ops — record them as legitimately eliminated.
    const respIds = new Set(resp.map(c => c.id));
    const droppedByServer = pending.filter(c => !respIds.has(c.id));
    await client.algorithm.dropResolvedPending(DOC_ID, pending, resp);
    for (const change of droppedByServer) client.eliminated.add(change.id);

    this.tr(`flush ${client.name}: sent ${pending.length}, response ${describeChanges(resp)}`);
    return true;
  }

  private fanOut(changes: Change[], sender: FuzzClient): void {
    for (const client of this.clients) {
      if (client === sender || !client.connected) continue;
      client.inbox.push({ seq: ++this.packetSeq, changes: wire(changes) });
    }
  }

  /** Deliver one packet from the client's inbox, applying network faults when enabled. */
  private async deliver(client: FuzzClient, faults: boolean): Promise<void> {
    if (!client.connected || client.inbox.length === 0) return;
    let index = 0;
    if (faults && client.inbox.length > 1 && this.rng.chance(this.cfg.reorderP)) {
      index = this.rng.int(client.inbox.length);
    }
    const packet = client.inbox.splice(index, 1)[0];

    if (faults && this.rng.chance(this.cfg.dropP)) {
      this.tr(`deliver ${client.name}: pkt#${packet.seq} DROPPED (${describeChanges(packet.changes)})`);
      return;
    }
    if (faults && !packet.duped && this.rng.chance(this.cfg.dupP)) {
      packet.duped = true;
      client.inbox.push({ seq: packet.seq, changes: wire(packet.changes), duped: true });
      this.tr(`deliver ${client.name}: pkt#${packet.seq} DUPLICATED`);
    }

    try {
      await this.applyServerTracked(client, wire(packet.changes));
      this.tr(`deliver ${client.name}: pkt#${packet.seq} ${describeChanges(packet.changes)}`);
    } catch (err) {
      if (err instanceof MissingChangesError) {
        // Mirror PatchesSync gap recovery: pull the authoritative tail.
        const committedRev = await client.algorithm.getCommittedRev(DOC_ID);
        const tail = wire(await this.server.getChangesSince(DOC_ID, committedRev));
        if (tail.length > 0) await this.applyServerTracked(client, tail);
        this.tr(
          `deliver ${client.name}: pkt#${packet.seq} GAP -> resync since ${committedRev} (${tail.length} changes)`
        );
        return;
      }
      throw err;
    }
  }

  private async disconnect(client: FuzzClient): Promise<void> {
    client.connected = false;
    client.inbox = []; // in-flight events are lost with the connection
    this.tr(`disconnect ${client.name}`);
  }

  /** Reconnect + sync, mirroring PatchesSync.syncDoc: flush pending, else catch up. */
  private async reconnect(client: FuzzClient, faults: boolean): Promise<void> {
    client.connected = true;
    this.tr(`reconnect ${client.name}`);
    const pending = await client.algorithm.getPendingToSend(DOC_ID);
    if (pending && pending.length > 0) {
      await this.flush(client, faults);
    } else {
      const committedRev = await client.algorithm.getCommittedRev(DOC_ID);
      const tail = wire(await this.server.getChangesSince(DOC_ID, committedRev));
      if (tail.length > 0) {
        await this.applyServerTracked(client, tail);
        this.tr(`catchup ${client.name}: since ${committedRev} (${tail.length} changes)`);
      }
    }
  }

  /** Mid-stream doc reload, mirroring PatchesSync._reloadDocFromServer. */
  private async reload(client: FuzzClient): Promise<void> {
    const algorithm = client.algorithm;
    const baseRev = await algorithm.getCommittedRev(DOC_ID);
    const envelope = JSON.parse(await readAll(await this.server.getDoc(DOC_ID))) as PatchesSnapshot;

    if (envelope.rev > baseRev && (await algorithm.hasPending(DOC_ID))) {
      const committedTail = wire(await this.server.getChangesSince(DOC_ID, baseRev)).filter(c => c.rev <= envelope.rev);
      if (committedTail.length > 0) await this.reconcileTracked(client, committedTail);
    }

    await algorithm.store.saveDoc(DOC_ID, envelope as PatchesState);
    const full = await algorithm.loadDoc(DOC_ID);
    if (full) client.doc.import(full as PatchesSnapshot<FuzzDoc>);
    this.tr(`reload ${client.name}: from rev ${baseRev} to envelope rev ${envelope.rev}+${envelope.changes.length}`);
  }

  // ─── Tracked wrappers (change-id accounting) ──────────────────────────────

  /**
   * applyServerChanges with elimination tracking: a pending change that disappears from the
   * queue without being part of the applied committed changes was rebased away to a no-op.
   */
  private async applyServerTracked(client: FuzzClient, changes: Change[]): Promise<void> {
    const before = (await client.store.getPendingChanges(DOC_ID)).map(c => c.id);
    await client.algorithm.applyServerChanges(DOC_ID, changes, client.doc);
    const after = new Set((await client.store.getPendingChanges(DOC_ID)).map(c => c.id));
    const committedIds = new Set(changes.map(c => c.id));
    for (const id of before) {
      if (!after.has(id) && !committedIds.has(id)) client.eliminated.add(id);
    }
  }

  /** reconcilePending with the same elimination tracking as applyServerTracked. */
  private async reconcileTracked(client: FuzzClient, committedTail: Change[]): Promise<void> {
    const before = (await client.store.getPendingChanges(DOC_ID)).map(c => c.id);
    await client.algorithm.reconcilePending!(DOC_ID, committedTail);
    const after = new Set((await client.store.getPendingChanges(DOC_ID)).map(c => c.id));
    const committedIds = new Set(committedTail.map(c => c.id));
    for (const id of before) {
      if (!after.has(id) && !committedIds.has(id)) client.eliminated.add(id);
    }
  }

  // ─── Quiesce + assertions ─────────────────────────────────────────────────

  /** Reconnect everyone, deliver everything, flush everything — fault-free — until stable. */
  private async quiesce(): Promise<void> {
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
    // Final catch-up: anyone who missed a broadcast (drop/disconnect) pulls the tail.
    for (const client of this.clients) {
      const committedRev = await client.algorithm.getCommittedRev(DOC_ID);
      const tail = wire(await this.server.getChangesSince(DOC_ID, committedRev));
      if (tail.length > 0) {
        await this.applyServerTracked(client, tail);
        this.tr(`final catchup ${client.name}: since ${committedRev} (${tail.length} changes)`);
      }
    }
  }

  /** Assert the four core convergence properties. Throws with a labelled message. */
  async assertConverged(): Promise<void> {
    const log = this.backend.log(DOC_ID);

    // Property 4: the server change log is contiguous (revs 1..N).
    const revs = log.map(c => c.rev);
    for (let i = 0; i < revs.length; i++) {
      if (revs[i] !== i + 1) {
        throw new Error(`P4 violated: server log not contiguous at index ${i}: rev ${revs[i]} (expected ${i + 1})`);
      }
    }
    const headRev = revs.length;

    // Authoritative head state, from a full replay of the log…
    const headJson = stableStringify(applyChanges(null, log));
    // …cross-checked against the version-snapshot read path the server actually serves.
    const snap = await getSnapshotAtRevision(this.backend, DOC_ID);
    const snapJson = stableStringify(applyChanges(snap.state, snap.changes));
    if (snapJson !== headJson) {
      throw new Error(
        `P1 violated (server-side): version-snapshot head != full-replay head\n` +
          `full replay: ${headJson}\nsnapshot:    ${snapJson}`
      );
    }

    for (const client of this.clients) {
      const snapshot = (await client.algorithm.loadDoc(DOC_ID))!;
      // Property 2: no pending changes remain anywhere.
      if (snapshot.changes.length > 0 || client.doc.hasPending) {
        throw new Error(`P2 violated: ${client.name} still has ${snapshot.changes.length} pending changes`);
      }
      if (snapshot.rev !== headRev) {
        throw new Error(`P1 violated: ${client.name} committedRev ${snapshot.rev} != server head ${headRev}`);
      }
      // Property 1: committed state (and live doc state) deep-equals the server head state.
      const clientJson = stableStringify(snapshot.state);
      if (clientJson !== headJson) {
        throw new Error(
          `P1 violated: ${client.name} committed state diverged from server head\n` +
            `server: ${headJson}\n${client.name}: ${clientJson}`
        );
      }
      const liveJson = stableStringify(client.doc.state);
      if (liveJson !== headJson) {
        throw new Error(
          `P1 violated: ${client.name} live doc state diverged from server head\n` +
            `server: ${headJson}\n${client.name}: ${liveJson}`
        );
      }
    }

    // Property 3: every locally-minted change committed exactly once (or provably
    // rebased away to a no-op) — no drops, no dupes.
    const counts = new Map<string, number>();
    for (const change of log) counts.set(change.id, (counts.get(change.id) ?? 0) + 1);
    for (const [id, count] of counts) {
      if (count > 1) throw new Error(`P3 violated: change ${id} appears ${count} times in the server log`);
    }
    for (const client of this.clients) {
      for (const id of client.minted) {
        const count = counts.get(id) ?? 0;
        if (count === 0 && !client.eliminated.has(id)) {
          throw new Error(
            `P3 violated: change ${id} minted by ${client.name} was silently lost (not committed, not rebased away)`
          );
        }
      }
    }
  }
}

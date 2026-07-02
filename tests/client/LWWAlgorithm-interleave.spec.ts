import { beforeEach, describe, expect, it } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import type { JSONPatchOp } from '../../src/json-patch/types';

/**
 * getPendingToSend's send-capture (getPendingOps → createChange → saveSendingChange, which
 * clears ALL pending ops) and handleDocChange's read-consolidate-save are each composed of
 * individually-transactional store calls, but the compositions are not atomic. Without the
 * per-doc lock, an op minted between the capture's read and its clear-all is wiped without
 * ever being sent. This races the two with a store whose getPendingOps is held open on a
 * controllable deferred so the interleaving matters — no timers, fully deterministic.
 */

/** LWWInMemoryStore whose next getPendingOps read can be held open mid-flight. */
class GatedLWWStore extends LWWInMemoryStore {
  gate: Promise<void> | null = null;

  async getPendingOps(docId: string, pathPrefixes?: string[]): Promise<JSONPatchOp[]> {
    const ops = await super.getPendingOps(docId, pathPrefixes);
    if (this.gate) {
      const gate = this.gate;
      this.gate = null; // hold only the first read open
      await gate;
    }
    return ops;
  }
}

describe('LWWAlgorithm send-capture vs mint interleave', () => {
  let store: GatedLWWStore;
  let algorithm: LWWAlgorithm;

  beforeEach(async () => {
    store = new GatedLWWStore();
    algorithm = new LWWAlgorithm(store);
    await store.trackDocs(['doc1'], 'lww');
    // One op already pending before the send-capture begins.
    await algorithm.handleDocChange('doc1', [{ op: 'replace', path: '/a', value: 1 }], undefined, {});
  });

  it('never drops an op minted while getPendingToSend is capturing the queue', async () => {
    let release!: () => void;
    store.gate = new Promise<void>(resolve => (release = resolve));

    // The send-capture enters first and stalls inside its pending-ops read; the mint fires
    // while it is in flight. Unserialized, the mint's op would land between the capture's
    // read and saveSendingChange's clear-all and be destroyed unsent.
    const send = algorithm.getPendingToSend('doc1');
    const mint = algorithm.handleDocChange('doc1', [{ op: 'replace', path: '/b', value: 2 }], undefined, {});
    release();
    const [sending] = await Promise.all([send, mint]);

    // The captured change carries what was pending when the capture began…
    expect(sending).not.toBeNull();
    expect(sending!.flatMap(c => c.ops.map(op => op.path))).toEqual(['/a']);

    // …and the op minted mid-flight is never lost: it ends up either in the sending change
    // or still pending. The per-doc lock serializes the mint after the capture, so it
    // survives as pending.
    const stillPending = await store.getPendingOps('doc1');
    const everywhere = [...sending!.flatMap(c => c.ops), ...stillPending].map(op => op.path);
    expect(everywhere).toContain('/a');
    expect(everywhere).toContain('/b');
    expect(await algorithm.hasPending('doc1')).toBe(true);

    // The survivor is picked up by the next capture once the in-flight send confirms.
    await algorithm.confirmSent('doc1', sending!);
    const next = await algorithm.getPendingToSend('doc1');
    expect(next!.flatMap(c => c.ops.map(op => op.path))).toEqual(['/b']);
  });
});

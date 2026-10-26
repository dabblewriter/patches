import { describe, expect, it } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm.js';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore.js';
import { ServerClock } from '../../src/client/ServerClock.js';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend.js';
import { LWWServer } from '../../src/server/LWWServer.js';
import type { Change } from '../../src/types.js';

const DAY = 24 * 60 * 60 * 1000;

function committedAt(t: number): Change[] {
  return [{ id: 'c', baseRev: 0, rev: 1, ops: [], createdAt: t, committedAt: t }];
}

describe('LWWAlgorithm clock-drift correction (DAB-936)', () => {
  it('stamps ops from its clock, corrected by what commit responses taught it', async () => {
    const local = { t: 1_000_000 };
    const clock = new ServerClock({ storage: null, now: () => local.t });
    const store = new LWWInMemoryStore();
    const algorithm = new LWWAlgorithm(store, { clock });
    await store.trackDocs(['doc1'], 'lww');

    // The device is 3 days slow: the server's commit time is 3 days past the round trip
    algorithm.observeCommitTiming(1_000_000, 1_000_300, committedAt(1_000_300 + 3 * DAY));

    await algorithm.handleDocChange('doc1', [{ op: 'replace', path: '/a', value: 1 }], undefined, {});
    const [op] = await store.getPendingOps('doc1');
    expect(op.ts).toBe(1_000_000 + 3 * DAY);
  });

  it('a later edit supersedes the pending one after the offset steps DOWN (review repro)', async () => {
    // Device 2 min fast: edit, learn the offset, edit the same field again
    const local = { t: 10_000_000 };
    const clock = new ServerClock({ storage: null, now: () => local.t });
    const store = new LWWInMemoryStore();
    const algorithm = new LWWAlgorithm(store, { clock });
    await store.trackDocs(['doc1'], 'lww');

    await algorithm.handleDocChange('doc1', [{ op: 'replace', path: '/title', value: 'ab' }], undefined, {});
    algorithm.observeCommitTiming(local.t, local.t + 100, committedAt(local.t - 2 * 60_000));
    await algorithm.handleDocChange('doc1', [{ op: 'replace', path: '/title', value: 'abc' }], undefined, {});

    const pending = await store.getPendingOps('doc1');
    expect(pending.map(op => op.value)).toEqual(['abc']);
  });

  it('a fresh clock (after reload) never stamps below a persisted pending or in-flight op', async () => {
    const store = new LWWInMemoryStore();
    await store.trackDocs(['doc1'], 'lww');
    // Stamped ahead by the previous session, then reloaded with a corrected clock
    const before = new LWWAlgorithm(store, { clock: new ServerClock({ storage: null, now: () => 5_000_000 }) });
    await before.handleDocChange('doc1', [{ op: 'replace', path: '/a', value: 1 }], undefined, {});
    await before.getPendingToSend('doc1'); // /a is now in flight
    await before.handleDocChange('doc1', [{ op: 'replace', path: '/b', value: 1 }], undefined, {});

    const after = new LWWAlgorithm(store, { clock: new ServerClock({ storage: null, now: () => 1_000_000 }) });
    await after.handleDocChange(
      'doc1',
      [
        { op: 'replace', path: '/a', value: 2 },
        { op: 'replace', path: '/b', value: 2 },
        { op: 'replace', path: '/c', value: 2 },
      ],
      undefined,
      {}
    );

    // Strictly above everything still queued for the doc, at every path
    const byPath = Object.fromEntries((await store.getPendingOps('doc1')).map(op => [op.path, op]));
    expect(byPath['/a']).toMatchObject({ value: 2, ts: 5_000_002 });
    expect(byPath['/b']).toMatchObject({ value: 2, ts: 5_000_002 });
    expect(byPath['/c']).toMatchObject({ value: 2, ts: 5_000_002 });
  });

  it('a child edit after reload is not wiped by its pending parent (second-review repro)', async () => {
    const store = new LWWInMemoryStore();
    await store.trackDocs(['doc1'], 'lww');
    const real = Date.now() - 5_000;
    // Previous session stamped ahead (fast clock or a held stamp); the parent never sent
    const before = new LWWAlgorithm(store, { clock: new ServerClock({ storage: null, now: () => real + 600_000 }) });
    await before.handleDocChange('doc1', [{ op: 'replace', path: '/obj', value: { a: 1 } }], undefined, {});
    // Reload with a corrected clock, then edit a child of the pending parent
    const after = new LWWAlgorithm(store, { clock: new ServerClock({ storage: null, now: () => real }) });
    await after.handleDocChange('doc1', [{ op: 'replace', path: '/obj/x', value: 'typed' }], undefined, {});
    const [change] = (await after.getPendingToSend('doc1'))!;

    // Both ops commit in one change at one rev; the server orders them by ts
    const server = new LWWServer(new LWWMemoryStoreBackend());
    await server.commitChanges('doc1', [change]);
    const rebuilt = new LWWInMemoryStore();
    await rebuilt.trackDocs(['doc1'], 'lww');
    await rebuilt.applyServerChanges('doc1', await server.getChangesSince('doc1', 0));

    expect((await rebuilt.getDoc('doc1'))?.state).toEqual({ obj: { a: 1, x: 'typed' } });
  });

  it('ignores a response with no committedAt', () => {
    const clock = new ServerClock({ storage: null, now: () => 0 });
    const algorithm = new LWWAlgorithm(new LWWInMemoryStore(), { clock });
    algorithm.observeCommitTiming(0, 100, [{ id: 'c', baseRev: 0, rev: 1, ops: [], createdAt: 0, committedAt: 0 }]);
    algorithm.observeCommitTiming(0, 100, []);
    expect(clock.offset).toBe(0);
  });

  it('creates its own clock by default', () => {
    expect(new LWWAlgorithm(new LWWInMemoryStore()).clock).toBeInstanceOf(ServerClock);
  });
});

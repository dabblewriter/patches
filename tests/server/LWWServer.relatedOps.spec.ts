import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONPatchOp } from '../../src/json-patch/types';
import { LWWMemoryStoreBackend } from '../../src/server/LWWMemoryStoreBackend';
import { LWWServer } from '../../src/server/LWWServer';
import type { ChangeInput } from '../../src/types';
import { PRNG } from '../fuzz/prng';

const BASE_TIME = 1_700_000_000_000;
const KEYS = ['a', 'b', 'c'];

function randomPath(rng: PRNG): string {
  const depth = rng.intBetween(1, 3);
  return Array.from({ length: depth }, () => '/' + rng.pick(KEYS)).join('');
}

function randomOp(rng: PRNG, now: number): JSONPatchOp {
  const path = randomPath(rng);
  const ts = now - rng.int(5000);
  switch (rng.weighted([4, 1, 1, 2, 1, 1, 1])) {
    case 0:
      return { op: 'replace', path, value: rng.int(100), ts };
    case 1:
      return { op: 'replace', path, value: { [rng.pick(KEYS)]: rng.int(100) }, ts };
    case 2:
      return { op: 'add', path, value: {}, ts };
    case 3:
      return { op: '@inc', path, value: rng.intBetween(1, 5), ts };
    case 4:
      return { op: '@max', path, value: rng.int(100), ts };
    case 5:
      return { op: 'remove', path, ts };
    default:
      return { op: 'replace', path, value: 'soft', soft: true, ts };
  }
}

describe('LWWServer commitChanges with listRelatedOps', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('matches a full listOps read (seed %i)', async seed => {
    const rng = new PRNG(seed);
    const targetedStore = new LWWMemoryStoreBackend();
    const fullStore = new LWWMemoryStoreBackend();
    Object.assign(fullStore, { listRelatedOps: undefined });
    const listOps = vi.spyOn(targetedStore, 'listOps');
    const targeted = new LWWServer(targetedStore);
    const full = new LWWServer(fullStore);
    const sent: ChangeInput[] = [];
    let now = BASE_TIME;

    for (let i = 0; i < 300; i++) {
      now += rng.intBetween(1, 2000);
      vi.setSystemTime(now);
      const rev = await fullStore.getCurrentRev('doc');
      const retry = sent.length > 0 && rng.chance(0.1);
      const changes: ChangeInput[] = retry
        ? [rng.pick(sent)]
        : Array.from({ length: rng.weighted([6, 1]) + 1 }, (_, j) => ({
            id: `c${i}-${j}`,
            ops: Array.from({ length: rng.intBetween(1, 3) }, () => randomOp(rng, now)),
            baseRev: rng.chance(0.2) ? undefined : rng.intBetween(Math.max(0, rev - 5), rev),
          }));
      sent.push(...changes);

      const expected = await full.commitChanges('doc', structuredClone(changes));
      const actual = await targeted.commitChanges('doc', structuredClone(changes));
      expect(actual, `commit ${i}`).toEqual(expected);
    }

    expect(listOps).not.toHaveBeenCalled();
    expect(await targetedStore.listOps('doc')).toEqual(await fullStore.listOps('doc'));
  });

  it('falls back to a full read for a root write', async () => {
    const store = new LWWMemoryStoreBackend();
    const server = new LWWServer(store);
    await server.commitChanges('doc', [{ id: 'a', ops: [{ op: 'replace', path: '/x', value: 1 }] }]);
    const listOps = vi.spyOn(store, 'listOps');
    const listRelatedOps = vi.spyOn(store, 'listRelatedOps');

    await server.commitChanges('doc', [{ id: 'b', ops: [{ op: 'replace', path: '', value: { y: 2 } }] }]);

    expect(listOps).toHaveBeenCalledWith('doc');
    expect(listRelatedOps).not.toHaveBeenCalled();
  });
});

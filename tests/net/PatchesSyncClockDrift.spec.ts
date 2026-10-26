/**
 * DAB-936: the commit round trip is what teaches the LWW clock its offset. PatchesSync times each
 * commit and hands the response to the algorithm; without that wiring the clock never learns and
 * a slow device keeps stamping writes that lose.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm.js';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import { ServerClock } from '../../src/client/ServerClock.js';
import { PatchesSync } from '../../src/net/PatchesSync.js';
import type { Change } from '../../src/types.js';
import { makeConnection } from './connectionMock.js';

const DAY = 24 * 60 * 60 * 1000;

describe('PatchesSync → LWW clock drift', () => {
  let sync: PatchesSync | undefined;

  afterEach(() => {
    sync?.disconnect();
    sync = undefined;
  });

  it("learns the offset from a commit response's committedAt", async () => {
    const store = new LWWInMemoryStore();
    const clock = new ServerClock({ storage: null });
    const algorithm = new LWWAlgorithm(store, { clock });
    const patches = new Patches({ algorithms: { lww: algorithm }, defaultAlgorithm: 'lww' });
    await patches.trackDocs(['doc1']);
    await algorithm.handleDocChange('doc1', [{ op: 'replace', path: '/a', value: 1 }], undefined, {});

    // The server is 3 days ahead of this device
    const commitChanges = vi.fn(async (_docId: string, changes: Change[]) => ({
      changes: changes.map(c => ({ ...c, committedAt: Date.now() + 3 * DAY })),
    }));
    sync = new PatchesSync(patches, makeConnection({ commitChanges }) as any);
    sync['updateState']({ connected: true });

    await (sync as any).syncDoc('doc1');

    expect(commitChanges).toHaveBeenCalledTimes(1);
    expect(Math.abs(clock.offset - 3 * DAY)).toBeLessThan(1000);
  });

  it('learns nothing from a failed commit', async () => {
    const store = new LWWInMemoryStore();
    const clock = new ServerClock({ storage: null });
    const algorithm = new LWWAlgorithm(store, { clock });
    const patches = new Patches({ algorithms: { lww: algorithm }, defaultAlgorithm: 'lww' });
    await patches.trackDocs(['doc1']);
    await algorithm.handleDocChange('doc1', [{ op: 'replace', path: '/a', value: 1 }], undefined, {});

    const observe = vi.spyOn(algorithm, 'observeCommitTiming');
    const commitChanges = vi.fn(async () => {
      throw new Error('offline');
    });
    sync = new PatchesSync(patches, makeConnection({ commitChanges }) as any);
    sync['updateState']({ connected: true });

    await (sync as any).syncDoc('doc1').catch(() => {});

    expect(observe).not.toHaveBeenCalled();
    expect(clock.offset).toBe(0);
  });
});

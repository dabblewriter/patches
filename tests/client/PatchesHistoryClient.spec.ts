import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchesHistoryClient } from '../../src/client/PatchesHistoryClient';
import type { Change, ListVersionsOptions, VersionMetadata } from '../../src/types.js';

function makeMockTransport() {
  const versions: VersionMetadata[] = [
    {
      id: 'v1',
      parentId: undefined,
      groupId: 'g1',
      origin: 'main',
      startDate: 1,
      endDate: 1,
      rev: 1,
      baseRev: 0,
    },
    {
      id: 'v2',
      parentId: 'v1',
      groupId: 'g1',
      origin: 'main',
      startDate: 2,
      endDate: 2,
      rev: 2,
      baseRev: 1,
    },
    {
      id: 'v3',
      parentId: 'v2',
      groupId: 'g2',
      origin: 'main',
      startDate: 3,
      endDate: 3,
      rev: 3,
      baseRev: 2,
    },
  ];
  const states: Record<string, any> = {
    v1: { foo: 1 },
    v2: { foo: 2 },
    v3: { foo: 3 },
  };
  const changes: Record<string, Change[]> = {
    v2: [
      {
        id: 'c1',
        ops: [{ op: 'replace', path: '/foo', value: 2 }],
        rev: 2,
        created: 2,
      },
    ],
    v3: [
      {
        id: 'c2',
        ops: [{ op: 'replace', path: '/foo', value: 3 }],
        rev: 3,
        created: 3,
      },
    ],
  };
  return {
    listVersions: vi.fn(async (_docId: string, _opts?: ListVersionsOptions) => versions),
    getVersionState: vi.fn(async (_docId: string, versionId: string) => states[versionId]),
    getVersionChanges: vi.fn(async (_docId: string, versionId: string) => changes[versionId] || []),
  };
}

describe('PatchesHistoryClient', () => {
  let transport: ReturnType<typeof makeMockTransport>;
  let client: PatchesHistoryClient<any>;

  beforeEach(() => {
    transport = makeMockTransport();
    client = new PatchesHistoryClient('doc-1', transport);
  });

  it('constructs with correct id and initial state', () => {
    expect(client.id).toBe('doc-1');
    expect(client.versions).toEqual([]);
    expect(client.state).toBe(null);
  });

  it('lists versions and emits onVersionsChange', async () => {
    const spy = vi.fn();
    client.onVersionsChange(spy);
    const result = await client.listVersions();
    expect(result.length).toBe(3);
    expect(client.versions[0].id).toBe('v1');
    expect(spy).toHaveBeenCalledWith(client.versions);
  });

  it('gets state at version and emits onStateChange', async () => {
    const spy = vi.fn();
    client.onStateChange(spy);
    await client.getStateAtVersion('v2');
    expect(client.state).toEqual({ foo: 2 });
    expect(spy).toHaveBeenCalledWith({ foo: 2 });
  });

  it('gets changes for a version and caches them', async () => {
    const changes = await client.getChangesForVersion('v2');
    expect(changes).toEqual([
      {
        id: 'c1',
        ops: [{ op: 'replace', path: '/foo', value: 2 }],
        rev: 2,
        created: 2,
      },
    ]);
    // Should use cache on second call
    await client.getChangesForVersion('v2');
    expect(transport.getVersionChanges).toHaveBeenCalledTimes(1);
  });

  it('scrubs to a change index and emits onStateChange', async () => {
    await client.listVersions();
    const spy = vi.fn();
    client.onStateChange(spy);
    // Scrub to 0 changes in v3: should get v2's state
    await client.scrubTo('v3', 0);
    expect(client.state).toEqual({ foo: 2 });
    expect(spy).toHaveBeenLastCalledWith({ foo: 2 });
    // Scrub to 1 change in v3: should get v3's state
    await client.scrubTo('v3', 1);
    expect(client.state).toEqual({ foo: 3 });
    expect(spy).toHaveBeenLastCalledWith({ foo: 3 });
  });

  it('clear() resets state, versions, and listeners', async () => {
    await client.listVersions();
    await client.getStateAtVersion('v2');
    const spyV = vi.fn();
    const spyS = vi.fn();
    client.onVersionsChange(spyV);
    client.onStateChange(spyS);
    client.clear();
    expect(client.versions).toEqual([]);
    expect(client.state).toBe(null);
    // Listeners should not be called after clear
    client.onVersionsChange(() => {
      throw new Error('should not be called');
    });
    client.onStateChange(() => {
      throw new Error('should not be called');
    });
  });

  it('handles transport errors', async () => {
    transport.getVersionState.mockRejectedValueOnce(new Error('fail'));
    await expect(client.getStateAtVersion('v2')).rejects.toThrow('fail');
  });
});

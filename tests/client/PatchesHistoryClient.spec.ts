import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PatchesHistoryClient } from '../../src/client/PatchesHistoryClient';
import type { JSONPatchOp } from '../../src/json-patch';
import type { PatchesAPI } from '../../src/net/protocol/types.js';
import type { Change, VersionMetadata } from '../../src/types';

// Define a helper type for a mocked PatchesAPI using Vitest
type MockedPatchesAPI = {
  [K in keyof PatchesAPI]: PatchesAPI[K] extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : PatchesAPI[K];
};

describe('PatchesHistoryClient', () => {
  let client: PatchesHistoryClient;
  let mockApi: MockedPatchesAPI;
  let onVersionsChangeHandler: Mock<(versions: VersionMetadata[]) => void>;
  let onStateChangeHandler: Mock<(state: any) => void>;

  const createMockVersion = (
    id: string,
    name: string,
    timestamp: number,
    rev: number,
    baseRev: number,
    parentId?: string,
    origin: 'main' | 'offline' | 'branch' = 'main'
  ): VersionMetadata => ({
    id,
    name,
    timestamp,
    parentId,
    origin,
    startDate: timestamp - 100, // Ensure this is a number
    endDate: timestamp, // Ensure this is a number
    rev, // Ensure this is a number
    baseRev, // Ensure this is a number
    // groupId and branchName can be undefined if optional
  });

  const mockVersionsInitial: VersionMetadata[] = [
    createMockVersion('v1', 'Version 1', Date.now() - 2000, 1, 0),
    createMockVersion('v2', 'Version 2', Date.now() - 1000, 2, 1, 'v1'),
    createMockVersion('v3', 'Version 3', Date.now(), 3, 2, 'v2'),
  ];
  let currentMockVersions: VersionMetadata[];

  beforeEach(() => {
    mockApi = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getDoc: vi.fn(),
      getChangesSince: vi.fn(),
      commitChanges: vi.fn(),
      deleteDoc: vi.fn(),
      createVersion: vi.fn(),
      listVersions: vi.fn(),
      getVersionState: vi.fn(),
      getVersionChanges: vi.fn(),
      updateVersion: vi.fn(),
    } as MockedPatchesAPI;

    client = new PatchesHistoryClient('doc1', mockApi);
    onVersionsChangeHandler = vi.fn();
    onStateChangeHandler = vi.fn();
    // Corrected subscription
    client.onVersionsChange(onVersionsChangeHandler);
    client.onStateChange(onStateChangeHandler);

    currentMockVersions = JSON.parse(JSON.stringify(mockVersionsInitial)); // Deep copy for isolation
    mockApi.listVersions.mockResolvedValue(currentMockVersions);
  });

  afterEach(() => {
    client.clear();
    vi.clearAllMocks();
  });

  it('should initialize with an ID', () => {
    expect(client.id).toBe('doc1');
  });

  it('should list versions and emit onVersionsChange', async () => {
    const versionsToReturn = [...currentMockVersions];
    mockApi.listVersions.mockResolvedValue(versionsToReturn);

    const versions = await client.listVersions();
    expect(versions).toEqual(versionsToReturn);
    expect(mockApi.listVersions).toHaveBeenCalledWith('doc1', undefined);
    expect(client.versions).toEqual(versionsToReturn);
    expect(onVersionsChangeHandler).toHaveBeenCalledWith(versionsToReturn);
  });

  it('should create a version and refresh the versions list', async () => {
    const newVersionId = 'v4';
    const newVersionName = 'New Version Name';
    const newVersionTimestamp = Date.now();
    const newVersionRev = 4;
    const newVersionBaseRev = 3;
    const newVersion = createMockVersion(
      newVersionId,
      newVersionName,
      newVersionTimestamp,
      newVersionRev,
      newVersionBaseRev,
      'v3'
    );
    const updatedMockVersions = [...currentMockVersions, newVersion];

    mockApi.createVersion.mockResolvedValue(newVersionId);
    mockApi.listVersions.mockResolvedValue(updatedMockVersions);

    const versionId = await client.createVersion(newVersionName);

    expect(mockApi.createVersion).toHaveBeenCalledWith('doc1', newVersionName);
    expect(versionId).toBe(newVersionId);
    expect(mockApi.listVersions).toHaveBeenCalledWith('doc1', undefined);
    expect(client.versions).toEqual(updatedMockVersions);
    // The onVersionsChangeHandler is called by listVersions, which gets the updatedMockVersions
    expect(onVersionsChangeHandler).toHaveBeenCalledWith(updatedMockVersions);
  });

  it('should update a version and refresh the versions list', async () => {
    const versionToUpdateId = 'v2';
    const updatedName = 'Updated Version Name';
    const updates = { name: updatedName };

    const versionsAfterUpdate = currentMockVersions.map(v =>
      v.id === versionToUpdateId ? { ...v, name: updatedName } : v
    );
    mockApi.updateVersion.mockResolvedValue(undefined);
    mockApi.listVersions.mockResolvedValue(versionsAfterUpdate);

    await client.updateVersion(versionToUpdateId, updates);

    expect(mockApi.updateVersion).toHaveBeenCalledWith('doc1', versionToUpdateId, updates);
    expect(mockApi.listVersions).toHaveBeenCalledWith('doc1', undefined);
    expect(client.versions).toEqual(versionsAfterUpdate);
    expect(onVersionsChangeHandler).toHaveBeenCalledWith(versionsAfterUpdate);
  });

  it('should load state for a specific version and cache it', async () => {
    const versionId = 'v2';
    const docState = { content: 'version 2 state' };
    const versionData = currentMockVersions.find(v => v.id === versionId)!;
    mockApi.getVersionState.mockResolvedValue({ state: docState, rev: versionData.rev });

    const result = await client.getStateAtVersion(versionId);
    expect(result).toEqual(docState);
    expect(mockApi.getVersionState).toHaveBeenCalledWith('doc1', versionId);
    expect(client.state).toEqual(docState);
    expect(onStateChangeHandler).toHaveBeenCalledWith(docState);

    await client.getStateAtVersion(versionId);
    const parentVersion = currentMockVersions.find(v => v.id === 'v2');
    expect(parentVersion).toBeDefined();

    const parentDocState = { content: 'version 2 state' };
    const versionChanges: Change[] = [
      {
        id: 'c1_v3',
        ops: [{ op: 'add', path: '/content', value: ' change 1' } as JSONPatchOp],
        rev: 3,
        created: Date.now(),
        baseRev: 2,
      },
      {
        id: 'c2_v3',
        ops: [{ op: 'add', path: '/content', value: ' change 2' } as JSONPatchOp],
        rev: 3,
        created: Date.now(),
        baseRev: 2,
      },
    ];
    const expectedState = { content: 'version 2 state change 1' }; // Note: applyChanges logic not tested here, just flow

    mockApi.getVersionState.mockResolvedValue({ state: parentDocState, rev: parentVersion!.rev }); // For parent v2
    mockApi.getVersionChanges.mockResolvedValue(versionChanges); // For v3

    // Prime client.versions if not already (though beforeEach does it)
    if (client.versions.length === 0) await client.listVersions();
    onStateChangeHandler.mockClear();

    await client.scrubTo(versionId, 1); // scrub to the first change

    expect(mockApi.getVersionState).toHaveBeenCalledWith('doc1', parentVersion!.id);
    expect(mockApi.getVersionChanges).toHaveBeenCalledWith('doc1', versionId);
    // This assertion depends on the actual applyChanges logic which is external to this client
    // For PatchesHistoryClient, we mainly test that it calls the right things and emits.
    // The actual state transformation might be better for an integration test or if applyChanges is mocked.
    expect(client.state).toEqual(expectedState);
    expect(onStateChangeHandler).toHaveBeenCalledWith(expectedState);
  });

  it('should scrub to a specific change within a version with no parent', async () => {
    const versionId = 'v1';
    const versionChanges: Change[] = [
      {
        id: 'c1_v1',
        ops: [{ op: 'add', path: '/content', value: ' change 1' } as JSONPatchOp],
        rev: 1,
        created: Date.now(),
        baseRev: 0,
      },
    ];
    const expectedState = { content: ' change 1' }; // Depends on applyChanges

    mockApi.getVersionChanges.mockResolvedValue(versionChanges);
    if (client.versions.length === 0) await client.listVersions();
    onStateChangeHandler.mockClear();

    await client.scrubTo(versionId, 1);

    expect(mockApi.getVersionState).not.toHaveBeenCalled();
    expect(mockApi.getVersionChanges).toHaveBeenCalledWith('doc1', versionId);
    expect(client.state).toEqual(expectedState);
    expect(onStateChangeHandler).toHaveBeenCalledWith(expectedState);
  });

  it('should clear versions, state, cache, and listeners', async () => {
    await client.listVersions();
    const v1DocState = { content: 'v1 state' };
    const v1VersionData = currentMockVersions.find(v => v.id === 'v1')!;
    mockApi.getVersionState.mockResolvedValue({ state: v1DocState, rev: v1VersionData.rev });
    await client.getStateAtVersion('v1');
    const getVersionStateCallCountBeforeClear = mockApi.getVersionState.mock.calls.length;

    onVersionsChangeHandler.mockClear();
    onStateChangeHandler.mockClear();

    client.clear();

    expect(client.versions).toEqual([]);
    expect(client.state).toBeNull();
    expect(onVersionsChangeHandler).toHaveBeenCalledWith([]);
    expect(onStateChangeHandler).toHaveBeenCalledWith(null);

    mockApi.getVersionState.mockResolvedValue({ state: v1DocState, rev: v1VersionData.rev });
    await client.getStateAtVersion('v1');
    // Should be called one more time than before clear, as cache is gone
    expect(mockApi.getVersionState.mock.calls.length).toBe(getVersionStateCallCountBeforeClear + 1);
  });
});

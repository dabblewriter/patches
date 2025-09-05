import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVersion } from '../../../src/algorithms/server/createVersion';
import { createChange } from '../../../src/data/change';
import * as versionModule from '../../../src/data/version';
import type { PatchesStoreBackend } from '../../../src/server/types';

// Mock the createVersionMetadata function
vi.mock('../../../src/data/version');
const main = 'main' as const;

describe('createVersion', () => {
  const mockCreateVersionMetadata = vi.mocked(versionModule.createVersionMetadata);
  let mockStore: PatchesStoreBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      createVersion: vi.fn(),
    } as any;
  });

  it('should create version with store persistence', async () => {
    const changes = [
      createChange(0, 1, [{ op: 'add', path: '/text', value: 'hello' }]),
      createChange(1, 2, [{ op: 'replace', path: '/text', value: 'world' }]),
    ];

    // Set specific timestamps for predictable testing
    changes[0].created = 1000;
    changes[1].created = 2000;

    const expectedVersionData = {
      origin: main,
      startDate: 1000,
      endDate: 2000,
      rev: 2,
      baseRev: 0,
    };

    const mockVersion = { ...expectedVersionData, id: 'version-123' };
    mockCreateVersionMetadata.mockReturnValue(mockVersion);

    const result = await createVersion(mockStore, 'doc1', { text: 'world' }, changes);

    expect(mockCreateVersionMetadata).toHaveBeenCalledWith(expectedVersionData);
    expect(mockStore.createVersion).toHaveBeenCalledWith('doc1', mockVersion, { text: 'world' }, changes);
    expect(result).toBe(mockVersion);
  });

  it('should merge additional metadata into version', async () => {
    const changes = [createChange(5, 6, [{ op: 'add', path: '/title', value: 'Document' }])];

    changes[0].created = 5000;

    const additionalMetadata = {
      name: 'My Version',
      description: 'Important milestone',
      tags: ['release', 'stable'],
    };

    const expectedVersionData = {
      origin: main,
      startDate: 5000,
      endDate: 5000,
      rev: 6,
      baseRev: 5,
      name: 'My Version',
      description: 'Important milestone',
      tags: ['release', 'stable'],
    };

    const mockVersion = { ...expectedVersionData, id: 'version-456' };
    mockCreateVersionMetadata.mockReturnValue(mockVersion);

    const result = await createVersion(mockStore, 'doc2', { title: 'Document' }, changes, additionalMetadata);

    expect(mockCreateVersionMetadata).toHaveBeenCalledWith(expectedVersionData);
    expect(mockStore.createVersion).toHaveBeenCalledWith('doc2', mockVersion, { title: 'Document' }, changes);
    expect(result).toBe(mockVersion);
  });

  it('should return undefined for empty changes array', async () => {
    const result = await createVersion(mockStore, 'doc1', { text: 'hello' }, []);

    expect(result).toBeUndefined();
    expect(mockCreateVersionMetadata).not.toHaveBeenCalled();
    expect(mockStore.createVersion).not.toHaveBeenCalled();
  });

  it('should throw error if baseRev is undefined', async () => {
    const changes = [createChange(0, 1, [{ op: 'add', path: '/text', value: 'hello' }])];
    changes[0].baseRev = undefined as any;

    await expect(createVersion(mockStore, 'doc1', { text: 'hello' }, changes)).rejects.toThrow(
      'Client changes must include baseRev for doc doc1.'
    );

    expect(mockCreateVersionMetadata).not.toHaveBeenCalled();
    expect(mockStore.createVersion).not.toHaveBeenCalled();
  });

  it('should handle single change correctly', async () => {
    const changes = [createChange(10, 11, [{ op: 'replace', path: '/status', value: 'complete' }])];

    changes[0].created = 7500;

    const expectedVersionData = {
      origin: main,
      startDate: 7500,
      endDate: 7500,
      rev: 11,
      baseRev: 10,
    };

    const mockVersion = { ...expectedVersionData, id: 'version-789' };
    mockCreateVersionMetadata.mockReturnValue(mockVersion);

    const result = await createVersion(mockStore, 'doc3', { status: 'complete' }, changes);

    expect(mockCreateVersionMetadata).toHaveBeenCalledWith(expectedVersionData);
    expect(mockStore.createVersion).toHaveBeenCalledWith('doc3', mockVersion, { status: 'complete' }, changes);
    expect(result).toBe(mockVersion);
  });

  it('should use first and last change timestamps for date range', async () => {
    const changes = [
      createChange(0, 1, [{ op: 'add', path: '/a', value: '1' }]),
      createChange(1, 2, [{ op: 'add', path: '/b', value: '2' }]),
      createChange(2, 3, [{ op: 'add', path: '/c', value: '3' }]),
      createChange(3, 4, [{ op: 'add', path: '/d', value: '4' }]),
    ];

    // Set timestamps out of order to ensure we use array position, not timestamp order
    changes[0].created = 1000; // First change
    changes[1].created = 500; // Earlier timestamp but not first
    changes[2].created = 3000; // Latest timestamp but not last
    changes[3].created = 2000; // Last change

    const expectedVersionData = {
      origin: main,
      startDate: 1000, // First change timestamp
      endDate: 2000, // Last change timestamp
      rev: 4,
      baseRev: 0,
    };

    const mockVersion = { ...expectedVersionData, id: 'version-multi' };
    mockCreateVersionMetadata.mockReturnValue(mockVersion);

    const state = { a: '1', b: '2', c: '3', d: '4' };
    const result = await createVersion(mockStore, 'doc4', state, changes);

    expect(mockCreateVersionMetadata).toHaveBeenCalledWith(expectedVersionData);
    expect(mockStore.createVersion).toHaveBeenCalledWith('doc4', mockVersion, state, changes);
    expect(result).toBe(mockVersion);
  });

  it('should override metadata properties correctly', async () => {
    const changes = [createChange(1, 2, [{ op: 'add', path: '/test', value: 'value' }])];

    changes[0].created = 9000;

    // Metadata that overrides some default properties
    const metadata = {
      name: 'Custom Version',
    };

    const expectedVersionData = {
      origin: main,
      startDate: 9000,
      endDate: 9000,
      rev: 2,
      baseRev: 1,
      name: 'Custom Version',
    };

    const mockVersion = { ...expectedVersionData, id: 'version-override' };
    mockCreateVersionMetadata.mockReturnValue(mockVersion);

    const result = await createVersion(mockStore, 'doc5', { test: 'value' }, changes, metadata);

    expect(mockCreateVersionMetadata).toHaveBeenCalledWith(expectedVersionData);
    expect(mockStore.createVersion).toHaveBeenCalledWith('doc5', mockVersion, { test: 'value' }, changes);
    expect(result).toBe(mockVersion);
  });

  it('should handle store errors gracefully', async () => {
    const changes = [createChange(0, 1, [{ op: 'add', path: '/text', value: 'hello' }])];
    changes[0].created = 1000;

    const mockVersion = { id: 'version-123', origin: main, startDate: 1000, endDate: 1000, rev: 1, baseRev: 0 };
    mockCreateVersionMetadata.mockReturnValue(mockVersion);

    const storeError = new Error('Storage failure');
    vi.mocked(mockStore.createVersion).mockRejectedValue(storeError);

    await expect(createVersion(mockStore, 'doc1', { text: 'hello' }, changes)).rejects.toThrow('Storage failure');

    expect(mockCreateVersionMetadata).toHaveBeenCalled();
    expect(mockStore.createVersion).toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONPatch } from '../../../src/json-patch/JSONPatch.js';
import type { JSONPatchOp } from '../../../src/json-patch/types.js';
import type { Change, PatchesSnapshot } from '../../../src/types.js';

// 1. Mock modules with factories returning new vi.fn() instances
vi.mock('../../../src/algorithms/client/createStateFromSnapshot.js', () => ({ createStateFromSnapshot: vi.fn() }));
vi.mock('../../../src/json-patch/createJSONPatch.js', () => ({ createJSONPatch: vi.fn() }));
vi.mock('../../../src/data/change.js', () => ({ createChange: vi.fn() }));
vi.mock('../../../src/algorithms/client/breakChange.js', () => ({ breakChange: vi.fn() }));

const mockJsonPatchInstanceApply = vi.fn();
vi.mock('../../../src/json-patch/JSONPatch.js', () => ({
  JSONPatch: vi.fn().mockImplementation((opsArgument?: JSONPatchOp[]) => ({
    ops: opsArgument || [],
    apply: mockJsonPatchInstanceApply,
    transform: vi.fn(),
    invert: vi.fn(),
  })),
}));

// 2. Import the functions/classes AFTER they have been mocked.
import { breakChange } from '../../../src/algorithms/client/breakChange.js';
import { createStateFromSnapshot } from '../../../src/algorithms/client/createStateFromSnapshot.js';
import { makeChange } from '../../../src/algorithms/client/makeChange.js';
import { createChange } from '../../../src/data/change.js';
import { createJSONPatch } from '../../../src/json-patch/createJSONPatch.js';
import { JSONPatch as ImportedJSONPatchConstructor } from '../../../src/json-patch/JSONPatch.js';

// 3. Cast the imported mocks for type safety in tests.
const mockedCreateStateFromSnapshot = vi.mocked(createStateFromSnapshot);
const mockedCreateJSONPatch = vi.mocked(createJSONPatch);
const mockedCreateChange = vi.mocked(createChange);
const mockedBreakChange = vi.mocked(breakChange);
const MockedJSONPatchClass = vi.mocked(ImportedJSONPatchConstructor);

describe('makeChange Algorithm', () => {
  const baseSnapshot: PatchesSnapshot<any> = {
    state: { initial: 'data' },
    rev: 5,
    changes: [{ id: 'p1', rev: 5, baseRev: 4, ops: [], created: Date.now() }],
  };
  const mockMutator = (draft: any, patch: JSONPatch) => {
    draft.newData = 'added';
  };
  const mockChangeMetadata = { user: 'testUser' };

  beforeEach(() => {
    mockedCreateStateFromSnapshot.mockReset();
    mockedCreateJSONPatch.mockReset();
    mockedCreateChange.mockReset();
    mockedBreakChange.mockReset();
    mockJsonPatchInstanceApply.mockReset();
    MockedJSONPatchClass.mockClear();

    mockedCreateStateFromSnapshot.mockReturnValue({ ...baseSnapshot.state });
    mockedCreateJSONPatch.mockImplementation((_state: any, _mutator: any) => {
      const ops: JSONPatchOp[] = [{ op: 'add', path: '/newData', value: 'added' }];
      const patchInstance = new MockedJSONPatchClass(ops);
      (patchInstance as any).apply = mockJsonPatchInstanceApply.mockReturnValue({ ..._state, newData: 'added' });
      (patchInstance as any).ops = ops;
      return patchInstance as unknown as JSONPatch;
    });
    mockedCreateChange.mockImplementation(
      (baseRev: number, rev: number, ops: JSONPatchOp[], metadata?: Record<string, any>): Change => ({
        id: `mock-change-${rev}`,
        baseRev,
        rev,
        ops,
        metadata,
        created: Date.now(),
      })
    );
    mockedBreakChange.mockImplementation((change: Change) => [change]);
  });

  it('should return empty array if mutator generates no ops', () => {
    const mockPatchWithNoOpsInstance = new MockedJSONPatchClass([]);
    (mockPatchWithNoOpsInstance as any).ops = []; // Ensure ops property is explicitly empty
    (mockPatchWithNoOpsInstance as any).apply = vi.fn(); // Apply won't be called
    mockedCreateJSONPatch.mockReturnValue(mockPatchWithNoOpsInstance as unknown as JSONPatch);

    const changes = makeChange(baseSnapshot, mockMutator, mockChangeMetadata);
    expect(changes).toEqual([]);
  });

  it('should create a single change if no breaking is needed', () => {
    const expectedRev = baseSnapshot.changes[0].rev + 1;
    const result = makeChange(baseSnapshot, mockMutator, mockChangeMetadata, undefined);

    expect(mockedCreateStateFromSnapshot).toHaveBeenCalledWith(baseSnapshot);
    expect(mockedCreateJSONPatch).toHaveBeenCalledOnce();
    expect(mockedCreateChange).toHaveBeenCalledWith(
      baseSnapshot.rev,
      expectedRev,
      [{ op: 'add', path: '/newData', value: 'added' }],
      mockChangeMetadata
    );
    expect(mockJsonPatchInstanceApply).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0].rev).toBe(expectedRev);
  });

  it('should use snapshot.rev as pendingRev if no pending changes exist', () => {
    const snapshotNoPending: PatchesSnapshot<any> = { ...baseSnapshot, changes: [] };
    const expectedRev = snapshotNoPending.rev + 1;
    makeChange(snapshotNoPending, mockMutator, mockChangeMetadata, undefined);
    expect(mockedCreateChange).toHaveBeenCalledWith(
      snapshotNoPending.rev,
      expectedRev,
      expect.any(Array),
      mockChangeMetadata
    );
  });

  it('should call breakChange and return its result if maxPayloadBytes is provided', () => {
    const initialChangeInstance: Change = { id: 'initial-c1', rev: 6, baseRev: 5, ops: [], created: Date.now() };
    mockedCreateChange.mockReturnValue(initialChangeInstance);

    const brokenPieces: Change[] = [
      { id: 'p1', baseRev: 5, rev: 6, ops: [{ op: 'add', path: '/newData', value: 'part1' }], created: Date.now() },
      { id: 'p2', baseRev: 5, rev: 7, ops: [{ op: 'add', path: '/newData', value: 'part2' }], created: Date.now() },
    ];
    mockedBreakChange.mockReturnValue(brokenPieces);

    const result = makeChange(baseSnapshot, mockMutator, mockChangeMetadata, 100);
    expect(mockedBreakChange).toHaveBeenCalledWith(initialChangeInstance, 100);
    expect(result).toBe(brokenPieces);
  });

  it('should propagate errors from patch.apply', () => {
    const applyError = new Error('Apply failed!');
    mockJsonPatchInstanceApply.mockImplementation(() => {
      throw applyError;
    });

    expect(() => makeChange(baseSnapshot, mockMutator)).toThrow();
  });
});

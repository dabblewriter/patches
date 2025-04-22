import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchDoc } from '../../src/client/PatchDoc';
import type { Change } from '../../src/types';
import * as utils from '../../src/utils'; // To mock applyChanges

// Mock the utils module
vi.mock('../../src/utils', async importOriginal => {
  const actual = await importOriginal<typeof utils>();
  return {
    ...actual,
    applyChanges: vi.fn(actual.applyChanges), // Mock applyChanges specifically
    rebaseChanges: vi.fn(actual.rebaseChanges), // Mock rebaseChanges as well
  };
});

// Mock crypto-id
vi.mock('crypto-id', () => ({
  createId: vi.fn(() => 'mock-id-' + Math.random().toString(36).substring(7)),
}));

describe('PatchDoc Error Handling', () => {
  let doc: PatchDoc<{ count: number }>;
  const mockApplyChanges = vi.mocked(utils.applyChanges);
  const mockRebaseChanges = vi.mocked(utils.rebaseChanges);

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mocks to default behavior (calling original implementation)
    mockApplyChanges.mockImplementation(utils.applyChanges);
    mockRebaseChanges.mockImplementation(utils.rebaseChanges);
    doc = new PatchDoc({ count: 0 });
  });

  it('should throw error from _recalculateLocalState if applyChanges fails during import', () => {
    const error = new Error('Apply failed!');
    mockApplyChanges.mockImplementation(() => {
      throw error;
    });

    const snapshot = {
      state: { count: 5 },
      rev: 1,
      changes: [],
    };

    // Expect the import call, which triggers _recalculateLocalState, to throw
    expect(() => doc.import(snapshot)).toThrow(error);
    // Verify console.error was called (as it happens before the throw)
    expect(console.error).toHaveBeenCalledWith('CRITICAL: Error recalculating local state after update:', error);
  });

  it('should throw error from _recalculateLocalState if applyChanges fails during applyServerConfirmation', () => {
    const error = new Error('Apply failed during confirmation!');
    const serverCommit: Change[] = [
      {
        id: 'server-change',
        ops: [{ op: 'replace', path: '/count', value: 1 }],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
      },
    ];

    // Make the doc think it's sending something
    doc.change(d => {
      d.count = 5;
    });
    doc.getUpdatesForServer(); // Moves change to _sendingChanges

    // Mock applyChanges to fail only during the recalculate step
    let callCount = 0;
    mockApplyChanges.mockImplementation((state, changes) => {
      callCount++;
      if (callCount === 1) {
        // First call applies server commit to _committedState (let it succeed)
        return utils.applyChanges(state, changes);
      } else {
        // Second call is _recalculateLocalState (make it fail)
        throw error;
      }
    });

    // Expect applyServerConfirmation, which triggers _recalculateLocalState, to throw
    expect(() => doc.applyServerConfirmation(serverCommit)).toThrow(
      new Error('Critical sync error applying external server update: ' + error.message)
    );
    expect(console.error).toHaveBeenCalledWith('Failed to apply external server update to committed state:', error);
    // Ensure the first applyChanges (for committed state) was called
    expect(callCount).toBe(2);
  });

  it('should throw error from _recalculateLocalState if applyChanges fails during applyExternalServerUpdate', () => {
    const error = new Error('Apply failed during external update!');
    const externalChanges: Change[] = [
      {
        id: 'external-change',
        ops: [{ op: 'replace', path: '/count', value: 1 }],
        rev: 1,
        baseRev: 0,
        created: Date.now(),
      },
    ];

    // Mock applyChanges to fail only during the recalculate step
    let callCount = 0;
    mockApplyChanges.mockImplementation((state, changes) => {
      callCount++;
      if (callCount === 1) {
        // First call applies external changes to _committedState (let it succeed)
        return utils.applyChanges(state, changes);
      } else {
        // Second call is _recalculateLocalState (make it fail)
        throw error;
      }
    });

    // Expect applyExternalServerUpdate, which triggers _recalculateLocalState, to throw
    expect(() => doc.applyExternalServerUpdate(externalChanges)).toThrow(
      new Error('Critical sync error applying external server update: ' + error.message)
    );
    expect(console.error).toHaveBeenCalledWith('Failed to apply external server update to committed state:', error);
    // Ensure the first applyChanges (for committed state) was called
    expect(callCount).toBe(2);
  });

  // Helper to spy on console methods
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

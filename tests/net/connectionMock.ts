import { signal } from 'easy-signal';
import { vi } from 'vitest';
import type { Change } from '../../src/types.js';

/**
 * A minimal mock PatchesConnection for PatchesSync specs: every method is a vi.fn with a
 * benign default, every signal is live. Override per test as needed.
 */
export function makeConnection(overrides: Record<string, any> = {}) {
  return {
    url: 'mock://server',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    subscribe: vi.fn(async (ids: string[]) => ids),
    unsubscribe: vi.fn(async () => {}),
    getDoc: vi.fn(async () => ({ state: null, rev: 0 })),
    getChangesSince: vi.fn(async () => []),
    commitChanges: vi.fn(async (_docId: string, changes: Change[]) => ({ changes })),
    deleteDoc: vi.fn(async () => {}),
    onStateChange: signal<(state: string) => void>(),
    onChangesCommitted: signal<(docId: string, changes: Change[]) => void>(),
    onDocDeleted: signal<(docId: string) => void>(),
    ...overrides,
  };
}

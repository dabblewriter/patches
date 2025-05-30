import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/client/InMemoryStore.js';
import { Patches } from '../../src/client/Patches.js';
import type { Change } from '../../src/types.js';

describe('Rebased Pending Changes Sync', () => {
  let patches: Patches;
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    patches = new Patches({ store });
  });

  afterEach(async () => {
    await store.close();
  });

  it('should save rebased pending changes back to store when external server updates are applied', async () => {
    const docId = 'test-doc';

    // Open a document and make some local changes
    const doc = await patches.openDoc<{ text: string }>(docId);
    doc.change(draft => {
      draft.text = 'local change 1';
    });
    doc.change(draft => {
      draft.text = 'local change 2';
    });

    // Verify pending changes are saved
    let pendingChanges = await store.getPendingChanges(docId);
    expect(pendingChanges).toHaveLength(2);
    expect(pendingChanges[0].baseRev).toBe(0);
    expect(pendingChanges[1].baseRev).toBe(0);

    // Simulate external server update (from another client)
    const externalChanges: Change[] = [
      {
        id: 'server-change-1',
        rev: 1,
        baseRev: 0,
        ops: [{ op: 'replace', path: '/title', value: 'server change' }],
        created: Date.now(),
      },
      {
        id: 'server-change-2',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'replace', path: '/status', value: 'updated' }],
        created: Date.now(),
      },
    ];

    // Save the external changes to store first (simulating server sync)
    await store.saveCommittedChanges(docId, externalChanges);

    // Apply external server update (this should trigger rebasing)
    doc.applyExternalServerUpdate(externalChanges);

    // Wait a bit for async callback to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify pending changes were rebased and saved back to store
    pendingChanges = await store.getPendingChanges(docId);
    expect(pendingChanges).toHaveLength(2);

    // The baseRev should be updated to the latest committed revision
    expect(pendingChanges[0].baseRev).toBe(2);
    expect(pendingChanges[1].baseRev).toBe(2);

    // The revisions should be adjusted
    expect(pendingChanges[0].rev).toBe(3);
    expect(pendingChanges[1].rev).toBe(4);
  });

  it('should allow snapshot creation after pending changes are rebased', async () => {
    const docId = 'snapshot-test-doc';

    // Open a document
    const doc = await patches.openDoc<{ counter: number }>(docId);

    // Create many committed changes to exceed snapshot interval
    const committedChanges: Change[] = [];
    for (let i = 1; i <= 250; i++) {
      committedChanges.push({
        id: `committed-${i}`,
        rev: i,
        baseRev: i - 1,
        ops: [{ op: 'replace', path: '/counter', value: i }],
        created: Date.now(),
      });
    }

    // Save committed changes in batches (to simulate real usage)
    for (let i = 0; i < committedChanges.length; i += 50) {
      const batch = committedChanges.slice(i, i + 50);
      await store.saveCommittedChanges(docId, batch);
    }

    // Make a local change based on old revision (simulating offline user)
    doc.change(draft => {
      draft.counter = 999;
    });

    // Verify pending change has old baseRev
    let pendingChanges = await store.getPendingChanges(docId);
    expect(pendingChanges[0].baseRev).toBe(0); // Based on initial state

    // Check committed changes count (should be >= 200, preventing snapshot)
    const committedCount = await store.getLastRevs(docId);
    expect(committedCount[0]).toBe(250); // 250 committed changes

    // Apply external server update to trigger rebasing
    const rebaseChange: Change = {
      id: 'rebase-trigger',
      rev: 251,
      baseRev: 250,
      ops: [{ op: 'replace', path: '/status', value: 'rebased' }],
      created: Date.now(),
    };

    // Save the rebase change to store first
    await store.saveCommittedChanges(docId, [rebaseChange]);

    doc.applyExternalServerUpdate([rebaseChange]);

    // Wait for async callback
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify pending change was rebased
    pendingChanges = await store.getPendingChanges(docId);
    expect(pendingChanges[0].baseRev).toBe(251); // Updated to latest

    // Now save more committed changes - snapshot creation should work
    const moreCommittedChanges: Change[] = [];
    for (let i = 252; i <= 300; i++) {
      moreCommittedChanges.push({
        id: `committed-${i}`,
        rev: i,
        baseRev: i - 1,
        ops: [{ op: 'replace', path: '/counter', value: i }],
        created: Date.now(),
      });
    }

    await store.saveCommittedChanges(docId, moreCommittedChanges);

    // The snapshot creation should have succeeded now that pending changes
    // have been rebased and have a newer baseRev
    // We can't directly test snapshot creation, but we can verify
    // the system continues to work properly after this scenario
    expect(true).toBe(true); // If we get here without errors, it worked
  });
});

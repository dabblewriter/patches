import { beforeEach, describe, expect, it } from 'vitest';
import { LWWAlgorithm } from '../../src/client/LWWAlgorithm';
import { LWWInMemoryStore } from '../../src/client/LWWInMemoryStore';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { createChange } from '../../src/data/change';

describe('OTAlgorithm.hasPending', () => {
  let store: OTInMemoryStore;
  let algorithm: OTAlgorithm;

  beforeEach(async () => {
    store = new OTInMemoryStore();
    algorithm = new OTAlgorithm(store);
    await store.trackDocs(['doc1']);
  });

  it('should return false when no pending changes', async () => {
    expect(await algorithm.hasPending('doc1')).toBe(false);
  });

  it('should return true when there are pending changes', async () => {
    const change = createChange(0, 1, [{ op: 'replace', path: '/title', value: 'hello' }]);
    await store.savePendingChanges('doc1', [change]);

    expect(await algorithm.hasPending('doc1')).toBe(true);
  });

  it('should return false for unknown doc', async () => {
    expect(await algorithm.hasPending('unknown')).toBe(false);
  });
});

describe('LWWAlgorithm.hasPending', () => {
  let store: LWWInMemoryStore;
  let algorithm: LWWAlgorithm;

  beforeEach(async () => {
    store = new LWWInMemoryStore();
    algorithm = new LWWAlgorithm(store);
    await store.trackDocs(['doc1']);
  });

  it('should return false when no pending ops or sending change', async () => {
    expect(await algorithm.hasPending('doc1')).toBe(false);
  });

  it('should return true when there are pending ops', async () => {
    await store.savePendingOps('doc1', [{ op: 'replace', path: '/title', value: 'hello', ts: 1000 }]);

    expect(await algorithm.hasPending('doc1')).toBe(true);
  });

  it('should return true when there is a sending change', async () => {
    // Save pending ops then move them to sending
    await store.savePendingOps('doc1', [{ op: 'replace', path: '/title', value: 'hello', ts: 1000 }]);
    const change = createChange(0, 1, [{ op: 'replace', path: '/title', value: 'hello', ts: 1000 }]);
    await store.saveSendingChange('doc1', change);

    // pendingOps are cleared by saveSendingChange, but sendingChange exists
    expect(await algorithm.hasPending('doc1')).toBe(true);
  });

  it('should return true when both sending change and pending ops exist', async () => {
    // Create a sending change
    const change = createChange(0, 1, [{ op: 'replace', path: '/title', value: 'hello', ts: 1000 }]);
    await store.saveSendingChange('doc1', change);

    // Add new pending ops while sending
    await store.savePendingOps('doc1', [{ op: 'replace', path: '/name', value: 'world', ts: 2000 }]);

    expect(await algorithm.hasPending('doc1')).toBe(true);
  });

  it('should return false for unknown doc', async () => {
    expect(await algorithm.hasPending('unknown')).toBe(false);
  });

  it('should not have side effects (should not move pending to sending)', async () => {
    await store.savePendingOps('doc1', [{ op: 'replace', path: '/title', value: 'hello', ts: 1000 }]);

    // Call hasPending - should NOT create a sending change
    await algorithm.hasPending('doc1');

    // Verify pendingOps still exist and no sending change was created
    const pendingOps = await store.getPendingOps('doc1');
    const sendingChange = await store.getSendingChange('doc1');
    expect(pendingOps.length).toBe(1);
    expect(sendingChange).toBeNull();
  });
});

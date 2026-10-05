import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import { Patches } from '../../src/client/Patches';
import { createChange } from '../../src/data/change';

/**
 * `onPendingDropped` over real OTAlgorithm / OTInMemoryStore / OTDoc instances: what the app
 * is handed when hydration drops part of a stored queue.
 */
describe('Patches onPendingDropped integration', () => {
  let patches: InstanceType<typeof Patches>;

  afterEach(async () => {
    await patches.close();
    vi.restoreAllMocks();
  });

  it('reports a create dropped at hydration together with the change built on it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new OTInMemoryStore();
    patches = new Patches({ algorithms: { ot: new OTAlgorithm(store) } });
    await store.trackDocs(['doc1']);
    await store.saveDoc('doc1', { state: { docs: { group: { id: 'group', children: [] } } }, rev: 31 });
    // The listing index is one past the end of `group.children`, so the create fails strict apply.
    const create = createChange(31, 32, [
      { op: 'add', path: '/docs/timeline', value: { id: 'timeline', type: 'timeline', children: ['track'] } },
      { op: 'add', path: '/docs/group/children/1', value: 'timeline' },
    ]);
    const addChild = createChange(31, 33, [
      { op: 'add', path: '/docs/event', value: { id: 'event', type: 'event' } },
      { op: 'add', path: '/docs/timeline/children/1', value: 'event' },
    ]);
    const independent = createChange(31, 34, [{ op: 'add', path: '/docs/note', value: { id: 'note', type: 'note' } }]);
    await store.savePendingChanges('doc1', [create, addChild, independent]);
    const reports: { docId: string; ids: string[] }[] = [];
    patches.onPendingDropped((docId, dropped) => {
      reports.push({ docId, ids: dropped.map(c => c.id) });
    });

    const doc = await patches.openDoc<any>('doc1');

    expect(reports).toEqual([{ docId: 'doc1', ids: [create.id, addChild.id] }]);
    expect(doc.state).toEqual({
      docs: { group: { id: 'group', children: [] }, note: { id: 'note', type: 'note' } },
    });
  });
});

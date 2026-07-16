import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { IndexedDBStore } from '../../src/client/IndexedDBStore';
import { OTIndexedDBStore } from '../../src/client/OTIndexedDBStore';
import { createChange } from '../../src/data/change';

/**
 * OT quarantine contract on the real IndexedDB store (fake-indexeddb). The happy paths are
 * covered at the algorithm level over the in-memory store; this suite pins the external-mode
 * failure posture, where the host owns the database and hasn't upgraded it yet.
 */
let dbSeq = 0;
const docId = 'doc1';

describe('OTIndexedDBStore quarantine (real store over fake-indexeddb)', () => {
  it('throws (never null) when quarantining against an external-mode DB missing quarantinedChanges', async () => {
    // A pre-quarantine database the host owns: every OT store except quarantinedChanges.
    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`ot-quarantine-external-${dbSeq++}`, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('docs', { keyPath: 'docId' }).createIndex('algorithm', 'algorithm', { unique: false });
        db.createObjectStore('snapshots', { keyPath: 'docId' });
        const branchStore = db.createObjectStore('branches', { keyPath: 'id' });
        branchStore.createIndex('_docId', '_docId', { unique: false });
        branchStore.createIndex('_pending', '_pending', { unique: false });
        db.createObjectStore('committedChanges', { keyPath: ['docId', 'rev'] });
        db.createObjectStore('pendingChanges', { keyPath: ['docId', 'rev'] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const external = new OTIndexedDBStore(new IndexedDBStore(rawDb));

    await external.trackDocs([docId]);
    const poison = createChange(1, 2, [{ op: 'replace', path: '/title', value: 'y' }], {}, 'poison');
    await external.savePendingChanges(docId, [poison]);

    // Ejection must THROW, matching LWW (whose transaction raises on the same condition)
    // and the eject contract: null means "nothing to eject", and a consent-path caller
    // reading null as resolved while the doc is still wedged is the conflation the throw
    // prevents. Nothing is mutated.
    await expect(external.quarantinePendingChange(docId, poison, 'rejected', [])).rejects.toThrow(
      /quarantinedChanges.*missing|missing.*quarantinedChanges/
    );
    expect((await external.getPendingChanges(docId)).map(c => c.id)).toEqual(['poison']);

    // Read paths stay inert, not explosive: list returns [] and discard is a no-op.
    expect(await external.listQuarantinedChanges(docId)).toEqual([]);
    await external.discardQuarantinedChange(docId, 'poison');

    // The missing store was reported loudly at open.
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('quarantinedChanges'));
    consoleSpy.mockRestore();
  });
});

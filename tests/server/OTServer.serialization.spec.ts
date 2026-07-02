import { describe, expect, it } from 'vitest';
import { OTServer } from '../../src/server/OTServer';
import type { OTStoreBackend, TombstoneStoreBackend } from '../../src/server/types';
import type {
  Change,
  ChangeInput,
  DocumentTombstone,
  EditableVersionMetadata,
  ListChangesOptions,
  ListVersionsOptions,
  VersionMetadata,
} from '../../src/types';

/**
 * Minimal in-memory OT store with tombstone support and a gate on saveChanges so tests
 * can hold a commit in-flight while other operations race it.
 */
class GatedOTStore implements OTStoreBackend, TombstoneStoreBackend {
  changes = new Map<string, Change[]>();
  tombstones = new Map<string, DocumentTombstone>();
  saveGate: Promise<void> | null = null;

  async getCurrentRev(docId: string): Promise<number> {
    return this.changes.get(docId)?.at(-1)?.rev ?? 0;
  }

  async saveChanges(docId: string, changes: Change[]): Promise<void> {
    if (this.saveGate) await this.saveGate;
    const existing = this.changes.get(docId) ?? [];
    this.changes.set(docId, [...existing, ...changes]);
  }

  async listChanges(docId: string, options: ListChangesOptions = {}): Promise<Change[]> {
    let changes = this.changes.get(docId) ?? [];
    if (options.startAfter !== undefined) changes = changes.filter(c => c.rev > options.startAfter!);
    if (options.endBefore !== undefined) changes = changes.filter(c => c.rev < options.endBefore!);
    if (options.reverse) changes = [...changes].reverse();
    if (options.limit !== undefined) changes = changes.slice(0, options.limit);
    return changes;
  }

  async deleteDoc(docId: string): Promise<void> {
    this.changes.delete(docId);
  }

  async createVersion(_docId: string, _metadata: VersionMetadata, _changes?: Change[]): Promise<void> {}
  async listVersions(_docId: string, _options: ListVersionsOptions): Promise<VersionMetadata[]> {
    return [];
  }
  async loadVersion(_docId: string, _versionId: string): Promise<VersionMetadata | undefined> {
    return undefined;
  }
  async loadVersionState(_docId: string, _versionId: string): Promise<string | undefined> {
    return undefined;
  }
  async updateVersion(_docId: string, _versionId: string, _metadata: EditableVersionMetadata): Promise<void> {}

  async createTombstone(tombstone: DocumentTombstone): Promise<void> {
    this.tombstones.set(tombstone.docId, tombstone);
  }
  async getTombstone(docId: string): Promise<DocumentTombstone | undefined> {
    return this.tombstones.get(docId);
  }
  async removeTombstone(docId: string): Promise<void> {
    this.tombstones.delete(docId);
  }
}

function change(id: string, baseRev: number, path: string): ChangeInput {
  return { id, baseRev, rev: baseRev + 1, ops: [{ op: 'add', path, value: id }] };
}

describe('OTServer per-doc serialization', () => {
  it('deleteDoc waits for an in-flight commit — no orphan change tail after the wipe', async () => {
    const store = new GatedOTStore();
    const server = new OTServer(store);

    await server.commitChanges('doc1', [change('c1', 0, '/a')]);
    await server.commitChanges('doc1', [change('c2', 1, '/b')]);

    // Hold the third commit in-flight at saveChanges
    let release!: () => void;
    store.saveGate = new Promise<void>(resolve => (release = resolve));
    const commit = server.commitChanges('doc1', [change('c3', 2, '/c')]);

    let deleted = false;
    const del = server.deleteDoc('doc1').then(() => (deleted = true));

    // The delete must queue behind the in-flight commit, not run inside its window
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(deleted).toBe(false);

    release();
    store.saveGate = null;
    await commit;
    await del;

    // The commit landed first (tombstone saw rev 3), then the delete wiped everything —
    // no live tombstone alongside an orphan change tail.
    expect(await store.listChanges('doc1')).toEqual([]);
    expect((await store.getTombstone('doc1'))?.lastRev).toBe(3);
  });

  it('undeleteDoc queues behind an in-flight deleteDoc', async () => {
    const store = new GatedOTStore();
    const server = new OTServer(store);

    await server.commitChanges('doc1', [change('c1', 0, '/a')]);

    // Hold deleteDoc open by gating the store wipe
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const originalDeleteDoc = store.deleteDoc.bind(store);
    store.deleteDoc = async (docId: string) => {
      await gate;
      return originalDeleteDoc(docId);
    };

    const del = server.deleteDoc('doc1');
    let undeleted: boolean | undefined;
    const undel = server.undeleteDoc('doc1').then(result => (undeleted = result));

    // The undelete must queue behind the in-flight delete, not run inside its window
    // (it would remove the tombstone before the wipe, leaving the doc gone untracked)
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(undeleted).toBeUndefined();

    release();
    await del;
    await undel;

    // The undelete ran after the delete completed, so it found and removed the tombstone
    expect(undeleted).toBe(true);
    expect(await store.getTombstone('doc1')).toBeUndefined();
  });
});

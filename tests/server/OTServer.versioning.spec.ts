import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVersionState } from '../../src/algorithms/ot/server/buildVersionState';
import { createChange } from '../../src/data/change';
import type { JSONPatchOp } from '../../src/json-patch/types';
import { OTServer } from '../../src/server/OTServer';
import type { Change, VersionMetadata } from '../../src/types';
import { OTFuzzBackend } from '../fuzz/otFuzzBackend';

/**
 * End-to-end versioning against a real store. The backend builds version state through the
 * exported `buildVersionState`, like a production store does — so the `listChanges` calls it
 * makes are exactly the reads that hit the database.
 */
class VersionBuildingBackend extends OTFuzzBackend {
  async createVersion(docId: string, metadata: VersionMetadata, changes: Change[] = []): Promise<void> {
    await buildVersionState(this, docId, metadata, changes);
    await super.createVersion(docId, metadata, changes);
  }
}

const DOC = 'projects/p1/content';

describe('OTServer versioning', () => {
  let store: VersionBuildingBackend;
  let server: OTServer;

  beforeEach(() => {
    store = new VersionBuildingBackend();
    server = new OTServer(store);
  });

  const commit = (rev: number, ops: JSONPatchOp[]) => server.commitChanges(DOC, [createChange(rev - 1, rev, ops)]);

  const addWord = (rev: number, word: string) => commit(rev, [{ op: 'add', path: `/words/-`, value: word }]);

  /** The rev each `listChanges` call started reading after; `0` is a full-history replay. */
  const readsFrom = () =>
    vi.mocked(store.listChanges).mock.calls.map(([, options]) => options?.startAfter ?? 0) as number[];

  async function seedDoc() {
    await commit(1, [{ op: 'replace', path: '', value: { words: [] } }]);
    await addWord(2, 'one');
    await addWord(3, 'two');
  }

  it('chains a captured version to the latest main version, without replaying from rev 1', async () => {
    await seedDoc();
    const first = await server.captureCurrentVersion(DOC, { name: 'first' });
    await addWord(4, 'three');
    await addWord(5, 'four');

    vi.spyOn(store, 'listChanges');
    const second = await server.captureCurrentVersion(DOC, { name: 'second' });

    const version = (await store.loadVersion(DOC, second!))!;
    expect(version.parentId).toBe(first);
    expect(version.startRev).toBe(4);
    expect(version.endRev).toBe(5);

    // The base state comes from the parent's snapshot, so nothing re-reads the log from rev 1.
    expect(readsFrom()).not.toContain(0);

    // …and the version it built is still the true state at rev 5.
    expect(JSON.parse((await store.loadVersionState(DOC, second!))!)).toEqual({
      words: ['one', 'two', 'three', 'four'],
    });
  });

  it('captures the first version of a document with no parent', async () => {
    await seedDoc();

    const first = await server.captureCurrentVersion(DOC, { name: 'first' });

    const version = (await store.loadVersion(DOC, first!))!;
    expect(version.parentId).toBeUndefined();
    expect(version.startRev).toBe(1);
    expect(version.endRev).toBe(3);
    expect(JSON.parse((await store.loadVersionState(DOC, first!))!)).toEqual({ words: ['one', 'two'] });
  });

  it('captures nothing when no changes have landed since the last version', async () => {
    await seedDoc();
    await server.captureCurrentVersion(DOC);

    expect(await server.captureCurrentVersion(DOC)).toBeNull();
  });

  it('keeps the chain unbroken across successive captures', async () => {
    await seedDoc();
    const first = await server.captureCurrentVersion(DOC);
    await addWord(4, 'three');
    const second = await server.captureCurrentVersion(DOC);
    await addWord(5, 'four');
    const third = await server.captureCurrentVersion(DOC);

    expect((await store.loadVersion(DOC, second!))!.parentId).toBe(first);
    expect((await store.loadVersion(DOC, third!))!.parentId).toBe(second);
  });
});

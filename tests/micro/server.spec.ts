import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { CompactionError, MemoryDbBackend, MicroServer } from '../../src/micro/index.js';
import type { Change, ObjectStore } from '../../src/micro/index.js';

const memStore = (): ObjectStore => {
  const data = new Map<string, any>();
  return {
    async put(key, value) {
      data.set(key, value);
      return key;
    },
    async get(ref) {
      return data.get(ref);
    },
    async del(ref) {
      data.delete(ref);
    },
  };
};

describe('MicroServer.commitChanges', () => {
  it('commits max on an empty field, including strings and negatives', async () => {
    const server = new MicroServer(new MemoryDbBackend());
    const r1 = await server.commitChanges('d', { id: 'c1', rev: 0, fields: { name: { op: '^', val: 'abc', ts: 1 } } });
    expect(r1.fields.name.val).toBe('abc');
    const r2 = await server.commitChanges('d', { id: 'c2', rev: 1, fields: { low: { op: '^', val: -5, ts: 2 } } });
    expect(r2.fields.low.val).toBe(-5);
  });

  it('tombstones descendants when a parent is set or deleted', async () => {
    const db = new MemoryDbBackend();
    const server = new MicroServer(db);
    await server.commitChanges('d', { id: 'c1', rev: 0, fields: { 'user.name': { op: '=', val: 'x', ts: 1 } } });
    const r = await server.commitChanges('d', { id: 'c2', rev: 1, fields: { user: { op: '!', val: null, ts: 2 } } });
    expect(r.fields['user.name']).toEqual({ op: '!', val: null, ts: 2 });
    expect((await db.getField('d', 'user.name'))?.val).toBeNull();
  });

  it('serializes concurrent commits (non-atomic backend)', async () => {
    const db = new MemoryDbBackend();
    (db as any).commit = undefined;
    const server = new MicroServer(db);
    await Promise.all([
      server.commitChanges('d', {
        id: 'a',
        rev: 0,
        fields: { t: { op: '#', val: new Delta().insert('x').ops, ts: 1 } },
      }),
      server.commitChanges('d', {
        id: 'b',
        rev: 0,
        fields: { t: { op: '#', val: new Delta().insert('y').ops, ts: 2 } },
      }),
      server.commitChanges('d', { id: 'c', rev: 0, fields: { n: { op: '+', val: 1, ts: 3 } } }),
    ]);
    expect(await db.getRev('d')).toBe(3);
    const log = await db.getTextLog('d', 't', 0);
    expect(log.map(e => e.rev)).toEqual([1, 2]);
  });

  it('returns the committed resolution for a retried change instead of empty fields', async () => {
    const db = new MemoryDbBackend();
    const server = new MicroServer(db);
    const change: Change = { id: 'c1', rev: 0, fields: { n: { op: '+', val: 5, ts: 1 } } };
    await server.commitChanges('d', change);
    await server.commitChanges('d', { id: 'c2', rev: 1, fields: { m: { op: '=', val: 1, ts: 2 } } });
    const replay = await server.commitChanges('d', change);
    expect(replay.rev).toBe(2);
    expect(replay.fields.n.val).toBe(5); // committed value, not re-applied, not {}
    expect((await db.getField('d', 'n'))!.val).toBe(5);
  });

  it('broadcasts with the change id so senders can ignore their echo', async () => {
    const server = new MicroServer(new MemoryDbBackend());
    let seen: { rev: number; changeId: string } | null = null;
    server.subscribe('d', (_fields, rev, changeId) => (seen = { rev, changeId }));
    await server.commitChanges('d', { id: 'c1', rev: 0, fields: { n: { op: '=', val: 1, ts: 1 } } });
    expect(seen).toEqual({ rev: 1, changeId: 'c1' });
  });
});

describe('MicroServer large values', () => {
  const bigText = () => new Delta().insert('a'.repeat(70000));

  it('offloads oversized values but never leaks refs to reads or results', async () => {
    const db = new MemoryDbBackend();
    const objects = memStore();
    const server = new MicroServer(db, objects);
    const r = await server.commitChanges('d', {
      id: 'c1',
      rev: 0,
      fields: { blob: { op: '=', val: 'z'.repeat(70000), ts: 1 } },
    });
    expect(typeof r.fields.blob.val).toBe('string'); // result carries the real value
    expect((await db.getField('d', 'blob'))!.val.__ref).toBeDefined(); // stored as ref
    const doc = await server.getDoc('d');
    expect(typeof doc.fields.blob.val).toBe('string'); // reads hydrate
  });

  it('appending to an offloaded text field preserves the text', async () => {
    const db = new MemoryDbBackend();
    const server = new MicroServer(db, memStore());
    await server.commitChanges('d', { id: 'c1', rev: 0, fields: { t: { op: '#', val: bigText().ops, ts: 1 } } });
    await server.commitChanges('d', {
      id: 'c2',
      rev: 1,
      fields: { t: { op: '#', val: new Delta().retain(70000).insert('b').ops, ts: 2 } },
    });
    const doc = await server.getDoc('d');
    const text = new Delta(doc.fields.t.val);
    expect(text.length()).toBe(70001);
  });
});

describe('MicroServer text log compaction', () => {
  const insertAt0 = (ch: string) => new Delta().insert(ch).ops;

  async function seedLog(server: MicroServer) {
    for (let i = 0; i < 3; i++) {
      await server.commitChanges('d', {
        id: `c${i}`,
        rev: i,
        fields: { t: { op: '#', val: insertAt0('x'), ts: i + 1 } },
      });
    }
  }

  it('records the compacted range', async () => {
    const db = new MemoryDbBackend();
    const server = new MicroServer(db);
    await seedLog(server);
    await server.compactTextLog('d', 't', 3);
    const log = await db.getTextLog('d', 't', 0);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ rev: 3, startRev: 0 });
  });

  it('rejects a commit whose base rev falls inside a compacted range', async () => {
    const db = new MemoryDbBackend();
    const server = new MicroServer(db);
    await seedLog(server);
    await server.compactTextLog('d', 't', 3);
    await expect(
      server.commitChanges('d', { id: 'late', rev: 1, fields: { t: { op: '#', val: insertAt0('y'), ts: 9 } } })
    ).rejects.toThrow(CompactionError);
    // A base rev at the range start is still transformable
    const ok = await server.commitChanges('d', {
      id: 'edge',
      rev: 0,
      fields: { t: { op: '#', val: insertAt0('y'), ts: 9 } },
    });
    expect(ok.rev).toBe(4);
  });

  it('omits straddled keys from getChangesSince textLog and short-circuits when current', async () => {
    const db = new MemoryDbBackend();
    const server = new MicroServer(db);
    await seedLog(server);
    await server.compactTextLog('d', 't', 3);
    const straddled = await server.getChangesSince('d', 1);
    expect(straddled.textLog.t).toBeUndefined();
    const fromStart = await server.getChangesSince('d', 0);
    expect(fromStart.textLog.t).toHaveLength(1);
    const current = await server.getChangesSince('d', 3);
    expect(current.textLog).toEqual({});
  });
});

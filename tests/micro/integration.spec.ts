import { Delta } from '@dabble/delta';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDbBackend, MicroDoc, MicroServer } from '../../src/micro/index.js';
import type { FieldMap } from '../../src/micro/index.js';

interface Broadcast {
  fields: FieldMap;
  rev: number;
  changeId: string;
}

/** Wire a doc to a server the way MicroClient does, with manual delivery control. */
function connect(server: MicroServer, docId: string) {
  const queue: Broadcast[] = [];
  server.subscribe(docId, (fields, rev, changeId) => queue.push({ fields, rev, changeId }));
  return {
    deliverAll(doc: MicroDoc<any>) {
      while (queue.length) {
        const b = queue.shift()!;
        doc.applyRemote(b.fields, b.rev, b.changeId);
      }
    },
    async commit(doc: MicroDoc<any>) {
      const change = doc._flush();
      if (!change) return null;
      return server.commitChanges(docId, change);
    },
    async resync(doc: MicroDoc<any>) {
      doc._applySync(await server.getChangesSince(docId, doc.rev));
    },
  };
}

const text = async (db: MemoryDbBackend, docId: string, key: string) =>
  JSON.stringify(new Delta((await db.getField(docId, key))!.val).ops);

const clientText = (doc: MicroDoc<any>) => JSON.stringify(new Delta((doc.state as any).content ?? []).ops);

describe('micro integration', () => {
  let db: MemoryDbBackend;
  let server: MicroServer;

  beforeEach(() => {
    db = new MemoryDbBackend();
    server = new MicroServer(db);
  });

  it('converges with no duplication when the confirm arrives before the echo', async () => {
    const doc = new MicroDoc<{ content: Delta }>();
    const conn = connect(server, 'd');

    doc.update(d => d.content.txt(new Delta().insert('abc')));
    const result = await conn.commit(doc);
    doc._confirmSend(result!);
    conn.deliverAll(doc); // own echo arrives late

    expect(clientText(doc)).toBe(await text(db, 'd', 'content'));
    expect(clientText(doc)).toBe(JSON.stringify(new Delta().insert('abc').ops));
  });

  it('converges with no duplication when the echo arrives before the confirm', async () => {
    const doc = new MicroDoc<{ content: Delta }>();
    const conn = connect(server, 'd');

    doc.update(d => d.content.txt(new Delta().insert('abc')));
    const result = await server.commitChanges('d', doc._flush()!);
    conn.deliverAll(doc); // echo first
    doc._confirmSend(result);

    expect(clientText(doc)).toBe(await text(db, 'd', 'content'));
  });

  it('increments are not double-counted through the echo', async () => {
    await server.commitChanges('d', { id: 'seed', rev: 0, fields: { views: { op: '=', val: 10, ts: 1 } } });
    const doc = new MicroDoc<{ views: number }>({ views: { op: '=', val: 10, ts: 1 } }, {}, 1);
    const conn = connect(server, 'd');

    doc.update(d => d.views.inc(1));
    const result = await conn.commit(doc);
    conn.deliverAll(doc); // echo before confirm
    doc._confirmSend(result!);
    conn.deliverAll(doc);

    expect((doc.state as any).views).toBe(11);
    expect((await db.getField('d', 'views'))!.val).toBe(11);
  });

  it('heals the confirm-before-concurrent-broadcast race via resync', async () => {
    const base = new Delta().insert('base ');
    await server.commitChanges('d', { id: 'seed', rev: 0, fields: { content: { op: '#', val: base.ops, ts: 1 } } });

    const doc = new MicroDoc<{ content: Delta }>({ content: { op: '#', val: base.ops, ts: 1 } }, {}, 1);
    const conn = connect(server, 'd');

    // A types at position 3 while B concurrently inserts at position 5
    doc.update(d => d.content.txt(new Delta().retain(3).insert('abc')));
    const changeA = doc._flush()!;
    await server.commitChanges('d', {
      id: 'b1',
      rev: 1,
      fields: { content: { op: '#', val: new Delta().retain(5).insert('ZZZ').ops, ts: 2 } },
    });
    const resultA = await server.commitChanges('d', changeA);

    // POST response first: rev gap detected, resync instead of guessing
    doc._confirmSend(resultA);
    expect(doc.needsResync).toBe(true);
    await conn.resync(doc);
    conn.deliverAll(doc); // late broadcasts are stale now and ignored

    expect(clientText(doc)).toBe(await text(db, 'd', 'content'));
  });

  it('two clients editing concurrently converge', async () => {
    const a = new MicroDoc<{ content: Delta }>();
    const b = new MicroDoc<{ content: Delta }>();
    const connA = connect(server, 'd');
    const connB = connect(server, 'd');

    a.update(d => d.content.txt(new Delta().insert('aaa')));
    b.update(d => d.content.txt(new Delta().insert('bbb')));
    const changeA = a._flush()!;
    const changeB = b._flush()!;
    const [resultA, resultB] = await Promise.all([
      server.commitChanges('d', changeA),
      server.commitChanges('d', changeB),
    ]);

    connA.deliverAll(a);
    a._confirmSend(resultA);
    connA.deliverAll(a);
    b._confirmSend(resultB);
    connB.deliverAll(b);
    if (a.needsResync) await connA.resync(a);
    if (b.needsResync) await connB.resync(b);

    const serverText = await text(db, 'd', 'content');
    expect(clientText(a)).toBe(serverText);
    expect(clientText(b)).toBe(serverText);
  });

  it('a crash mid-send re-sends the same change id and is deduplicated', async () => {
    const doc = new MicroDoc<{ n: number }>();
    doc.update(d => d.n.inc(5));
    const change = doc._flush()!;

    // Committed server-side but the response was lost, then the app crashed.
    await server.commitChanges('d', change);

    // Reopen from the persisted snapshot: confirmed + pending + in-flight send.
    const restored = new MicroDoc<{ n: number }>(doc.confirmed, doc.pending, doc.rev, {
      id: change.id,
      fields: change.fields,
    });
    const resend = restored._flush()!;
    expect(resend.id).toBe(change.id);
    const result = await server.commitChanges('d', resend);
    restored._confirmSend(result);

    expect((await db.getField('d', 'n'))!.val).toBe(5); // applied once
    expect((restored.state as any).n).toBe(5);
    expect(restored.isSending).toBe(false);
  });
});

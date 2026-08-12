import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { MicroDoc } from '../../src/micro/index.js';

describe('MicroDoc.update', () => {
  it('consolidates same-path ops within one update call', () => {
    const doc = new MicroDoc<{ n: number }>();
    doc.update(d => {
      d.n.inc(1);
      d.n.inc(2);
    });
    expect((doc.state as any).n).toBe(3);
  });

  it('supports max on an empty field, including negatives', () => {
    const doc = new MicroDoc<{ low: number }>();
    doc.update(d => d.low.max(-3));
    expect((doc.state as any).low).toBe(-3);
  });

  it('rejects operations on the document root', () => {
    const doc = new MicroDoc<{ a: number }>();
    expect(() => doc.update(d => (d as any).set({ a: 1 }))).toThrow(/root/);
  });

  it('rejects field names containing a dot', () => {
    const doc = new MicroDoc<any>();
    expect(() => doc.update(d => (d as any).files['notes.txt'].set(1))).toThrow(/"."/);
  });

  it('tolerates symbol access on nested updaters', () => {
    const doc = new MicroDoc<{ user: { name: string } }>();
    doc.update(d => {
      expect((d as any).user[Symbol.toStringTag]).toBeUndefined();
      d.user.name.set('a');
    });
    expect((doc.state as any).user.name).toBe('a');
  });

  it('deleting a parent hides dot-notation children', () => {
    const doc = new MicroDoc<{ user: { name: string } }>({ 'user.name': { op: '=', val: 'x', ts: 1 } });
    doc.update(d => d.user.del());
    expect((doc.state as any).user).toBeUndefined();
  });
});

describe('MicroDoc flush/confirm/fail', () => {
  it('re-flushing an unconfirmed send returns the SAME change id', () => {
    const doc = new MicroDoc<{ n: number }>();
    doc.update(d => d.n.inc(1));
    const c1 = doc._flush()!;
    const c2 = doc._flush()!;
    expect(c2.id).toBe(c1.id);
    expect(c2.fields).toEqual(c1.fields);
  });

  it('folds the server-resolved fields, not the raw sending ops', () => {
    const doc = new MicroDoc<{ n: number }>({ n: { op: '+', val: 5, ts: 1 } }, {}, 3);
    doc.update(d => d.n.inc(1));
    doc._flush();
    // Server resolves the total as 6 and returns it absolutely
    doc._confirmSend({ rev: 4, fields: { n: { op: '+', val: 6, ts: 2 } } });
    expect((doc.state as any).n).toBe(6);
    expect(doc.rev).toBe(4);
    expect(doc.isSending).toBe(false);
  });

  it('a rejected LWW write reverts to the server value after confirm', () => {
    const doc = new MicroDoc<{ title: string }>({ title: { op: '=', val: 'Server', ts: 100 } }, {}, 1);
    doc.update(d => d.title.set('Stale'));
    (doc.pending as any).title.ts = 50; // simulate an old client clock
    doc._flush();
    doc._confirmSend({ rev: 2, fields: {} }); // server dropped the stale write
    expect((doc.state as any).title).toBe('Server');
  });

  it('flags a resync when the commit result reveals missed revs', () => {
    const doc = new MicroDoc<{ n: number }>({}, {}, 1);
    doc.update(d => d.n.inc(1));
    doc._flush();
    doc._confirmSend({ rev: 5, fields: { n: { op: '+', val: 1, ts: 1 } } });
    expect(doc.needsResync).toBe(true);
    expect(doc.rev).toBe(1); // not advanced past unseen revs
  });

  it('restores an in-flight send from persistence with its original id', () => {
    const doc = new MicroDoc<{ n: number }>({}, {}, 2, {
      id: 'restored-id',
      fields: { n: { op: '+', val: 1, ts: 1 } },
    });
    expect(doc.isSending).toBe(true);
    expect((doc.state as any).n).toBe(1); // unconfirmed layer is part of state
    const change = doc._flush()!;
    expect(change.id).toBe('restored-id');
    expect(change.rev).toBe(2);
  });
});

describe('MicroDoc.applyRemote', () => {
  it('ignores the echo of its own in-flight change', () => {
    const doc = new MicroDoc<{ content: Delta }>({}, {}, 0);
    doc.update(d => d.content.txt(new Delta().insert('abc')));
    const change = doc._flush()!;
    doc.applyRemote({ content: { op: '#', val: new Delta().insert('abc').ops, ts: 1 } }, 1, change.id);
    expect(doc.rev).toBe(0); // untouched; the confirm path owns this change
    doc._confirmSend({ rev: 1, fields: { content: { op: '#', val: new Delta().insert('abc').ops, ts: 1 } } });
    expect(JSON.stringify((doc.state as any).content)).toBe(JSON.stringify(new Delta().insert('abc').ops));
  });

  it('ignores stale broadcasts instead of regressing rev', () => {
    const doc = new MicroDoc<{ a: number }>({}, {}, 6);
    doc.applyRemote({ a: { op: '=', val: 1, ts: 1 } }, 5, 'other');
    expect(doc.rev).toBe(6);
    expect((doc.state as any).a).toBeUndefined();
  });

  it('flags a resync on a rev gap instead of applying out of order', () => {
    const doc = new MicroDoc<{ a: number }>({}, {}, 3);
    doc.applyRemote({ a: { op: '=', val: 1, ts: 1 } }, 5, 'other');
    expect(doc.needsResync).toBe(true);
    expect(doc.rev).toBe(3);
    expect((doc.state as any).a).toBeUndefined();
  });

  it('applies contiguous broadcasts and clears deleted subtrees', () => {
    const doc = new MicroDoc<any>({ 'user.name': { op: '=', val: 'x', ts: 1 } }, {}, 3);
    doc.applyRemote({ user: { op: '!', val: null, ts: 2 } }, 4, 'other');
    expect(doc.rev).toBe(4);
    expect(doc.state.user).toBeUndefined();
  });
});

describe('MicroDoc._applySync', () => {
  it('replaces confirmed, rebases pending text, and clears the resync flag', () => {
    const doc = new MicroDoc<{ t: Delta }>({ t: { op: '#', val: new Delta().insert('base').ops, ts: 1 } }, {}, 2);
    doc.update(d => d.t.txt(new Delta().retain(4).insert('!')));
    doc.applyRemote({}, 9, 'other'); // force a gap
    expect(doc.needsResync).toBe(true);
    doc._applySync({
      rev: 9,
      fields: { t: { op: '#', val: new Delta().insert('Zbase').ops, ts: 5 } },
      textLog: { t: [{ key: 't', delta: new Delta().insert('Z').ops, rev: 9 }] },
    });
    expect(doc.needsResync).toBe(false);
    expect(doc.rev).toBe(9);
    // pending "!" was rebased past the remote "Z" insert
    expect(JSON.stringify((doc.state as any).t)).toBe(JSON.stringify(new Delta().insert('Zbase!').ops));
  });
});

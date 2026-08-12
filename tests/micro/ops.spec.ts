import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import {
  buildState,
  clearDescendants,
  consolidateOps,
  mergeField,
  transformPendingTxt,
} from '../../src/micro/index.js';
import type { FieldMap } from '../../src/micro/index.js';

describe('mergeField', () => {
  it('max with no existing value keeps the incoming value', () => {
    expect(mergeField(undefined, { op: '^', val: -3, ts: 1 })).toEqual({ op: '^', val: -3, ts: 1 });
    expect(mergeField(undefined, { op: '^', val: 'abc', ts: 1 })).toEqual({ op: '^', val: 'abc', ts: 1 });
  });

  it('max compares strings against existing strings', () => {
    expect(mergeField({ op: '^', val: 'a', ts: 1 }, { op: '^', val: 'b', ts: 2 }).val).toBe('b');
    expect(mergeField({ op: '^', val: 'b', ts: 1 }, { op: '^', val: 'a', ts: 2 }).val).toBe('b');
  });

  it('inc and bit treat non-numeric existing values as 0', () => {
    expect(mergeField({ op: '=', val: 'oops', ts: 1 }, { op: '+', val: 2, ts: 2 }).val).toBe(2);
    expect(mergeField({ op: '=', val: { obj: 1 }, ts: 1 }, { op: '~', val: 1, ts: 2 }).val).toBe(1);
  });
});

describe('consolidateOps', () => {
  it('keeps absolute semantics when combining onto a pending set', () => {
    expect(consolidateOps({ n: { op: '=', val: 5, ts: 1 } }, { n: { op: '+', val: 1, ts: 2 } }).n).toEqual({
      op: '=',
      val: 6,
      ts: 2,
    });
    expect(consolidateOps({ n: { op: '=', val: 0, ts: 1 } }, { n: { op: '~', val: 4, ts: 2 } }).n).toEqual({
      op: '=',
      val: 4,
      ts: 2,
    });
    expect(consolidateOps({ n: { op: '=', val: 9, ts: 1 } }, { n: { op: '^', val: 3, ts: 2 } }).n).toEqual({
      op: '=',
      val: 9,
      ts: 2,
    });
  });

  it('applies onto a fresh base after a pending delete', () => {
    expect(consolidateOps({ n: { op: '!', val: null, ts: 1 } }, { n: { op: '+', val: 2, ts: 2 } }).n).toEqual({
      op: '=',
      val: 2,
      ts: 2,
    });
  });

  it('combines same-op pairs', () => {
    expect(consolidateOps({ n: { op: '+', val: 1, ts: 1 } }, { n: { op: '+', val: 2, ts: 2 } }).n.val).toBe(3);
    const txt = consolidateOps(
      { t: { op: '#', val: new Delta().insert('a').ops, ts: 1 } },
      { t: { op: '#', val: new Delta().retain(1).insert('b').ops, ts: 2 } }
    );
    expect(new Delta(txt.t.val).ops).toEqual(new Delta().insert('ab').ops);
  });

  it('a parent set supersedes pending descendants', () => {
    const out = consolidateOps(
      { 'user.name': { op: '=', val: 'x', ts: 1 } },
      { user: { op: '=', val: { name: 'y' }, ts: 2 } }
    );
    expect(out['user.name']).toBeUndefined();
    expect(out.user.val).toEqual({ name: 'y' });
  });
});

describe('clearDescendants', () => {
  it('respects LWW timestamps', () => {
    const fields: FieldMap = {
      'a.old': { op: '=', val: 1, ts: 1 },
      'a.new': { op: '=', val: 2, ts: 9 },
    };
    clearDescendants(fields, 'a', 5);
    expect(fields['a.old']).toBeUndefined();
    expect(fields['a.new']).toBeDefined();
  });
});

describe('buildState', () => {
  it('handles a scalar parent coexisting with a nested child', () => {
    const s: any = buildState({ a: { op: '=', val: 5, ts: 1 }, 'a.b': { op: '=', val: 6, ts: 1 } });
    expect(s.a.b).toBe(6);
  });

  it('never mutates stored field values', () => {
    const val = { name: 'x' };
    const s: any = buildState({
      user: { op: '=', val, ts: 1 },
      'user.age': { op: '=', val: 5, ts: 1 },
    });
    expect(val).toEqual({ name: 'x' });
    expect(s.user).toEqual({ name: 'x', age: 5 });
  });

  it('is insertion-order independent', () => {
    const a: any = buildState({
      'user.name': { op: '=', val: 'kid', ts: 1 },
      user: { op: '=', val: { role: 'admin' }, ts: 1 },
    });
    const b: any = buildState({
      user: { op: '=', val: { role: 'admin' }, ts: 1 },
      'user.name': { op: '=', val: 'kid', ts: 1 },
    });
    expect(a).toEqual(b);
    expect(a.user).toEqual({ role: 'admin', name: 'kid' });
  });

  it('skips null values', () => {
    const s: any = buildState({ gone: { op: '!', val: null, ts: 1 } });
    expect('gone' in s).toBe(false);
  });
});

describe('transformPendingTxt', () => {
  it('leaves non-text pending ops alone', () => {
    const out = transformPendingTxt(
      { title: { op: '=', val: 'hello', ts: 1 } },
      { title: [{ key: 'title', delta: new Delta().insert('x').ops, rev: 2 }] }
    );
    expect(out.title).toEqual({ op: '=', val: 'hello', ts: 1 });
  });

  it('transforms pending text against server entries, skipping excludeRev', () => {
    const pending: FieldMap = { t: { op: '#', val: new Delta().insert('a').ops, ts: 1 } };
    const log = {
      t: [
        { key: 't', delta: new Delta().insert('Z').ops, rev: 2 },
        { key: 't', delta: new Delta().insert('OWN').ops, rev: 3 },
      ],
    };
    const out = transformPendingTxt(pending, log, 3);
    // transformed against rev 2 only; the client's own committed entry (rev 3) skipped
    expect(new Delta(out.t.val).ops).toEqual(new Delta().retain(1).insert('a').ops);
  });
});

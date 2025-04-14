import { describe, expect, it } from 'vitest';
import { composePatch } from '../src/json-patch/composePatch.js';

describe('composePatch', () => {
  it('replace compose', () => {
    expect(
      composePatch([
        { op: 'replace', path: '/x', value: 4 },
        { op: 'replace', path: '/x', value: 2 },
        { op: 'replace', path: '/x', value: 8 },
      ])
    ).toEqual([{ op: 'replace', path: '/x', value: 8 }]);
  });

  it('increment compose', () => {
    expect(
      composePatch([
        { op: '@inc', path: '/x', value: 4 },
        { op: '@inc', path: '/x', value: 2 },
        { op: '@inc', path: '/x', value: -10 },
        { op: '@inc', path: '/x', value: 20 },
      ])
    ).toEqual([{ op: '@inc', path: '/x', value: 16 }]);
  });

  it('text compose', () => {
    expect(
      composePatch([
        { op: '@txt', path: '/x', value: { ops: [{ insert: 'How about th' }] } },
        { op: '@txt', path: '/x', value: { ops: [{ retain: 12 }, { insert: 'at!' }] } },
        {
          op: '@txt',
          path: '/x',
          value: { ops: [{ delete: 3 }, { insert: 'Who' }, { retain: 1 }, { delete: 5 }, { insert: 'is' }] },
        },
      ])
    ).toEqual([{ op: '@txt', path: '/x', value: { ops: [{ insert: 'Who is that!' }] } }]);
  });

  it('composes contiguous op', () => {
    expect(
      composePatch([
        { op: '@inc', path: '/x/3', value: 4 },
        { op: 'add', path: '/x/1', value: 2 },
        { op: '@inc', path: '/x/3', value: 1 },
        { op: '@inc', path: '/x/3', value: 1 },
      ])
    ).toEqual([
      { op: '@inc', path: '/x/3', value: 4 },
      { op: 'add', path: '/x/1', value: 2 },
      { op: '@inc', path: '/x/3', value: 2 },
    ]);
  });

  it('safely composes non-contiguous if no non-composables are in between', () => {
    expect(
      composePatch([
        { op: '@inc', path: '/y', value: 4 },
        { op: '@inc', path: '/y', value: 4 },
        { op: 'replace', path: '/x', value: 4 },
        { op: 'replace', path: '/x', value: 7 },
        { op: 'replace', path: '/y', value: 2 },
        { op: 'replace', path: '/x', value: 8 },
        { op: '@inc', path: '/y', value: 4 },
      ])
    ).toEqual([
      { op: '@inc', path: '/y', value: 8 },
      { op: 'replace', path: '/x', value: 8 },
      { op: 'replace', path: '/y', value: 2 },
      { op: '@inc', path: '/y', value: 4 },
    ]);

    expect(
      composePatch([
        { op: '@inc', path: '/y', value: 4 },
        { op: '@inc', path: '/y', value: 4 },
        { op: 'replace', path: '/x', value: 4 },
        { op: 'replace', path: '/x', value: 7 },
        { op: 'add', path: '/y', value: 2 },
        { op: 'replace', path: '/x', value: 8 },
        { op: '@inc', path: '/y', value: 4 },
      ])
    ).toEqual([
      { op: '@inc', path: '/y', value: 8 },
      { op: 'replace', path: '/x', value: 7 },
      { op: 'add', path: '/y', value: 2 },
      { op: 'replace', path: '/x', value: 8 },
      { op: '@inc', path: '/y', value: 4 },
    ]);
  });

  it('stops composing with higher paths', () => {
    expect(
      composePatch([
        { op: '@inc', path: '/x/y', value: 1 },
        { op: '@inc', path: '/x/y', value: 1 },
        { op: 'replace', path: '/x', value: { y: 0 } },
        { op: '@inc', path: '/x/y', value: 1 },
        { op: '@inc', path: '/x/y', value: 1 },
      ])
    ).toEqual([
      { op: '@inc', path: '/x/y', value: 2 },
      { op: 'replace', path: '/x', value: { y: 0 } },
      { op: '@inc', path: '/x/y', value: 2 },
    ]);
  });
});

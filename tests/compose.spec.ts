import { describe, expect, it } from 'vitest';
import { composePatch } from '../src/ot/composePatch.js';

describe('composePatch', () => {
  it('replace compose', () => {
    expect(
      composePatch([
        ['=/x', 4],
        ['=/x', 2],
        ['=/x', 8],
      ])
    ).toEqual([['=/x', 8]]);
  });

  it('increment compose', () => {
    expect(
      composePatch([
        ['^/x', 4],
        ['^/x', 2],
        ['^/x', -10],
        ['^/x', 20],
      ])
    ).toEqual([['^/x', 16]]);
  });

  it('text compose', () => {
    expect(
      composePatch([
        ['T/x', { ops: [{ insert: 'How about th' }] }],
        ['T/x', { ops: [{ retain: 12 }, { insert: 'at!' }] }],
        ['T/x', { ops: [{ delete: 3 }, { insert: 'Who' }, { retain: 1 }, { delete: 5 }, { insert: 'is' }] }],
      ])
    ).toEqual([['T/x', { ops: [{ insert: 'Who is that!' }] }]]);
  });

  it('composes contiguous op', () => {
    expect(
      composePatch([
        ['^/x/3', 4],
        ['+/x/1', 2],
        ['^/x/3', 1],
        ['^/x/3', 1],
      ])
    ).toEqual([
      ['^/x/3', 4],
      ['+/x/1', 2],
      ['^/x/3', 2],
    ]);
  });

  it('safely composes non-contiguous if no non-composables are in between', () => {
    expect(
      composePatch([
        ['^/y', 4],
        ['^/y', 4],
        ['=/x', 4],
        ['=/x', 7],
        ['=/y', 2],
        ['=/x', 8],
        ['^/y', 4],
      ])
    ).toEqual([
      ['^/y', 8],
      ['=/x', 8],
      ['=/y', 2],
      ['^/y', 4],
    ]);

    expect(
      composePatch([
        ['^/y', 4],
        ['^/y', 4],
        ['=/x', 4],
        ['=/x', 7],
        ['+/y', 2],
        ['=/x', 8],
        ['^/y', 4],
      ])
    ).toEqual([
      ['^/y', 8],
      ['=/x', 7],
      ['+/y', 2],
      ['=/x', 8],
      ['^/y', 4],
    ]);
  });

  it('stops composing with higher paths', () => {
    expect(
      composePatch([
        ['^/x/y', 1],
        ['^/x/y', 1],
        ['=/x', { y: 0 }],
        ['^/x/y', 1],
        ['^/x/y', 1],
      ])
    ).toEqual([
      ['^/x/y', 2],
      ['=/x', { y: 0 }],
      ['^/x/y', 2],
    ]);
  });
});

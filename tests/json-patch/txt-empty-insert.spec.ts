import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';

/**
 * DAB-1886: a zero-length op in a `@txt` document or change.
 *
 * dw3's split-scene emptied an op in place, so a stored scene held `{ insert: '' }`. In `@dabble/delta`
 * 1.2.5, a later delete or retain that crossed it lost the rest of its length: a 67-char delete became
 * 43, and formatting landed on a letter. The change log stayed right while every materialized copy
 * drifted.
 */
describe('@txt with a zero-length op', () => {
  const SOURCE = Array.from({ length: 313 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  const applyTxt = (text: unknown, ops: any[]) =>
    new Delta(applyPatch({ text }, [{ op: '@txt', path: '/text', value: ops }], { strict: true }).text).ops;

  it('applies the full length of a delete that crosses an empty insert', () => {
    const stored = [
      { insert: SOURCE.slice(0, 113) },
      { insert: '', attributes: { a: 1 } },
      { insert: SOURCE.slice(113) + '\n' },
    ];
    const change = [
      { retain: 71 },
      { insert: ' ' },
      { delete: 67 },
      { retain: 119 },
      { retain: 1, attributes: { b: true } },
    ];

    expect(applyTxt(stored, change)).toEqual(
      new Delta()
        .insert(SOURCE.slice(0, 71) + ' ' + SOURCE.slice(138, 257))
        .insert(SOURCE[257], { b: true })
        .insert(SOURCE.slice(258) + '\n').ops
    );
  });

  it('keeps a document whose first op is an empty insert', () => {
    expect(applyTxt([{ insert: '' }, { insert: 'Hello world\n' }], [{ retain: 5 }, { insert: ',' }])).toEqual([
      { insert: 'Hello, world\n' },
    ]);
  });

  it('applies a change that holds zero-length ops as if they were absent', () => {
    const change = [{ retain: 5 }, { delete: 0 }, { retain: 0 }, { insert: '' }, { retain: 1 }, { delete: 5 }];

    expect(applyTxt([{ insert: 'Hello world\n' }], change)).toEqual([{ insert: 'Hello \n' }]);
  });
});

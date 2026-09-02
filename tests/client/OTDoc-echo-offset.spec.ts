import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import type { Change, PatchesSnapshot } from '../../src/types';

const { OTDoc } = await import('../../src/client/OTDoc');

interface TextDoc {
  text?: any;
}

const makeChange = (id: string, baseRev: number, rev: number, ops: any[], committed: boolean): Change => ({
  id,
  baseRev,
  rev,
  ops,
  createdAt: 1,
  committedAt: committed ? 2 : 0,
});

const snapshot = (state: TextDoc, rev: number): PatchesSnapshot<TextDoc> => ({ state, rev, changes: [] });

const txt = (value: any[]) => [{ op: '@txt', path: '/text', value }];
const textOf = (state: any) => {
  const body = state?.text?.ops ?? state?.text ?? [];
  return body
    .map((op: any) => op.insert)
    .filter((i: any) => typeof i === 'string')
    .join('');
};

/**
 * DAB-1064 producer hunt. The corrupting change carried a leading retain exactly
 * `len(previous insert)` too far, minted while the author's own previous change was in
 * flight. These drive OTDoc through that window and check what the author's editor would
 * have seen — because the retain is computed from the view, a view that double-applies the
 * author's own change produces a "correct" op at a wrong offset.
 */
describe('OTDoc — own change echoing back must not shift the view or queued ops', () => {
  const BASE = 'x'.repeat(20);
  const first = txt([{ retain: 20 }, { insert: 'ABCDE' }]);

  const seed = () => new OTDoc<TextDoc>('d', snapshot({ text: new Delta().insert(BASE).ops }, 1));

  it('view holds the change exactly once after its own echo (pure echo)', () => {
    const doc = seed();
    doc._applyOptimistic(first as any);
    expect(textOf(doc.state)).toBe(`${BASE}ABCDE
`);

    doc.applyChanges([makeChange('c1', 1, 2, first, false)]); // local mint
    doc.applyChanges([makeChange('c1', 1, 2, first, true)]); // server echo

    expect(textOf(doc.state)).toBe(`${BASE}ABCDE
`);
  });

  it('view holds it once when the echo arrives WITH a foreign change (mixed batch)', () => {
    const doc = seed();
    doc._applyOptimistic(first as any);
    doc.applyChanges([makeChange('c1', 1, 2, first, false)]);

    // Foreign edit at the very start of the doc, committed alongside our echo.
    const foreign = txt([{ insert: 'Z' }]);
    doc.applyChanges([makeChange('c1', 1, 2, first, true), makeChange('other', 2, 3, foreign, true)]);

    expect(textOf(doc.state)).toBe(`Z${BASE}ABCDE
`);
  });

  it('keystrokes queued during the in-flight window are not shifted by our own echo', () => {
    const doc = seed();
    doc._applyOptimistic(first as any);
    doc.applyChanges([makeChange('c1', 1, 2, first, false)]); // minted, now in flight

    // Author keeps typing at the correct offset (25) while c1 is un-acked.
    const second = txt([{ retain: 25 }, { insert: 'FG' }]);
    doc._applyOptimistic(second as any);
    expect(textOf(doc.state)).toBe(`${BASE}ABCDEFG
`);

    doc.applyChanges([makeChange('c1', 1, 2, first, true)]); // echo lands

    expect(textOf(doc.state)).toBe(`${BASE}ABCDEFG
`);
    // The queued op must still target 25 — a shift to 30 is the DAB-1064 signature.
    expect((second[0].value as any[])[0].retain).toBe(25);
  });

  it('queued keystrokes survive an echo batched with a foreign change', () => {
    const doc = seed();
    doc._applyOptimistic(first as any);
    doc.applyChanges([makeChange('c1', 1, 2, first, false)]);

    const second = txt([{ retain: 25 }, { insert: 'FG' }]);
    doc._applyOptimistic(second as any);

    const foreign = txt([{ insert: 'Z' }]);
    doc.applyChanges([makeChange('c1', 1, 2, first, true), makeChange('other', 2, 3, foreign, true)]);

    expect(textOf(doc.state)).toBe(`Z${BASE}ABCDEFG
`);
    // Foreign insert at 0 legitimately shifts us by 1 — to 26, never 31.
    expect((second[0].value as any[])[0].retain).toBe(26);
  });
});

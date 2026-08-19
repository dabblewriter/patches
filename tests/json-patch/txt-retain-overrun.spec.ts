import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';

/**
 * DAB-1064 — a `@txt` change whose leading retain runs past the end of the document.
 *
 * A client that composes a change while its own previous change is still in flight can
 * count that insert's length twice, so the next change retains past the end of the doc.
 * `Delta.compose` leaves the overrun stranded in the result as a bare `{ retain: n }`,
 * which is structurally invalid in a document (documents are insert-only).
 *
 * The overrun must not become content. Materialising it as spaces inflates the document
 * past its own text, so every later offset lands in the wrong place — which corrupts the
 * manuscript rather than merely misplacing one edit.
 *
 * The sequence below is taken verbatim from a reporter's database export (co-authoring
 * session, 2026-08-18): doc length 1269, two successive changes both retaining 1280.
 */
describe('@txt with a retain past the end of the document', () => {
  // Reproduces the exact offsets from the export: 1258 chars of prior text, then the
  // author types "<I'm never " (11 chars), leaving the document 1269 long.
  const PRIOR = 'x'.repeat(1258);
  const OPENING = "<I'm never ";
  const docText = PRIOR + OPENING;

  const textOf = (value: unknown) =>
    new Delta(value as any).ops
      .filter(op => typeof op.insert === 'string')
      .map(op => op.insert as string)
      .join('');

  const applyTxt = (state: any, ops: any[]) => applyPatch(state, [{ op: '@txt', path: '/text', value: ops }]);

  it('does not invent characters that nobody typed', () => {
    const state = { text: new Delta().insert(docText).ops };

    // retain 1280 is 11 past the end of the 1269-char document — exactly the length of
    // the author's own preceding insert, counted twice.
    const result = applyTxt(state, [{ retain: 1280 }, { insert: 'impulsive.>' }]);

    expect(textOf(result.text)).toBe(`${docText}impulsive.>\n`);
  });

  it('leaves no non-insert op stranded in the document', () => {
    const state = { text: new Delta().insert(docText).ops };

    const result = applyTxt(state, [{ retain: 1280 }, { insert: 'impulsive.>' }]);

    const ops = new Delta(result.text as any).ops;
    expect(ops.every(op => op.insert !== undefined)).toBe(true);
  });

  it('keeps the document length honest so later edits land correctly', () => {
    const state = { text: new Delta().insert(docText).ops };

    const result = applyTxt(state, [{ retain: 1280 }, { insert: 'impulsive.>' }]);
    const doc = new Delta(result.text as any);

    // A document that reports a length longer than its own text poisons every
    // subsequent offset; that is the mechanism behind the reported transposition.
    expect(doc.length()).toBe(textOf(result.text).length);
  });

  it('does not transpose the next edit (the reported corruption)', () => {
    let state: any = { text: new Delta().insert(docText).ops };

    // Both changes retain 1280 — the second is correct in the author's own frame.
    state = applyTxt(state, [{ retain: 1280 }, { insert: 'impulsive.>' }]);
    state = applyTxt(state, [{ retain: 1280 }, { insert: ' Except for with Aster.' }]);

    const text = textOf(state.text);

    // Reported symptom: "impulsive.>" is shunted to the end, behind text typed after it.
    expect(text).not.toMatch(/Except for with Aster\.impulsive\.>/);
    expect(text).toContain('impulsive.> Except for with Aster.');
  });

  it('still preserves a retain that is within the document', () => {
    const state = { text: new Delta().insert(docText).ops };

    // Guard against over-correcting: an in-bounds retain is ordinary and must still work.
    const result = applyTxt(state, [{ retain: 1269 }, { insert: 'impulsive.>' }]);

    expect(textOf(result.text)).toBe(`${docText}impulsive.>\n`);
  });
});

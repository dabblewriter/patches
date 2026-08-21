import { Delta } from '@dabble/delta';
import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';

/**
 * DAB-1064 — a `@txt` change whose leading retain runs past the end of the document.
 *
 * A client that composes a change while its own previous change is still in flight can count
 * that insert's length twice, so the next change retains past the end of the doc. `Delta.compose`
 * leaves the overrun stranded in the result as a bare `{ retain: n }`, which is structurally
 * invalid in a document (documents are insert-only).
 *
 * The overrun must not become content. Materialising it as spaces inflates the document past its
 * own text, so every later offset lands in the wrong place — corrupting the manuscript rather
 * than merely misplacing one edit.
 *
 * The offsets model a reported co-authoring session: the overrun is exactly the length of the
 * author's own preceding insert. The prose is invented for the test.
 */
describe('@txt with a retain past the end of the document', () => {
  const PRIOR = 'x'.repeat(40);
  const OPENING = 'she set the cup down '; // the author's own preceding insert
  // A stored document always ends in a newline — fixBadDeltaDoc guarantees it — so the fixture
  // must too, or the overrun arithmetic is off by one against anything that can actually persist.
  const DOC = `${PRIOR}${OPENING}\n`;
  const DOC_LEN = DOC.length;
  const OVERRUN = OPENING.length; // the double-counted length
  const BAD_RETAIN = DOC_LEN + OVERRUN;

  const state = () => ({ text: new Delta().insert(DOC).ops });
  const applyTxt = (s: any, ops: any[]) =>
    // `strict` matters: without it a failed op is skipped with a console.error and the
    // assertions below would pass against untouched input.
    applyPatch(s, [{ op: '@txt', path: '/text', value: ops }], { strict: true });
  const opsOf = (value: unknown) => new Delta(value as any).ops;
  const textOf = (value: unknown) =>
    opsOf(value)
      .filter(op => typeof op.insert === 'string')
      .map(op => op.insert as string)
      .join('');

  it('does not invent characters that nobody typed', () => {
    const result = applyTxt(state(), [{ retain: BAD_RETAIN }, { insert: 'the note' }]);

    // The insert survives (guards against dropping too much) and nothing is padded in front of it.
    expect(textOf(result.text)).toBe(`${DOC}the note\n`);
  });

  it('leaves no non-insert op stranded in the document', () => {
    const result = applyTxt(state(), [{ retain: BAD_RETAIN }, { insert: 'the note' }]);

    expect(opsOf(result.text).every(op => op.insert !== undefined)).toBe(true);
  });

  it('keeps the document length honest so later edits land correctly', () => {
    const result = applyTxt(state(), [{ retain: BAD_RETAIN }, { insert: 'the note' }]);

    // A document reporting a length longer than its own content poisons every subsequent
    // offset; that is the mechanism behind the reported transposition.
    expect(new Delta(result.text as any).length()).toBe(`${DOC}the note\n`.length);
  });

  it('does not transpose a following edit (the reported corruption)', () => {
    // The insert must be shorter than the overrun, or the document grows past the bad retain and
    // the second change is silently in-bounds — exercising nothing.
    let s: any = state();
    s = applyTxt(s, [{ retain: BAD_RETAIN }, { insert: 'ab' }]);
    expect(new Delta(s.text as any).length()).toBeLessThan(BAD_RETAIN);

    s = applyTxt(s, [{ retain: BAD_RETAIN }, { insert: 'cd' }]);

    const text = textOf(s.text);
    expect(text).not.toContain('cdab');
    expect(text).toContain('ab');
    expect(text).toContain('cd');
    expect(text.indexOf('ab')).toBeLessThan(text.indexOf('cd'));
  });

  it('preserves an in-bounds retain and everything after it', () => {
    // The real over-correction guard: a mid-document retain must not take the tail with it.
    const result = applyTxt(state(), [{ retain: 10 }, { insert: 'INSERTED' }]);

    expect(textOf(result.text)).toBe(`${DOC.slice(0, 10)}INSERTED${DOC.slice(10)}`);
  });

  it('drops a stranded delete as well as a stranded retain', () => {
    const result = applyTxt(state(), [{ retain: BAD_RETAIN }, { delete: 5 }]);

    expect(textOf(result.text)).toBe(DOC);
    expect(opsOf(result.text).every(op => op.insert !== undefined)).toBe(true);
  });

  it('drops an attributed overrun rather than inventing formatted spaces', () => {
    // Formatting the in-bounds text is legitimate — the author did ask for it. Only the overrun
    // is stranded, and padding used to turn it into that many *styled* spaces.
    const result = applyTxt(state(), [{ retain: BAD_RETAIN, attributes: { bold: true } }, { insert: 'the note' }]);

    expect(textOf(result.text)).toBe(`${DOC}the note\n`);
    expect(opsOf(result.text).every(op => op.insert !== undefined)).toBe(true);
  });

  it('preserves an embed while dropping the overrun around it', () => {
    const s = { text: new Delta().insert('start ').insert({ image: 'a.png' }).insert(' end\n').ops };

    const result = applyTxt(s, [{ retain: 40 }, { insert: 'the note' }]);

    expect(opsOf(result.text).some(op => typeof op.insert === 'object')).toBe(true);
    expect(opsOf(result.text).every(op => op.insert !== undefined)).toBe(true);
  });

  it('concatenates two stranded inserts carried by one batched change', () => {
    // Client batching composes two overrunning bursts into a single change with two stranded
    // inserts. Pinning current behaviour: both land, in order, with the dead gap removed.
    const result = applyTxt(state(), [
      { retain: BAD_RETAIN },
      { insert: 'first' },
      { retain: 5 },
      { insert: 'second' },
    ]);

    expect(textOf(result.text)).toBe(`${DOC}firstsecond\n`);
  });

  it('lands the dropped edit after the terminal newline, not at the caret', () => {
    // The accepted trade, pinned so it is a decision rather than a surprise: the author's edit
    // becomes its own paragraph at the end of the document instead of corrupting the text.
    const result = applyTxt({ text: new Delta().insert('abc\n').ops }, [{ retain: 10 }, { insert: 'X' }]);

    expect(textOf(result.text)).toBe('abc\nX\n');
  });
});

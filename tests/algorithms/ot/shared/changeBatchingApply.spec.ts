import { Delta } from '@dabble/delta';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { breakChanges } from '../../../../src/algorithms/ot/shared/changeBatching';
import { compressedSizeUint8 } from '../../../../src/compression';
import type { Change } from '../../../../src/types';

/**
 * Split pieces are SEQUENTIAL changes: each composes onto the document produced
 * by the one before it, exactly as `json-patch/ops/text.ts` applies committed
 * changes on replay. These tests pin the property the shape-based tests can't:
 * applying the pieces one after another produces the same document as applying
 * the original op once. A piece whose ops lack the cumulative leading retain
 * composes at the head of the document and garbles it.
 */

const createChange = (ops: any[], rev = 1): Change => ({
  id: `change-${rev}`,
  rev,
  baseRev: 0,
  ops,
  createdAt: 0,
  committedAt: 0,
});

/** Deterministic PRNG so the high-entropy fixtures below are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text LZ cannot meaningfully compress: uniform draws from a wide alphabet. */
function highEntropyText(length: number, seed = 0xc0ffee, alphabetSize = 2000, base = 0x4e00): string {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < length; i++) out.push(String.fromCharCode(base + Math.floor(rnd() * alphabetSize)));
  return out.join('');
}

/** The same, in the astral plane, so every character is a surrogate pair. */
function highEntropyAstralText(codePoints: number, alphabetSize = 2000): string {
  const rnd = mulberry32(0xbeef);
  const out: string[] = [];
  for (let i = 0; i < codePoints; i++) out.push(String.fromCodePoint(0x1f000 + Math.floor(rnd() * alphabetSize)));
  return out.join('');
}

/** Compose a @txt op's delta value onto a document, the way `text.apply` does. */
const composeValue = (doc: Delta, value: any[]): Delta => doc.compose(new Delta(value));

/** Apply split pieces one after another — the document each later piece really meets. */
function applySequentially(doc: Delta, pieces: Change[]): Delta {
  return pieces.reduce((current, piece) => {
    expect(piece.ops).toHaveLength(1);
    return composeValue(current, piece.ops[0].value as any[]);
  }, doc);
}

function expectSplitEquivalent(
  baseText: string,
  value: any[],
  maxBytes: number,
  sizeCalculator?: (data: unknown) => number,
  minPieces = 2
): Change[] {
  const doc = new Delta().insert(baseText);
  const expected = composeValue(doc, value);
  const change = createChange([{ op: '@txt', path: '/body', value }]);

  const pieces = breakChanges([change], maxBytes, sizeCalculator);
  expect(pieces.length).toBeGreaterThanOrEqual(minPieces);

  const actual = applySequentially(doc, pieces);
  expect(actual.ops).toEqual(expected.ops);
  return pieces;
}

describe('split @txt pieces compose to the same document as the original op', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a giant insert split into chunks lands at its original position, not the head', () => {
    const base = 'the quick brown fox '.repeat(20); // 400 chars of context
    expectSplitEquivalent(base, [{ retain: 42 }, { insert: highEntropyText(60_000) }], 20_000, compressedSizeUint8);
  });

  it('a giant insert with no leading retain still chunks in order', () => {
    expectSplitEquivalent('', [{ insert: highEntropyText(60_000) }], 20_000, compressedSizeUint8);
  });

  it('a multi-op delta split across pieces keeps every op at its original position', () => {
    const ops: any[] = [];
    for (let i = 0; i < 30; i++) {
      ops.push({ retain: 50 }, { insert: highEntropyText(2_000, 0xfeed + i) });
    }
    const base = 'abcdefghij'.repeat(200); // 2,000 chars — retains stay in bounds
    expectSplitEquivalent(base, ops, 15_000, compressedSizeUint8, 3);
  });

  it('deletes and formatting retains survive the split in place', () => {
    const base = 'abcdefghij'.repeat(20); // 200 chars
    const value = [
      { retain: 10 },
      { delete: 5 },
      { insert: highEntropyText(40_000) },
      { retain: 20, attributes: { bold: true } },
    ];
    expectSplitEquivalent(base, value, 15_000, compressedSizeUint8);
  });

  it('an embed the splitter cannot break stays at its position among split pieces', () => {
    const base = 'abcdefghij'.repeat(10); // 100 chars
    const value = [
      { retain: 5 },
      { insert: { image: `data:image/png;base64,${'A'.repeat(30_000)}` } },
      { retain: 10 },
      { insert: highEntropyText(40_000) },
    ];
    // The embed is over budget with no seam: emitted anyway (ceiling unset) and reported.
    expectSplitEquivalent(base, value, 15_000, compressedSizeUint8, 3);
  });

  it('astral text splits at its original position without cutting a surrogate pair', () => {
    const base = 'abcdefghij'.repeat(10);
    const text = highEntropyAstralText(10_000);
    const pieces = expectSplitEquivalent(base, [{ retain: 10 }, { insert: text }], 5_000, compressedSizeUint8);

    const inserts = pieces
      .flatMap(piece => piece.ops[0].value as any[])
      .filter(op => typeof op.insert === 'string')
      .map(op => op.insert as string);
    expect(
      inserts.some(insert => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(insert))
    ).toBe(false);
  });

  it('a pathologically small budget still never cuts a surrogate pair', () => {
    // Default (uncompressed) calculator so sizes are deterministic. The budget is barely
    // above the change envelope, so the seed length bottoms out and single code points
    // go out as emitted-anyway pieces — but never half of one.
    const base = 'ab';
    const text = highEntropyAstralText(40);
    const doc = new Delta().insert(base);
    const value = [{ retain: 2 }, { insert: text }];
    const expected = composeValue(doc, value);
    const change = createChange([{ op: '@txt', path: '/body', value }]);

    const pieces = breakChanges([change], 160);
    expect(pieces.length).toBeGreaterThan(1);

    const inserts = pieces
      .flatMap(piece => piece.ops[0].value as any[])
      .filter(op => typeof op.insert === 'string')
      .map(op => op.insert as string);
    expect(
      inserts.some(insert => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(insert))
    ).toBe(false);
    expect(applySequentially(doc, pieces).ops).toEqual(expected.ops);
  });
});

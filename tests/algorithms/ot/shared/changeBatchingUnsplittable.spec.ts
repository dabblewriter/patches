import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  breakChanges,
  breakChangesIntoBatches,
  onOversizedOp,
  type OversizedOpReport,
} from '../../../../src/algorithms/ot/shared/changeBatching';
import { compressedSizeUint8 } from '../../../../src/compression';
import { isDefectiveChangeError, UnsplittableChangeError } from '../../../../src/net/error';
import type { Change } from '../../../../src/types';

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
function highEntropyText(length: number, alphabetSize = 2000, base = 0x4e00): string {
  const rnd = mulberry32(0xc0ffee);
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

/** The four ops the splitter has no seam for, one per escape hatch. */
const HATCHES = [
  {
    name: 'op type with no splitter',
    reason: 'op-type',
    op: 'move',
    path: '/source',
    ops: [{ op: 'move', path: '/source', from: '/destination', value: 'x'.repeat(4000) }],
  },
  {
    name: 'delta op that is not a string insert',
    reason: 'delta-op',
    op: '@txt',
    path: '/body',
    ops: [{ op: '@txt', path: '/body', value: [{ insert: { image: `data:image/png;base64,${'A'.repeat(4000)}` } }] }],
  },
  {
    name: 'replace whose value is not an object',
    reason: 'value-not-object',
    op: 'replace',
    path: '/content',
    ops: [{ op: 'replace', path: '/content', value: 'x'.repeat(4000) }],
  },
  {
    name: 'replace whose object value has no text deltas',
    reason: 'value-no-text',
    op: 'replace',
    path: '/data',
    ops: [{ op: 'replace', path: '/data', value: { blob: 'x'.repeat(4000) } }],
  },
];

describe('unsplittable ops', () => {
  let reports: OversizedOpReport[];
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reports = [];
    unsubscribe = onOversizedOp(report => reports.push(report));
  });

  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  describe.each(HATCHES)('$name', hatch => {
    const change = () => createChange(hatch.ops as unknown as any[]);
    const maxBytes = 100;

    it('emits the op anyway, with a report, below maxUnsplittableBytes', () => {
      const result = breakChanges([change()], maxBytes, undefined, { maxUnsplittableBytes: 1_000_000, docId: 'doc-1' });

      expect(result).toHaveLength(1);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        op: hatch.op,
        path: hatch.path,
        reason: hatch.reason,
        maxBytes,
        docId: 'doc-1',
        changeId: 'change-1',
        emitted: true,
      });
      expect(reports[0].bytes).toBeGreaterThan(maxBytes);
    });

    it('throws UnsplittableChangeError above maxUnsplittableBytes', () => {
      let thrown: unknown;
      try {
        breakChanges([change()], maxBytes, undefined, { maxUnsplittableBytes: 500, docId: 'doc-1' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(UnsplittableChangeError);
      const error = thrown as UnsplittableChangeError;
      expect(error.op).toBe(hatch.op);
      expect(error.path).toBe(hatch.path);
      expect(error.bytes).toBeGreaterThan(500);
      expect(error.maxBytes).toBe(500);
      expect(error.docId).toBe('doc-1');
      expect(error.changeId).toBe('change-1');
      expect(reports).toEqual([expect.objectContaining({ reason: hatch.reason, emitted: false })]);
    });

    it('emits the op anyway when maxUnsplittableBytes is unset', () => {
      const result = breakChanges([change()], maxBytes);

      expect(result).toHaveLength(1);
      expect(reports).toEqual([expect.objectContaining({ reason: hatch.reason, emitted: true })]);
    });
  });

  it('defaults to Infinity through breakChangesIntoBatches, so existing consumers are unaffected', () => {
    const change = createChange([{ op: 'replace', path: '/content', value: 'x'.repeat(200_000) }]);

    const batches = breakChangesIntoBatches([change], { maxStorageBytes: 100, sizeCalculator: compressedSizeUint8 });

    expect(batches.flat()).toHaveLength(1);
    expect(reports).toEqual([expect.objectContaining({ emitted: true })]);
  });

  it('honours maxUnsplittableBytes passed through breakChangesIntoBatches', () => {
    const change = createChange([{ op: 'replace', path: '/content', value: 'x'.repeat(200_000) }]);

    expect(() =>
      breakChangesIntoBatches([change], {
        maxStorageBytes: 100,
        maxUnsplittableBytes: 500,
        sizeCalculator: compressedSizeUint8,
        docId: 'doc-1',
      })
    ).toThrow(UnsplittableChangeError);
  });

  it('is classified as a defective change', () => {
    const error = new UnsplittableChangeError('replace', '/content', 2_000_000, 1_000_000);

    expect(isDefectiveChangeError(error)).toBe(true);
    expect(error.name).toBe('UnsplittableChangeError');
    // Name-matched, so a copy that crossed a worker boundary classifies the same.
    expect(isDefectiveChangeError({ name: 'UnsplittableChangeError' })).toBe(true);
  });

  it('leaves ops that split normally alone', () => {
    const change = createChange([
      { op: 'add', path: '/a', value: 'a'.repeat(4000) },
      { op: 'add', path: '/b', value: 'b'.repeat(4000) },
    ]);

    const result = breakChanges([change], 4200, undefined, { maxUnsplittableBytes: 4300 });

    expect(result).toHaveLength(2);
    expect(reports).toEqual([]);
  });
});

describe('large text inserts', () => {
  const maxBytes = 50_000;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps every piece of a high-entropy insert under the storage budget', () => {
    const change = createChange([{ op: '@txt', path: '/body', value: [{ insert: highEntropyText(100_000) }] }]);

    const pieces = breakChanges([change], maxBytes, compressedSizeUint8);

    expect(pieces.length).toBeGreaterThan(1);
    const sizes = pieces.map(piece => compressedSizeUint8(piece));
    expect(sizes.filter(size => size > maxBytes)).toEqual([]);
  });

  it('keeps every piece of a manuscript-sized insert under a large budget', () => {
    const change = createChange([{ op: '@txt', path: '/body', value: [{ insert: highEntropyText(1_000_000) }] }]);

    const pieces = breakChanges([change], 300_000, compressedSizeUint8);

    const sizes = pieces.map(piece => compressedSizeUint8(piece));
    expect(sizes.filter(size => size > 300_000)).toEqual([]);
  }, 30_000);

  it('preserves the full text and the leading retain across the split', () => {
    const text = highEntropyText(100_000);
    const change = createChange([{ op: '@txt', path: '/body', value: [{ retain: 42 }, { insert: text }] }]);

    const pieces = breakChanges([change], maxBytes, compressedSizeUint8);

    expect(pieces[0].ops[0].value[0]).toEqual({ retain: 42 });
    const rejoined = pieces
      .flatMap(piece => piece.ops[0].value as any[])
      .filter(op => typeof op.insert === 'string')
      .map(op => op.insert)
      .join('');
    expect(rejoined).toBe(text);
  });

  it('carries attributes onto every piece', () => {
    const change = createChange([
      { op: '@txt', path: '/body', value: [{ insert: highEntropyText(100_000), attributes: { bold: true } }] },
    ]);

    const pieces = breakChanges([change], maxBytes, compressedSizeUint8);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every(piece => (piece.ops[0].value as any[]).every(op => op.attributes?.bold))).toBe(true);
  });

  it('never cuts a surrogate pair', () => {
    const text = highEntropyAstralText(20_000);
    const change = createChange([{ op: '@txt', path: '/body', value: [{ insert: text }] }]);

    const pieces = breakChanges([change], 5_000, compressedSizeUint8);

    expect(pieces.length).toBeGreaterThan(1);
    const inserts = pieces
      .flatMap(piece => piece.ops[0].value as any[])
      .filter(op => typeof op.insert === 'string')
      .map(op => op.insert as string);
    // A cut through a pair would leave a lone surrogate at a piece boundary.
    expect(
      inserts.some(insert => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(insert))
    ).toBe(false);
    expect(inserts.join('')).toBe(text);
  });

  it('refuses a single character that cannot fit under maxUnsplittableBytes', () => {
    const reports: OversizedOpReport[] = [];
    const unsubscribe = onOversizedOp(report => reports.push(report));
    const change = createChange([{ op: '@txt', path: '/body', value: [{ insert: highEntropyText(1_000) }] }]);

    try {
      // A budget no single-character piece can meet, so the bisection runs out of text to cut.
      expect(() => breakChanges([change], 1, compressedSizeUint8, { maxUnsplittableBytes: 10 })).toThrow(
        UnsplittableChangeError
      );
      expect(reports.at(-1)).toMatchObject({ reason: 'insert-chunk', emitted: false });
    } finally {
      unsubscribe();
    }
  });
});

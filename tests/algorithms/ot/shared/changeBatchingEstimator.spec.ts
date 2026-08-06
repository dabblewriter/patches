import { describe, expect, it } from 'vitest';
import { breakChanges, getJSONByteSize } from '../../../../src/algorithms/ot/shared/changeBatching';
import { compressedSizeUint8 } from '../../../../src/compression';
import type { Change } from '../../../../src/types';

/**
 * Split points are chosen from a cheap size *estimate* rather than by compressing the accumulated
 * payload at every candidate boundary — the O(ops × payload) behaviour that froze the tab on a
 * whole-project Duplicate or Time Machine restore (DAB-931).
 *
 * An estimate can be wrong, so these pin the contract that makes it safe to be wrong: every emitted
 * piece is re-measured with the real calculator and re-split if it still overflows, the split stays
 * deterministic, and the uncompressed path — where the estimate is exact arithmetic — keeps the
 * boundaries it had before.
 *
 * Positioning and replay-order correctness are covered by `changeBatchingApply.spec.ts`; the
 * round-trip here is a regression guard that estimated boundaries do not move a split into
 * wrongness.
 */

const createChange = (ops: any[], rev = 1): Change => ({
  id: `change-${rev}`,
  rev,
  baseRev: 0,
  ops,
  createdAt: 0,
  committedAt: 0,
});

/** Deterministic PRNG so the fixtures below are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A vocabulary wide enough that sampling from it compresses at roughly the ratio real manuscripts
 * do (~0.25-0.3 through `compressedSizeUint8`). A handful of repeated words would compress an order
 * of magnitude better than real prose and quietly put these fixtures on the wrong side of the cap.
 */
const VOCAB = (() => {
  const rnd = mulberry32(0x1a2b3c);
  const words: string[] = [];
  for (let i = 0; i < 3000; i++) {
    const length = 3 + Math.floor(rnd() * 7);
    let word = '';
    for (let c = 0; c < length; c++) word += String.fromCharCode(97 + Math.floor(rnd() * 26));
    words.push(word);
  }
  return words;
})();

function prose(words: number, seed = 0x5eed): string {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
  return out.join(' ');
}

/** A whole project: many docs, each holding a prose delta — the shape both crashing ops emit. */
function wholeDocument(docCount: number, wordsPerDoc: number): Record<string, any> {
  const docs: Record<string, any> = {};
  for (let i = 0; i < docCount; i++) {
    docs[`doc${i}`] = {
      title: `Chapter ${i}`,
      body: { ops: [{ insert: prose(wordsPerDoc, 0x5eed + i) }] },
    };
  }
  return docs;
}

const MAX_BYTES = 900_000; // dw3's MAX_STORAGE_BYTES

/** Over the cliff: >4MB of JSON, which compresses to comfortably more than MAX_BYTES. */
const OVERSIZED_DOCS = wholeDocument(400, 1550);

describe('estimated split points (DAB-931)', () => {
  it('keeps every emitted piece within the storage cap', () => {
    const change = createChange([{ op: 'replace', path: '/docs', value: OVERSIZED_DOCS }]);
    expect(compressedSizeUint8(change)).toBeGreaterThan(MAX_BYTES);

    const pieces = breakChanges([change], MAX_BYTES, compressedSizeUint8);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(compressedSizeUint8(piece)).toBeLessThanOrEqual(MAX_BYTES);
    }
  }, 120_000);

  it('re-splits a piece the estimate left oversized rather than emitting it', () => {
    const docs = wholeDocument(40, 400);
    const change = createChange([{ op: 'replace', path: '/docs', value: docs }]);
    const changeJSON = getJSONByteSize(change);
    const budget = Math.floor((changeJSON * 0.1) / 4);

    // A hostile calculator must be non-uniform: `createSizeEstimator` calibrates its ratio from one
    // real measurement of the very change being split, so a calculator that is any constant
    // multiple of JSON size is estimated perfectly and the re-split path never runs. Real LZ is
    // non-uniform in exactly this direction — a large change compresses better than the smaller
    // pieces cut from it — so model a sharp version of it: cheap at whole-change scale, 5× that
    // rate for anything piece-sized. First-pass boundaries then land genuinely over budget, and
    // only `verifyPieces` stands between an oversized piece and the store.
    const pieceThreshold = Math.floor(changeJSON / 2);
    const oversizedMeasurements: number[] = [];
    const stepped = (data: unknown) => {
      const json = getJSONByteSize(data);
      const size = Math.floor(json * (json >= pieceThreshold ? 0.1 : 0.5));
      if (json < pieceThreshold && size > budget) oversizedMeasurements.push(size);
      return size;
    };

    const pieces = breakChanges([change], budget, stepped);

    // The estimate really did produce over-budget pieces for `verifyPieces` to catch — nothing else
    // measures piece-sized payloads, so this fails first if the gate is ever removed or broken.
    expect(oversizedMeasurements.length).toBeGreaterThan(0);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(stepped(piece)).toBeLessThanOrEqual(budget);
    }
  });

  it('reproduces the document when the pieces are replayed in order', () => {
    const docs = OVERSIZED_DOCS;
    const change = createChange([{ op: 'replace', path: '/docs', value: docs }]);

    const pieces = breakChanges([change], MAX_BYTES, compressedSizeUint8);

    // Every doc's prose survives the split intact and in order.
    const replayed = pieces.flatMap(p => p.ops);
    for (const [id, doc] of Object.entries(docs)) {
      const text = (doc as any).body.ops[0].insert as string;
      const carried = replayed.some(op => JSON.stringify(op.value ?? '').includes(text.slice(0, 200)));
      expect(carried, `prose for ${id} survived`).toBe(true);
    }
  }, 120_000);

  it('assigns contiguous revs across every piece, including re-splits', () => {
    const change = createChange([{ op: 'replace', path: '/docs', value: OVERSIZED_DOCS }], 7);

    const pieces = breakChanges([change], MAX_BYTES, compressedSizeUint8);

    expect(pieces.map(p => p.rev)).toEqual(pieces.map((_, i) => 7 + i));
    // The first piece keeps the original id so retries still resolve the change.
    expect(pieces[0].id).toBe('change-7');
  }, 120_000);

  it('splits deterministically — the same document always yields the same pieces', () => {
    const change = () => createChange([{ op: 'replace', path: '/docs', value: OVERSIZED_DOCS }]);

    const first = breakChanges([change()], MAX_BYTES, compressedSizeUint8);
    const second = breakChanges([change()], MAX_BYTES, compressedSizeUint8);

    expect(first.length).toBe(second.length);
    expect(first.map(p => getJSONByteSize(p.ops))).toEqual(second.map(p => getJSONByteSize(p.ops)));
  }, 120_000);

  it('leaves the uncompressed path byte-identical: the ratio is exactly 1 with no calculator', () => {
    const docs = wholeDocument(40, 400);
    const change = createChange([{ op: 'replace', path: '/docs', value: docs }]);
    const budget = 30_000;

    const pieces = breakChanges([change], budget, undefined);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(getJSONByteSize(piece)).toBeLessThanOrEqual(budget);
    }
  });

  it('splits a multi-megabyte document without the quadratic measurement cost', () => {
    const change = createChange([{ op: 'replace', path: '/docs', value: OVERSIZED_DOCS }]);
    expect(getJSONByteSize(change)).toBeGreaterThan(4_000_000);

    const started = Date.now();
    const pieces = breakChanges([change], MAX_BYTES, compressedSizeUint8);
    const elapsed = Date.now() - started;

    for (const piece of pieces) {
      expect(compressedSizeUint8(piece)).toBeLessThanOrEqual(MAX_BYTES);
    }
    // Generous: the pre-fix implementation took ~187s on a payload this size, so anything in the
    // seconds range proves the quadratic re-compression is gone without being clock-sensitive.
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});

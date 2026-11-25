import { Delta } from '@dabble/delta';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  breakChanges,
  breakChangesIntoBatches,
  getJSONByteSize,
  onOversizedOp,
  type OversizedOpReport,
} from '../../../../src/algorithms/ot/shared/changeBatching';
import { applyPatch } from '../../../../src/json-patch/applyPatch';
import type { Change } from '../../../../src/types';

/**
 * A whole-document `add ""` (duplicating a project, seeding a doc) whose value is mostly
 * structure rather than text used to have no seam: once its text was pulled out as `@txt` ops,
 * the remaining skeleton went out as one op however large it was. Its keys are seams — each
 * nested object can be added at its own path after the parent lands.
 */

const createChange = (ops: any[], rev = 1): Change => ({
  id: `change-${rev}`,
  rev,
  baseRev: 0,
  ops,
  createdAt: 0,
  committedAt: 0,
});

/** A project-shaped document: many docs, each a small structure, and no text at all. */
function structureOnlyProject(docCount: number) {
  const docs: Record<string, any> = {};
  const children: string[] = [];
  for (let i = 0; i < docCount; i++) {
    const id = `doc${i}`;
    children.push(id);
    docs[id] = { id, type: 'scene', title: `Scene number ${i}`, meta: { status: 'draft', tags: ['a', 'b'] } };
  }
  return { id: 'p1', type: 'novel', children, docs: { ...docs, 'a/b~c': { id: 'a/b~c', title: 'escaped key' } } };
}

/** Apply pieces in order, the way the server commits them. */
function applyPieces(pieces: Change[]): any {
  return pieces.reduce((state, piece) => applyPatch(state, piece.ops, { strict: true }), undefined as any);
}

describe('splitting a large object value with no text', () => {
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

  it('splits a root add by its keys so every piece fits, and replays to the same document', () => {
    const project = structureOnlyProject(400);
    const maxBytes = 5_000;
    expect(getJSONByteSize(project)).toBeGreaterThan(maxBytes * 4);

    const pieces = breakChanges([createChange([{ op: 'add', path: '', value: project }])], maxBytes, undefined, {
      maxUnsplittableBytes: maxBytes,
    });

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(getJSONByteSize(piece)).toBeLessThanOrEqual(maxBytes);
    expect(reports).toEqual([]);
    expect(applyPieces(pieces)).toEqual(project);
    expect(pieces[0].id).toBe('change-1');
    expect(pieces.map(p => p.rev)).toEqual(pieces.map((_, i) => 1 + i));
  });

  it('splits the skeleton left after text is pulled out, keeping each @txt after the object it lands in', () => {
    const project: any = structureOnlyProject(400);
    project.docs.doc7.body = { content: new Delta().insert('Some prose.\n') };
    const maxBytes = 5_000;

    const pieces = breakChanges([createChange([{ op: 'add', path: '', value: project }])], maxBytes, undefined, {
      maxUnsplittableBytes: maxBytes,
    });

    for (const piece of pieces) expect(getJSONByteSize(piece)).toBeLessThanOrEqual(maxBytes);
    const result = applyPieces(pieces);
    // The @txt piece found the stubbed body to write into (it would throw under strict apply if it
    // ran before the doc that holds it existed).
    expect(result.docs.doc7.body.content.ops[0].insert).toMatch(/^Some prose\.\n/);
    delete result.docs.doc7.body;
    delete project.docs.doc7.body;
    expect(JSON.parse(JSON.stringify(result))).toEqual(project);
  });

  it('splits on the wire re-split too, where the 1MB payload cap applies', () => {
    const project = structureOnlyProject(9_000);
    expect(getJSONByteSize(project)).toBeGreaterThan(1_000_000);

    const batches = breakChangesIntoBatches([createChange([{ op: 'add', path: '', value: project }])], {
      maxPayloadBytes: 1_000_000,
    });

    expect(reports).toEqual([]);
    for (const batch of batches) expect(getJSONByteSize(batch)).toBeLessThanOrEqual(1_000_000);
    expect(applyPieces(batches.flat())).toEqual(project);
  });

  it('still reports an object whose bulk is one leaf value', () => {
    const value = { small: { a: 1 }, blob: 'x'.repeat(4_000) };
    const pieces = breakChanges([createChange([{ op: 'replace', path: '/data', value }])], 1_000);

    expect(reports).toEqual([expect.objectContaining({ reason: 'value-no-text', emitted: true })]);
    expect(applyPieces([{ ...pieces[0], ops: [{ op: 'add', path: '', value: {} }] }, ...pieces])).toEqual({
      data: value,
    });
  });
});

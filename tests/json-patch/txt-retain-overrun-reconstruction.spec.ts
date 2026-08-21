import { Delta } from '@dabble/delta';
import { describe, expect, it, vi } from 'vitest';
import { applyChanges, applyChangesForReconstruction } from '../../src/algorithms/ot/shared/applyChanges.js';
import { applyPatch } from '../../src/json-patch/applyPatch.js';
import type { Change } from '../../src/types.js';

/**
 * DAB-1064 — live applies drop a `@txt` retain that overran the document; historical
 * reconstruction keeps the legacy padding.
 *
 * The split exists because a committed log is not re-runnable under new semantics. When an
 * overrun once produced padding, the edits recorded after it were authored against that padded
 * text — commonly the author deleting the stray spaces by hand. Replaying such a log under the
 * live rule applies those later edits to a document that never had the padding, so an in-bounds
 * delete lands on real prose instead. These tests pin both halves, and the divergence between
 * them, so neither can be quietly unified later.
 */
describe('@txt overrun: live apply vs historical reconstruction', () => {
  const OPENING = 'she set the cup down ';
  const DOC = `${'x'.repeat(40)}${OPENING}\n`;
  const BAD_RETAIN = DOC.length + OPENING.length;

  const textOf = (value: unknown) =>
    new Delta(value as any).ops
      .filter(op => typeof op.insert === 'string')
      .map(op => op.insert as string)
      .join('');

  const change = (rev: number, ops: any[]): Change => ({
    id: `c${rev}`,
    rev,
    baseRev: rev - 1,
    ops: [{ op: '@txt', path: '/text', value: ops }],
    createdAt: 0,
    committedAt: rev,
  });

  it('reconstruction reproduces the padding a live apply now drops', () => {
    const state = { text: new Delta().insert(DOC).ops };
    const ops = [change(1, [{ retain: BAD_RETAIN }, { insert: 'the note' }])];

    const live = applyChanges(structuredClone(state), ops) as any;
    const replayed = applyChangesForReconstruction(structuredClone(state), ops) as any;

    expect(textOf(live.text)).toBe(`${DOC}the note\n`);
    expect(textOf(replayed.text)).toBe(`${DOC}${''.padStart(OPENING.length)}the note\n`);
    expect(textOf(live.text)).not.toBe(textOf(replayed.text));
  });

  it('replays a later edit authored against the padding without eating real text', () => {
    // The damaging sequence: an overrun pads the document, then the author deletes the stray
    // spaces. Under the live rule that delete would consume the text typed after them.
    const state = { text: new Delta().insert(DOC).ops };
    const history = [
      change(1, [{ retain: BAD_RETAIN }, { insert: 'the note' }]),
      change(2, [{ retain: DOC.length }, { delete: OPENING.length }]),
    ];

    const replayed = applyChangesForReconstruction(structuredClone(state), history) as any;
    expect(textOf(replayed.text)).toBe(`${DOC}the note\n`);

    // Same log, live semantics: the delete lands on prose instead of padding.
    const live = applyChanges(structuredClone(state), history) as any;
    expect(textOf(live.text)).not.toBe(textOf(replayed.text));
    expect(textOf(live.text)).not.toContain('the note');
  });

  it('does not warn while reconstructing a known historical overrun', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const state = { text: new Delta().insert(DOC).ops };
      applyChangesForReconstruction(structuredClone(state), [
        change(1, [{ retain: BAD_RETAIN }, { insert: 'the note' }]),
      ]);
      expect(warn).not.toHaveBeenCalled();

      applyChanges(structuredClone(state), [change(1, [{ retain: BAD_RETAIN }, { insert: 'the note' }])]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('overran the document');
    } finally {
      warn.mockRestore();
    }
  });

  it('only reconstruction can ask for padding — the option is off by default', () => {
    const state = { text: new Delta().insert(DOC).ops };
    const ops = [{ op: '@txt', path: '/text', value: [{ retain: BAD_RETAIN }, { insert: 'the note' }] }];

    const byDefault = applyPatch(structuredClone(state), ops, { strict: true }) as any;
    const optedIn = applyPatch(structuredClone(state), ops, {
      strict: true,
      legacyTextOverrunPadding: true,
    }) as any;

    expect(textOf(byDefault.text)).toBe(`${DOC}the note\n`);
    expect(textOf(optedIn.text)).toBe(`${DOC}${''.padStart(OPENING.length)}the note\n`);
  });
});

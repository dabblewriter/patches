import { Delta } from '@dabble/delta';
import { describe, expect, it, vi } from 'vitest';
import {
  applyChanges,
  applyChangesForReconstruction,
  padTextOverrunsCreatedBefore,
  padTextOverrunsFromClients,
} from '../../src/algorithms/ot/shared/applyChanges.js';
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
    const replayed = applyChangesForReconstruction(structuredClone(state), ops, {
      legacyTextOverrunPadding: true,
    }) as any;

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

    const replayed = applyChangesForReconstruction(structuredClone(state), history, {
      legacyTextOverrunPadding: true,
    }) as any;
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
      applyChangesForReconstruction(
        structuredClone(state),
        [change(1, [{ retain: BAD_RETAIN }, { insert: 'the note' }])],
        { legacyTextOverrunPadding: true }
      );
      expect(warn).not.toHaveBeenCalled();

      applyChanges(structuredClone(state), [change(1, [{ retain: BAD_RETAIN }, { insert: 'the note' }])]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('overran the document');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not pad unless the caller opts in — seeding a new doc must not inherit it', () => {
    // The branch/review-copy case: reconstruction whose output is PERSISTED as the first
    // change of a fresh document. Padding here would bake invented characters into the new
    // doc as ordinary authored text, and a merge could carry them back into the source.
    const state = { text: new Delta().insert(DOC).ops };
    const ops = [change(1, [{ retain: BAD_RETAIN }, { insert: 'the note' }])];

    const seeded = applyChangesForReconstruction(structuredClone(state), ops) as any;
    const rendered = applyChangesForReconstruction(structuredClone(state), ops, {
      legacyTextOverrunPadding: true,
    }) as any;

    expect(textOf(seeded.text)).toBe(`${DOC}the note\n`);
    expect(textOf(seeded.text)).not.toContain('  ');
    // And it matches what a live client computes for the same log — a branch base that
    // disagrees with its parent is the failure this guards.
    expect(textOf(seeded.text)).toBe(textOf((applyChanges(structuredClone(state), ops) as any).text));
    expect(textOf(rendered.text)).not.toBe(textOf(seeded.text));
  });

  /**
   * DAB-1427 — a client on patches 0.28.1+ drops an overrun live, so the edits it makes after its
   * own overrun were authored against the DROPPED text. Rendering its log with padding shifts all
   * of them by the padding length: an accept that strips a suggestion mark lands early and the
   * mark survives in the rendered copy, while the author's own client shows it cleared.
   */
  describe('per-change padding policy', () => {
    const CUTOFF = 1_000;
    const at = (rev: number, createdAt: number, ops: any[]): Change => ({ ...change(rev, ops), createdAt });

    it('pads overruns created before the cutoff and drops those created at or after it', () => {
      const state = { text: new Delta().insert(DOC).ops };
      const policy = padTextOverrunsCreatedBefore(CUTOFF);
      const overrunOps = [{ retain: BAD_RETAIN }, { insert: 'the note' }];

      const early = applyChangesForReconstruction(structuredClone(state), [at(1, CUTOFF - 1, overrunOps)], {
        legacyTextOverrunPadding: policy,
      }) as any;
      const onCutoff = applyChangesForReconstruction(structuredClone(state), [at(1, CUTOFF, overrunOps)], {
        legacyTextOverrunPadding: policy,
      }) as any;

      expect(textOf(early.text)).toBe(`${DOC}${''.padStart(OPENING.length)}the note\n`);
      expect(textOf(onCutoff.text)).toBe(`${DOC}the note\n`);
    });

    it("replays a dropping client's later edit onto the text it was authored against", () => {
      // The customer shape: the client overran, dropped it, typed a suggestion, then accepted
      // it (strip the `ins` mark) at the position it saw.
      const state = { text: new Delta().insert(DOC).ops };
      const history = [
        at(1, CUTOFF + 1, [{ retain: BAD_RETAIN }, { insert: 'the note', attributes: { ins: 'c1' } }]),
        at(2, CUTOFF + 2, [{ retain: DOC.length }, { retain: 'the note'.length, attributes: { ins: null } }]),
      ];

      const byPolicy = applyChangesForReconstruction(structuredClone(state), history, {
        legacyTextOverrunPadding: padTextOverrunsCreatedBefore(CUTOFF),
      }) as any;
      const live = applyChanges(structuredClone(state), history) as any;
      const alwaysPadded = applyChangesForReconstruction(structuredClone(state), history, {
        legacyTextOverrunPadding: true,
      }) as any;

      const marked = (value: any) => new Delta(value).ops.filter(op => op.attributes?.ins).length;

      // The policy renders exactly what the authoring client computed: accepted, no padding.
      expect(byPolicy.text).toEqual(live.text);
      expect(marked(byPolicy.text)).toBe(0);
      // Always-pad renders invented spaces and a suggestion the author already accepted.
      expect(textOf(alwaysPadded.text)).toContain(''.padStart(OPENING.length));
      expect(marked(alwaysPadded.text)).toBe(1);
    });

    it('handles a log that spans the cutoff in one replay', () => {
      const state = { text: new Delta().insert(DOC).ops };
      const history = [
        // Padding client: overran, then deleted the stray spaces by hand.
        at(1, CUTOFF - 2, [{ retain: BAD_RETAIN }, { insert: 'old' }]),
        at(2, CUTOFF - 1, [{ retain: DOC.length }, { delete: OPENING.length }]),
        // Dropping client: overran; nothing to clean up.
        at(3, CUTOFF + 1, [{ retain: DOC.length + 3 + 500 }, { insert: 'new' }]),
      ];

      const replayed = applyChangesForReconstruction(structuredClone(state), history, {
        legacyTextOverrunPadding: padTextOverrunsCreatedBefore(CUTOFF),
      }) as any;

      // Rev 1's padding was cleaned up by rev 2; rev 3's 500-char overrun invented nothing.
      expect(textOf(replayed.text)).toBe(`${DOC}old\nnew\n`);
      expect(textOf(replayed.text)).not.toContain('  ');
    });
  });

  /**
   * DAB-1427 — the date cutoff above is a guess about the population: it assumes everyone
   * upgraded at once. They don't (30% of active users were on pre-cutoff builds the day after,
   * ~120/day a fortnight later), and for those users the guess is wrong in the direction that
   * eats prose. A change that names the build that wrote it settles it outright.
   */
  describe('padding policy from the authoring client version', () => {
    const CUTOFF = 1_000;
    const at = (rev: number, createdAt: number, ops: any[], clientVersion?: string): Change => ({
      ...change(rev, ops),
      createdAt,
      ...(clientVersion !== undefined && { clientVersion }),
    });
    // The consuming app's own mapping; Patches never parses the string.
    const padsOverruns = (v: string) => (v === 'pads' ? true : v === 'drops' ? false : undefined);
    const policy = padTextOverrunsFromClients(padsOverruns, padTextOverrunsCreatedBefore(CUTOFF));
    const overrunOps = [{ retain: BAD_RETAIN }, { insert: 'the note' }];
    const replay = (history: Change[]) =>
      textOf(
        (
          applyChangesForReconstruction({ text: new Delta().insert(DOC).ops }, history, {
            legacyTextOverrunPadding: policy,
          }) as any
        ).text
      );

    const replayWith = (withPolicy: (change: Change) => boolean, change: Change) =>
      textOf(
        (
          applyChangesForReconstruction({ text: new Delta().insert(DOC).ops }, [change], {
            legacyTextOverrunPadding: withPolicy,
          }) as any
        ).text
      );

    const PADDED = `${DOC}${''.padStart(OPENING.length)}the note\n`;
    const DROPPED = `${DOC}the note\n`;

    it('believes the change over the clock, in both directions', () => {
      // A lagging build that still pads, writing long after the cutoff — the case the date
      // cutoff gets wrong, and the one that deletes real prose when the author tidies up.
      expect(replay([at(1, CUTOFF + 10_000, overrunOps, 'pads')])).toBe(PADDED);
      // An early adopter that already drops, writing before the cutoff.
      expect(replay([at(1, CUTOFF - 10_000, overrunOps, 'drops')])).toBe(DROPPED);
    });

    it('falls back to the clock for history written before clients stamped a version', () => {
      expect(replay([at(1, CUTOFF - 1, overrunOps)])).toBe(PADDED);
      expect(replay([at(1, CUTOFF + 1, overrunOps)])).toBe(DROPPED);
    });

    it('falls back rather than guessing at a version it does not recognise', () => {
      expect(replay([at(1, CUTOFF - 1, overrunOps, 'from-the-future')])).toBe(PADDED);
      expect(replay([at(1, CUTOFF + 1, overrunOps, 'from-the-future')])).toBe(DROPPED);
    });

    it('treats an empty version string as unstamped', () => {
      expect(replay([at(1, CUTOFF - 1, overrunOps, '')])).toBe(PADDED);
    });

    it('pads a change with no createdAt rather than dropping it', () => {
      // Predates the server always setting one, so it is older than any cutoff worth picking.
      // Comparing `undefined` answers false, which would silently drop the overrun.
      const undated = { ...change(1, overrunOps), createdAt: undefined } as unknown as Change;

      expect(replay([undated])).toBe(PADDED);
    });

    it('falls back when the app mapper answers with something that is not a boolean', () => {
      // `padsOverruns` is app code — a table lookup, a config blob typed `any`. Anything but a
      // boolean means it did not decide. Handing it on would trip shouldPadTextOverrun's guard
      // and abort the replay, which for a version build means the doc never versions again.
      for (const answer of [null, 'yes', 0, 1, {}, [], NaN]) {
        const loose = padTextOverrunsFromClients(() => answer as never, padTextOverrunsCreatedBefore(CUTOFF));
        // Falls through to the date, which pads before the cutoff and drops after it.
        expect(replayWith(loose, at(1, CUTOFF - 1, overrunOps, 'pads')), String(answer)).toBe(PADDED);
        expect(replayWith(loose, at(1, CUTOFF + 1, overrunOps, 'pads')), String(answer)).toBe(DROPPED);
      }
    });

    it('throws rather than coercing when a BARE policy returns a non-boolean', () => {
      // No fallback to fall through to, so this is a caller bug. Coercing would have to pick a
      // direction and `=== true` picks "drop" — the one that puts a later in-bounds delete onto
      // real prose.
      const sloppy = (() => undefined) as unknown as (change: Change) => boolean;

      expect(() =>
        applyChangesForReconstruction({ text: new Delta().insert(DOC).ops }, [at(1, CUTOFF - 1, overrunOps)], {
          legacyTextOverrunPadding: sloppy,
          onSkippedChange: () => {},
        })
      ).toThrow(/must return a boolean/);
    });

    it('lets a throwing policy surface instead of skipping the change', () => {
      // A policy bug is the caller's; swallowing it into the skip path would drop authored
      // content on every change and blame the log.
      const boom = () => {
        throw new Error('policy is broken');
      };

      expect(() =>
        applyChangesForReconstruction({ text: new Delta().insert(DOC).ops }, [at(1, CUTOFF - 1, overrunOps)], {
          legacyTextOverrunPadding: boom,
          onSkippedChange: () => {},
        })
      ).toThrow('policy is broken');
    });

    it('reproduces the lagging-padder hand-cleanup that the date cutoff corrupts', () => {
      // A padding client overruns after the cutoff, then the author deletes the stray spaces.
      // Read as dropping, that delete lands on real prose instead.
      const history = [
        at(1, CUTOFF + 10_000, [{ retain: BAD_RETAIN }, { insert: 'note' }], 'pads'),
        at(2, CUTOFF + 10_001, [{ retain: DOC.length }, { delete: OPENING.length }], 'pads'),
      ];

      expect(replay(history)).toBe(`${DOC}note\n`);

      const byDateAlone = textOf(
        (
          applyChangesForReconstruction({ text: new Delta().insert(DOC).ops }, history, {
            legacyTextOverrunPadding: padTextOverrunsCreatedBefore(CUTOFF),
          }) as any
        ).text
      );
      // The date cutoff drops the padding, so the author's cleanup eats the prose under it.
      expect(byDateAlone).not.toBe(`${DOC}note\n`);
      expect(byDateAlone.length).toBeLessThan(`${DOC}note\n`.length);
    });
  });

  it('only an explicit opt-in gets padding — the option is off by default', () => {
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

  /**
   * The overrun warning is the only live signal that a client is STILL minting overruns. Keyed on
   * "did we pad" it fired on every replay that legitimately drops one — every blob build, every
   * history scrub, every frame of a scrub drag — burying the signal. It is keyed on "did the
   * caller supply a rule" instead.
   */
  describe('the overrun warning', () => {
    const overrunOps = [{ retain: BAD_RETAIN }, { insert: 'the note' }];
    const run = (options?: { legacyTextOverrunPadding?: boolean | ((change: Change) => boolean) }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        applyChangesForReconstruction({ text: new Delta().insert(DOC).ops }, [change(1, overrunOps)], options);
        return warn.mock.calls.filter(c => String(c[0]).includes('overran the document')).length;
      } finally {
        warn.mockRestore();
      }
    };

    it('warns on a LIVE apply, which is the signal we want to keep', () => {
      // A live apply never passes the option at all, so the warning still fires — that is the
      // signal telling us a client is still minting overruns. (`applyChangesForReconstruction`
      // always passes an explicit boolean, so the flag correctly reads every call through it as
      // a reconstruction.)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        applyChanges({ text: new Delta().insert(DOC).ops }, [change(1, overrunOps)]);
        expect(warn.mock.calls.filter(c => String(c[0]).includes('overran the document'))).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('stays quiet when the caller supplied a rule, even when that rule DROPS', () => {
      // This is the regression: a per-change policy drops some overruns and pads others, and the
      // dropping ones used to warn once per replay.
      expect(run({ legacyTextOverrunPadding: () => false })).toBe(0);
      expect(run({ legacyTextOverrunPadding: false })).toBe(0);
      expect(run({ legacyTextOverrunPadding: () => true })).toBe(0);
    });
  });
});

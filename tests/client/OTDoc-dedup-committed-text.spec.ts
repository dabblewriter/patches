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
 * DAB-1064 defect A, as the text expression of DAB-1366. `OTDoc-dedup-committed.spec.ts` pins
 * both double-apply paths for array `add`s (the children/N shape). These are the same two paths
 * driven through `@txt`, because that is the container the DAB-1064 measurement was taken in:
 * rev 8233 retained 9,483 where 9,421 was correct — an overshoot of exactly 62, the length of the
 * author's own rev-8232 insert, minted 208 ms before that insert's commit landed.
 *
 * In text the double-count is not "one index past head" but "the queued keystroke's leading
 * retain is longer by len(own in-flight insert)", and the doubled insert itself is visible as
 * repeated prose. Both are asserted here, because they fail together and a maintainer reads
 * whichever assertion runs first.
 *
 * Path 2 is also the `it.todo` left at the bottom of `OTDoc-echo-offset.spec.ts` (patches #162):
 * "an echo matching no pending change must not shift queued ops". That spec could not reach the
 * state honestly; DAB-1366 showed how — the echo simply arrives before the local mint has been
 * confirmed, so there is no pending entry for `rebaseChanges` to splice out by id.
 */
describe('OTDoc @txt — own in-flight insert must not be counted twice (DAB-1064-A via DAB-1366)', () => {
  const BASE = 'x'.repeat(20);
  // A factory, not a shared constant: adopting an echo empties the matched change's ops IN PLACE
  // (`_confirmUnstoredEchoes`), so a single array reused across `_applyOptimistic` and the echo
  // would be `[]` by the second test. Every use below gets its own copy.
  const first = () => txt([{ retain: 20 }, { insert: 'ABCDE' }]); // len 5 — the "62" of the measurement
  const seed = () => new OTDoc<TextDoc>('t', snapshot({ text: new Delta().insert(BASE).ops }, 1));

  describe('path 2 — the echo beats the local mint confirmation', () => {
    it('a queued keystroke keeps its retain when our own unconfirmed insert echoes back', () => {
      const doc = seed();

      // The author's insert is applied optimistically and parked. The store's mint write is slow,
      // so `applyChanges([local])` has NOT happened: the doc holds no pending entry for it.
      doc._applyOptimistic(first() as any);
      expect(textOf(doc.state)).toBe(`${BASE}ABCDE\n`);

      // Author keeps typing at the correct offset while the insert is un-acked.
      const second = txt([{ retain: 25 }, { insert: 'FG' }]);
      doc._applyOptimistic(second as any);
      expect(textOf(doc.state)).toBe(`${BASE}ABCDEFG\n`);

      // The committed echo lands first. With no pending entry to match by id it would read as
      // foreign, and `_rebaseOptimisticOps` would transform our parked copy against its own echo.
      doc.applyChanges([makeChange('c1', 1, 2, first(), true)]);

      // 25, not 30: the queued op's retain must not grow by len('ABCDE'). Asserted before the text
      // so the failure names the offset, which is the thing DAB-1064 is about.
      expect((second[0].value as any[])[0].retain).toBe(25);
      expect(textOf(doc.state)).toBe(`${BASE}ABCDEFG\n`); // ABCDE once, FG where it was typed
      expect(doc.committedRev).toBe(2);
      // `first` was adopted as our own echo; only the still-in-flight keystroke remains parked.
      expect((doc as any)._optimisticOps.length).toBe(1);
    });

    it('the insert itself appears once, not twice, when nothing is queued behind it', () => {
      const doc = seed();
      doc._applyOptimistic(first() as any);
      doc.applyChanges([makeChange('c1', 1, 2, first(), true)]);

      expect(textOf(doc.state)).toBe(`${BASE}ABCDE\n`); // not ...ABCDEABCDE
      expect((doc as any)._optimisticOps).toEqual([]);
    });

    it('control: with adoption disabled, the echo reads as foreign and the retain grows by the insert length', () => {
      // Mutation pin. Rather than editing `OTDoc.ts` to prove the test bites, neutralise the
      // adoption step on one instance and assert the bug's exact shape — the same hazard the
      // array spec flipped from "control" to "closed". Retain 30 = 25 + len('ABCDE'), and the
      // prose carries the insert twice. This is what a DAB-1064 user saw.
      const doc = seed();
      (doc as any)._adoptEchoedOptimisticOps = () => {};

      doc._applyOptimistic(first() as any);
      const second = txt([{ retain: 25 }, { insert: 'FG' }]);
      doc._applyOptimistic(second as any);
      doc.applyChanges([makeChange('c1', 1, 2, first(), true)]);

      expect((second[0].value as any[])[0].retain).toBe(30);
      expect(textOf(doc.state)).toBe(`${BASE}ABCDEABCDEFG\n`);
    });

    it('a genuinely foreign insert still rebases the queued keystroke — by ITS length, not ours', () => {
      // Over-matching guard: a foreign change at a different offset must be treated as foreign.
      // 26 rather than 25 separates "correctly shifted by the 1-char foreign insert" from both
      // "not shifted at all" and "doubled by our own 5-char insert" (30).
      const doc = seed();
      doc._applyOptimistic(first() as any);
      const second = txt([{ retain: 25 }, { insert: 'FG' }]);
      doc._applyOptimistic(second as any);

      doc.applyChanges([makeChange('f1', 1, 2, txt([{ insert: 'Z' }]), true)]);

      expect((second[0].value as any[])[0].retain).toBe(26);
      expect(textOf(doc.state)).toBe(`Z${BASE}ABCDEFG\n`);
      expect((doc as any)._optimisticOps.length).toBe(2); // both of ours still in flight
    });
  });

  describe('path 1 — a committed row the lagging store hands back as pending', () => {
    it('does not re-apply our committed insert on the rebuild a later foreign change triggers', () => {
      // Hydrated with our insert pending: view = base + ABCDE.
      const pendingX = makeChange('x', 1, 2, first(), false);
      const doc = new OTDoc<TextDoc>('t1', {
        state: { text: new Delta().insert(BASE).ops },
        rev: 1,
        changes: [pendingX],
      });
      expect(textOf(doc.state)).toBe(`${BASE}ABCDE\n`);

      // Echo of X as rev 2; the store's `[docs]` transaction retiring X has not settled, so the
      // algorithm hands X straight back as rebased pending.
      doc.applyChanges([makeChange('x', 1, 2, first(), true), pendingX]);
      expect(doc.committedRev).toBe(2);
      expect(textOf(doc.state)).toBe(`${BASE}ABCDE\n`);

      // A foreign change lands while the store is STILL lagging; X comes back again. The rebuild
      // must not strict-apply X on top of the committed copy — in text that is a second ABCDE
      // and a view 5 chars longer than committed head, which is exactly what the next keystroke's
      // retain would be minted from.
      const foreignY = makeChange('y', 2, 3, txt([{ insert: 'Z' }]), true);
      doc.applyChanges([foreignY, pendingX]);

      expect(textOf(doc.state)).toBe(`Z${BASE}ABCDE\n`); // not Z…ABCDEABCDE
      expect((doc as any)._pendingChanges.map((c: Change) => c.id)).not.toContain('x');
    });

    it('nor on a later hydration whose snapshot state already contains it (import path)', () => {
      const pendingX = makeChange('x', 1, 2, first(), false);
      const doc = new OTDoc<TextDoc>('t2', {
        state: { text: new Delta().insert(BASE).ops },
        rev: 1,
        changes: [pendingX],
      });
      doc.applyChanges([makeChange('x', 1, 2, first(), true), pendingX]);

      doc.import({ state: { text: new Delta().insert(`${BASE}ABCDE\n`).ops }, rev: 2, changes: [pendingX] });

      expect(textOf(doc.state)).toBe(`${BASE}ABCDE\n`);
    });
  });
});

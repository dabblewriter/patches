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
 * author's own change produces a "correct" op at a wrong offset. It does not: this client is
 * eliminated as the producer, and that negative result is most of why these are here.
 *
 * What each case is worth, measured by mutation rather than assumed — the two are not the
 * same, and only one of these is a regression pin:
 *
 * - `queued keystrokes survive an echo batched with a foreign change` FAILS when the
 *   own-change splice in `rebaseChanges` is removed. That is the regression pin.
 * - `keystrokes queued during the in-flight window…` fails only when BOTH the splice and
 *   `isPureEcho` are broken, because either guard alone already closes the window.
 * - the two view cases did not fail under any of those mutations. They document the
 *   invariant — the author's own change appears exactly once — rather than guarding the
 *   echo path, and are kept on that basis, not as regression coverage.
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

    // Asserted BEFORE the text, deliberately. Both assertions fail together when the window
    // breaks, and the text one reports an anonymous diff ("…ABCDE\nFG\n" vs "…ABCDEFG\n") while
    // this one names the shape being guarded. Whichever runs first is the message a maintainer
    // actually reads.
    //
    // Note this case does NOT fail on any single-guard regression: the window is protected
    // twice and either guard alone suffices. With `isPureEcho` true, `_rebaseOptimisticOps` is
    // never called, so the splice is never reached; disable `isPureEcho` and `rebaseChanges`
    // splices `c1` out anyway, because it is still in `_pendingChanges`. The case below is the
    // one that bites on a single break — see its note.
    expect((second[0].value as any[])[0].retain).toBe(25);
    expect(textOf(doc.state)).toBe(`${BASE}ABCDEFG
`);
  });

  it('queued keystrokes survive an echo batched with a foreign change', () => {
    const doc = seed();
    doc._applyOptimistic(first as any);
    doc.applyChanges([makeChange('c1', 1, 2, first, false)]);

    const second = txt([{ retain: 25 }, { insert: 'FG' }]);
    doc._applyOptimistic(second as any);

    const foreign = txt([{ insert: 'Z' }]);
    doc.applyChanges([makeChange('c1', 1, 2, first, true), makeChange('other', 2, 3, foreign, true)]);

    // THIS is the case that carries the regression value. A foreign change in the batch makes
    // `isPureEcho` false, so `_rebaseOptimisticOps` runs for real and the own-change splice in
    // `rebaseChanges` is the only thing standing between the queued op and a double-count.
    // Disable that splice alone and this fails with the corrupted-text shape.
    //
    // The discriminating assertion is 26 rather than 31: it separates "correctly rebased by a
    // remote change" (shifted by the foreign insert, 1 char) from "doubled by our own"
    // (shifted by `first`'s insert, 5 chars). A test that only asserted "not 25" would pass
    // under the bug.
    expect((second[0].value as any[])[0].retain).toBe(26);
    expect(textOf(doc.state)).toBe(`Z${BASE}ABCDEFG
`);
  });

  // The one shape in this window that WOULD double-count, and the shape the consumer-side
  // telemetry is now hunting: an echo whose id matches no pending change. `rebaseChanges`
  // splices our own change out by id, so an echo arriving after its pending entry has already
  // been dropped is indistinguishable from a foreign change — and the queued ops get
  // transformed against our own insert, shifting them by exactly its length.
  //
  // Left as a todo rather than a test because reaching that state through the public surface
  // needs a pending-queue divergence this spec has no honest way to construct; forcing it by
  // mutating internals would pin the mock, not the behaviour.
  it.todo('unrecognized echo: an echo matching no pending change must not shift queued ops');
});

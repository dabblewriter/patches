import { Delta, type Op } from '@dabble/delta';
import { replace } from '../ops/replace.js';
import type { JSONPatchOpHandler } from '../types.js';
import { get } from '../utils/get.js';
import { log } from '../utils/log.js';
import { updateRemovedOps } from '../utils/ops.js';

/**
 * Normalize a `@txt` op's `value` to a bare `Op[]` array.
 *
 * The canonical form is an array of Delta ops, but historically `JSONPatch.text()`,
 * `text.compose()`, and `text.invert()` produced `Delta` instances. Those serialize
 * via `JSON.stringify` to `{ ops: [...] }`, so any rehydrated op may land in either
 * shape. Accept all three; return `null` if the input isn't a recognizable Delta.
 */
export function toOps(value: unknown): Op[] | null {
  if (Array.isArray(value)) return value as Op[];
  if (value && typeof value === 'object' && Array.isArray((value as { ops?: unknown }).ops)) {
    return (value as { ops: Op[] }).ops;
  }
  return null;
}

export const text: JSONPatchOpHandler = {
  like: 'replace',

  apply(state, path, value) {
    const ops = toOps(value);
    if (!ops) {
      return 'Invalid delta';
    }
    const delta = new Delta(ops);

    const existingData: Op[] | Delta | { ops: Op[] } | undefined = get(state, path);

    let doc: Delta | undefined;
    if (Array.isArray(existingData)) {
      if (existingData.length && existingData[0].insert) {
        doc = new Delta(existingData);
      }
    } else if (existingData && existingData.ops) {
      doc = new Delta(existingData.ops);
    }

    if (!doc) {
      doc = new Delta().insert('\n');
    }

    doc = doc.compose(delta);

    doc = fixBadDeltaDoc(doc, state.legacyTextOverrunPadding === true);

    return replace.apply(state, path, doc);
  },

  transform(state, thisOp, otherOps) {
    log('Transforming ', otherOps, ' against "@txt"', thisOp);

    const thisOps = toOps(thisOp.value);
    // Sequential @txt ops in otherOps each apply after the previous, so this op's delta must be advanced over each
    // one to stay in the same coordinate space as the next
    let thisDelta = thisOps && new Delta(thisOps);
    return updateRemovedOps(state, thisOp.path, otherOps, true, thisOp.op, op => {
      if (op.path !== thisOp.path) return null; // If a subpath, it is overwritten
      const otherOpsArr = toOps(op.value);
      if (!thisDelta || !otherOpsArr) return null; // If not a delta, it is overwritten
      const otherDelta = new Delta(otherOpsArr);
      const transformed = thisDelta.transform(otherDelta, true);
      thisDelta = otherDelta.transform(thisDelta, false);
      return { ...op, value: transformed.ops };
    });
  },

  invert(state, { path, value }, oldValue: Delta | { ops?: Op[] } | undefined, changedObj) {
    if (path.endsWith('/-')) path = path.slice(0, -1) + changedObj.length;
    if (oldValue === undefined) return { op: 'remove', path };
    const ops = toOps(value);
    if (!ops) throw new Error(`Cannot invert @txt op at ${path}: value is not a Delta ops array`);
    // The prior value comes off the document, where a text field is stored as a plain
    // `{ ops }` object as often as a Delta instance — `Delta.invert` needs the instance and
    // fails with `base.slice is not a function` on the bare object. `apply`, `transform` and
    // `compose` all normalize through `toOps` already; this one did not.
    const baseOps = toOps(oldValue);
    if (!baseOps) throw new Error(`Cannot invert @txt op at ${path}: prior value is not a Delta ops array`);
    return { op: '@txt', path, value: new Delta(ops).invert(new Delta(baseOps)).ops };
  },

  compose(state, delta1, delta2) {
    const ops1 = toOps(delta1);
    if (!ops1) throw new Error('Cannot compose @txt ops: first value is not a Delta ops array');
    const ops2 = toOps(delta2);
    if (!ops2) throw new Error('Cannot compose @txt ops: second value is not a Delta ops array');
    return new Delta(ops1).compose(new Delta(ops2)).ops;
  },
};

/**
 * Drop non-insert ops (retain/delete that overran the document) and ensure the document
 * ends with a newline.
 *
 * A document is insert-only, so `compose` consumes every in-bounds retain. Anything left
 * refers to content past the end of the document — i.e. the change was authored against a
 * longer document than the one it landed on.
 *
 * These used to be converted to space inserts, to keep the author's later offsets valid.
 * That trades a misplaced edit for a corrupted one: the spaces are indistinguishable from
 * typed text, so the document silently grows past its own content and every later offset
 * lands in the wrong place. DAB-1064 traced a reader's scrambled manuscript to exactly
 * this — an overrun became spaces, and the author's next edit inserted itself in front of
 * the previous one.
 *
 * The padding was worse than it looks, because it applied to `retain(n, attributes)` too:
 * a formatting op that overran produced n spaces *carrying that formatting*. Invented
 * characters that are also styled. Dropping handles both shapes the same way, which is why
 * "could we at least keep formatting retains?" is not a rescue.
 *
 * What the drop costs: since a stored document always ends in a newline, the overrunning
 * edit lands *after* that newline — its own paragraph at the end of the document, not at
 * the author's caret. That is the accepted trade. A visibly misplaced edit the author can
 * see and move beats silent corruption of text they have already written.
 *
 * `legacyPadding` keeps the old behaviour, and ONLY historical reconstruction may ask for it.
 * Replay has to reproduce what clients actually computed at the time: in a log that contains
 * an overrun, the edits that follow were authored against the padded text — including, very
 * often, the author deleting the stray spaces by hand. Replaying that log under the new rule
 * applies those later edits to a document that never had the padding, so an in-bounds delete
 * lands on real prose instead. Same log, same code, silently different document. Hence two
 * modes rather than one: new applies stop the corruption, settled history stays readable.
 */
function fixBadDeltaDoc(delta: Delta, legacyPadding: boolean): Delta {
  // Find where trailing non-inserts start (these can be dropped)
  let overrun = 0;
  while (delta.ops.length && delta.ops[delta.ops.length - 1].insert === undefined) {
    const dropped = delta.ops.pop();
    overrun += dropped?.retain ?? dropped?.delete ?? 0;
  }
  const endsWithNewline =
    delta.ops.length > 0 &&
    typeof delta.ops[delta.ops.length - 1].insert === 'string' &&
    (delta.ops[delta.ops.length - 1].insert as string).endsWith('\n');
  if (!endsWithNewline) {
    delta.push({ insert: '\n' });
  }

  // Rebuild only if a non-insert survived in the middle of the document. `Delta.push` is
  // load-bearing here: it merges adjacent inserts, which callers depend on.
  if (delta.ops.some(op => op.insert === undefined)) {
    const newDelta = new Delta();
    for (const op of delta.ops) {
      if (op.insert !== undefined) {
        newDelta.push(op);
      } else if (legacyPadding && op.retain) {
        // Historical reconstruction only — see the docblock.
        const insertOp: Op = { insert: ''.padStart(op.retain) };
        if (op.attributes) insertOp.attributes = op.attributes;
        newDelta.push(insertOp);
      } else {
        overrun += op.retain ?? op.delete ?? 0;
      }
    }
    delta = newDelta;
  }

  if (overrun > 0 && !legacyPadding) {
    // A change should never reference content past the end of the document. Until the client
    // bug that mints these is fixed, this is the only signal that it happened — `log` is a
    // no-op unless someone calls `verbose(true)`, which no consumer does, so warn instead.
    // Silent under reconstruction: replaying a log with a known historical overrun is expected,
    // and warning per replay would drown the live signal we actually want to count.
    console.warn(`@txt change overran the document by ${overrun}; dropped the overrun (DAB-1064)`);
  }
  return delta;
}

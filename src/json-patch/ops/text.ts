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

    doc = fixBadDeltaDoc(doc);

    return replace.apply(state, path, doc);
  },

  transform(state, thisOp, otherOps) {
    log('Transforming ', otherOps, ' against "@txt"', thisOp);

    const thisOps = toOps(thisOp.value);
    return updateRemovedOps(state, thisOp.path, otherOps, false, true, thisOp.op, op => {
      if (op.path !== thisOp.path) return null; // If a subpath, it is overwritten
      const otherOpsArr = toOps(op.value);
      if (!thisOps || !otherOpsArr) return null; // If not a delta, it is overwritten
      const thisDelta = new Delta(thisOps);
      let otherDelta = new Delta(otherOpsArr);
      otherDelta = thisDelta.transform(otherDelta, true);
      return { ...op, value: otherDelta.ops };
    });
  },

  invert(state, { path, value }, oldValue: Delta, changedObj) {
    if (path.endsWith('/-')) path = path.replace('-', changedObj.length);
    const delta = new Delta(toOps(value) ?? []);
    return oldValue === undefined ? { op: 'remove', path } : { op: '@txt', path, value: delta.invert(oldValue).ops };
  },

  compose(state, delta1, delta2) {
    return new Delta(toOps(delta1) ?? []).compose(new Delta(toOps(delta2) ?? [])).ops;
  },
};

/**
 * Fix non-insert ops (retain/delete that overran the document)
 * Convert retains to space inserts to preserve cursor positions and subsequent edits
 * Ensure document ends with a newline
 */
function fixBadDeltaDoc(delta: Delta): Delta {
  // Find where trailing non-inserts start (these can be dropped)
  while (delta.ops.length && delta.ops[delta.ops.length - 1].insert === undefined) {
    delta.ops.pop();
  }
  const endsWithNewline =
    delta.ops.length > 0 &&
    typeof delta.ops[delta.ops.length - 1].insert === 'string' &&
    (delta.ops[delta.ops.length - 1].insert as string).endsWith('\n');
  if (!endsWithNewline) {
    delta.push({ insert: '\n' });
  }

  // Check if we need to fix any middle-of-doc retains
  const hasNonInsertOps = delta.ops.some(op => op.insert === undefined);
  if (!hasNonInsertOps) {
    return delta;
  }
  const newDelta = new Delta();

  for (const op of delta.ops) {
    if (op.insert !== undefined) {
      newDelta.push(op);
    } else if (op.retain) {
      // Convert retain to spaces to preserve cursor positions
      const insertOp: Op = { insert: ''.padStart(op.retain) };
      if (op.attributes) insertOp.attributes = op.attributes;
      newDelta.push(insertOp);
    }
  }
  return newDelta;
}

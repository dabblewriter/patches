import type { Op } from '@dabble/delta';
import { Delta } from '@dabble/delta';
import { type JSONPatchOpHandler } from '../../types.js';
import { get, log, updateRemovedOps } from '../../utils/index.js';
import { Compact } from '../compactPatch.js';
import { replace } from '../ops/replace.js';

export const text: JSONPatchOpHandler = {
  like: 'replace',

  apply(state, path, value) {
    const delta = Array.isArray(value) ? new Delta(value) : (value as Delta);
    if (!delta || !Array.isArray(delta.ops)) {
      return 'Invalid delta';
    }

    let existingData: Op[] | Delta | { ops: Op[] } | undefined = get(state, path);

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

    if (hasInvalidOps(doc)) {
      return 'Invalid text delta provided for this text document';
    }

    return replace.apply(state, path, doc);
  },

  transform(state, thisOp, otherOps) {
    log('Transforming ', otherOps, ' against "@txt"', thisOp);

    return updateRemovedOps(state, Compact.getPath(thisOp), otherOps, false, true, Compact.getOp(thisOp), op => {
      if (Compact.getPath(op) !== Compact.getPath(thisOp)) return null; // If a subpath, it is overwritten
      if (!Compact.getValue(op) || !Array.isArray(Compact.getValue(op))) return null; // If not a delta, it is overwritten
      const thisDelta = new Delta(Compact.getValue(thisOp));
      let otherDelta = new Delta(Compact.getValue(op));
      otherDelta = thisDelta.transform(otherDelta, true);
      return Compact.create(Compact.getOp(op), Compact.getPath(op), otherDelta.ops);
    });
  },

  invert(_state, op, oldValue: Delta, changedObj) {
    let path = Compact.getPath(op);
    const value = Compact.getValue(op);
    if (path.endsWith('/-')) path = path.replace('-', changedObj.length);
    const delta = new Delta(value);
    return oldValue === undefined
      ? Compact.create('remove', path)
      : Compact.create('text', path, delta.invert(oldValue));
  },

  compose(_state, delta1, delta2) {
    return new Delta(delta1).compose(new Delta(delta2));
  },
};

function hasInvalidOps(doc: Delta) {
  return doc.ops.some(op => typeof op.insert !== 'string' && (typeof op.insert !== 'object' || op.insert === null));
}

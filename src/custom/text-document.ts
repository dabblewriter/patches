import type { Op } from '@typewriter/document';
import { Delta, TextDocument } from '@typewriter/document';
import { replace } from '../ops/replace.js';
import type { JSONPatchOpHandler } from '../types.js';
import { get, log, updateRemovedOps } from '../utils/index.js';

export const textDocument: JSONPatchOpHandler = {
  like: 'replace',

  apply(state, path, value, _, createMissingObjects) {
    const delta = Array.isArray(value) ? new Delta(value) : (value as Delta);
    if (!delta || !Array.isArray(delta.ops)) {
      return 'Invalid delta';
    }

    let existingData: Op[] | TextDocument | Delta | { ops: Op[] } | undefined = get(state, path);

    let doc: TextDocument | undefined;
    if (existingData && (existingData as TextDocument).lines) {
      doc = existingData as TextDocument;
    } else if (Array.isArray(existingData)) {
      if (existingData.length && existingData[0].insert) {
        doc = new TextDocument(new Delta(existingData));
      }
    } else if (existingData && (existingData as Delta).ops) {
      doc = new TextDocument(new Delta((existingData as Delta).ops));
    }

    if (!doc) {
      doc = new TextDocument();
    }

    try {
      doc = doc.apply(delta, undefined, true);
    } catch (err) {
      return 'Invalid text delta: ' + (err as Error).message;
    }

    if (hasInvalidOps(doc)) {
      return 'Invalid text delta provided for this text document';
    }

    return replace.apply(state, path, doc, _, createMissingObjects);
  },

  transform(state, thisOp, otherOps) {
    log('Transforming ', otherOps, ' against "@txt"', thisOp);

    return updateRemovedOps(state, thisOp.path, otherOps, false, true, thisOp.op, op => {
      if (op.path !== thisOp.path) return null; // If a subpath, it is overwritten
      if (!op.value || !Array.isArray(op.value)) return null; // If not a delta, it is overwritten
      const thisDelta = new Delta(thisOp.value);
      let otherDelta = new Delta(op.value);
      otherDelta = thisDelta.transform(otherDelta, true);
      return { ...op, value: otherDelta.ops };
    });
  },

  invert(state, { path, value }, oldValue: TextDocument, changedObj) {
    const txtOp = '@txt' in state.types ? '@txt' : '@changeText';
    if (path.endsWith('/-')) path = path.replace('-', changedObj.length);
    const delta = new Delta(value);
    return oldValue === undefined
      ? { op: 'remove', path }
      : { op: txtOp, path, value: delta.invert(oldValue.toDelta()) };
  },

  compose(state, delta1, delta2) {
    return new Delta(delta1).compose(new Delta(delta2));
  },
};

function hasInvalidOps(doc: TextDocument) {
  return doc.lines.some(line =>
    line.content.ops.some(op => typeof op.insert !== 'string' && (typeof op.insert !== 'object' || op.insert === null))
  );
}

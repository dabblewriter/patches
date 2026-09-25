import { applyPatch } from '../../../json-patch/applyPatch.js';
import type { JSONPatchOp } from '../../../json-patch/types.js';
import { toKeys } from '../../../json-patch/utils/toKeys.js';
import type { ArrayIndexNormalization, Change } from '../../../types.js';

export type { ArrayIndexNormalization } from '../../../types.js';

const INDEXED_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy']);
const TRAILING_INDEX = /\/\d+$/;

/**
 * Cheap pre-check: does any op in these changes address a numeric trailing segment? Only those
 * can carry an out-of-range array index, and only those make the commit pay for loading state.
 */
export function hasIndexedOps(changes: Change[]): boolean {
  return changes.some(change =>
    change.ops.some(
      op =>
        INDEXED_OPS.has(op.op) &&
        (TRAILING_INDEX.test(op.path) ||
          (op.op === 'move' && typeof op.from === 'string' && TRAILING_INDEX.test(op.from)))
    )
  );
}

/**
 * Rewrites array-index ops that fall outside the array they address in `state`, so a committed
 * change can never be one that strict replay rejects (DAB-1557: such a row wedges every client
 * that replays it, permanently).
 *
 * The two kinds of wrong get two treatments, matching what each op's index means:
 *
 * - `add` (and the destination of `move` and `copy`) name an insert POSITION. Past the end → clamp to append.
 *   The value is the payload and survives intact; only its position shifts.
 * - `remove`, `replace` and `move`'s source name an EXISTING element. Past the end → drop the
 *   op. Clamping would splice a different, real element; dropping loses nothing, because the
 *   element the op meant is already absent.
 *
 * Changes are sequential programs, so each is checked against the state the previous ones
 * produce. A change that fails for any OTHER reason is left exactly as sent and does not advance
 * the working state — the same change-granular skip `applyChangesForReconstruction` makes, so
 * the frame the rest of the batch is checked in matches the one every replica will build.
 *
 * A change whose every op is dropped is kept with empty ops rather than removed: the sender
 * confirms its pending changes by id from the echo.
 */
export function normalizeArrayIndices(
  state: any,
  changes: Change[]
): { changes: Change[]; normalizations: ArrayIndexNormalization[] } {
  const normalizations: ArrayIndexNormalization[] = [];
  let changed = false;

  const result = changes.map(change => {
    let working = state;
    const ops: JSONPatchOp[] = [];
    const found: ArrayIndexNormalization[] = [];

    for (const op of change.ops) {
      const outcome = applyNormalized(working, op);
      if (outcome.failed) {
        // Unappliable for a reason this pass does not own: leave the change as sent.
        return change;
      }
      working = outcome.state;
      if (outcome.normalization) {
        found.push({ change, op, ...outcome.normalization });
        if (outcome.op) ops.push(outcome.op);
      } else {
        ops.push(op);
      }
    }

    state = working;
    if (!found.length) return change;
    normalizations.push(...found);
    changed = true;
    return { ...change, ops };
  });

  return { changes: changed ? result : changes, normalizations };
}

type Outcome =
  | { failed: true }
  | {
      failed?: false;
      state: any;
      op?: JSONPatchOp;
      normalization?: { action: 'clamped' | 'dropped'; index: number; length: number };
    };

function applyNormalized(state: any, op: JSONPatchOp): Outcome {
  const error = tryApply(state, op);
  if (typeof error !== 'string') return { state: error.state };

  const kind = invalidIndexKind(error);
  if (!kind) return { failed: true };

  // The source of a move, or the target of a remove/replace: the element does not exist.
  if (kind === op.op && op.op !== 'add') {
    const indexPath = op.op === 'move' ? op.from! : op.path;
    const [array, index] = resolveIndex(state, indexPath);
    if (!array) return { failed: true };
    return { state, normalization: { action: 'dropped', index, length: array.length } };
  }

  // An insert position past the end: `add` itself, or the destination of a move or copy (both
  // report it through the internal add).
  if (kind === 'add' && (op.op === 'add' || op.op === 'move' || op.op === 'copy')) {
    // A move's destination is addressed in the document AFTER its source is taken out — the
    // array may be shorter, or (source earlier in a parent array) a different array entirely.
    const frame = op.op === 'move' ? tryApply(state, { op: 'remove', path: op.from! }) : { state };
    if (typeof frame === 'string') return { failed: true };
    const [array, index] = resolveIndex(frame.state, op.path);
    if (!array) return { failed: true };
    const length = array.length;
    const clamped = { ...op, path: op.path.slice(0, op.path.lastIndexOf('/') + 1) + length };
    const applied = tryApply(state, clamped);
    if (typeof applied === 'string') return { failed: true };
    return { state: applied.state, op: clamped, normalization: { action: 'clamped', index, length } };
  }

  return { failed: true };
}

function tryApply(state: any, op: JSONPatchOp): { state: any } | string {
  try {
    return { state: applyPatch(state, [op], { strict: true }) };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** `[op:<name>] invalid array index: …` → `<name>`; anything else → undefined. */
function invalidIndexKind(message: string): string | undefined {
  return /^\[op:(\w+)\] invalid array index: /.exec(message)?.[1];
}

/** The array `path` indexes into, and the index it asks for, in a plain JSON document. */
function resolveIndex(doc: any, path: string): [any[] | undefined, number] {
  const keys = toKeys(path);
  const index = Number(keys.pop());
  let target = doc;
  for (let i = 1; i < keys.length; i++) {
    if (target == null || typeof target !== 'object') return [undefined, index];
    target = target[keys[i]];
  }
  return Array.isArray(target) && Number.isInteger(index) ? [target, index] : [undefined, index];
}

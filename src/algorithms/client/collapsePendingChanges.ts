import type { Change } from '../../types.js';

interface PathState {
  lastChange: Change;
  lastIndex: number;
}

/**
 * Collapses redundant pending changes before sync to reduce network traffic.
 *
 * This optimization automatically detects and collapses multiple "replace" operations
 * on the same JSON path with primitive values (boolean, number, string, null) into
 * a single change containing only the final value.
 *
 * Example: If a user toggles a folder's open state 100 times while offline,
 * this collapses those 100 changes into just 1 change with the final state.
 *
 * Safety guarantees:
 * - Only collapses single-op changes (multi-op changes are atomic, preserve intent)
 * - Only collapses "replace" operations (not add, remove, move)
 * - Only collapses primitive values (not objects/arrays)
 * - Detects path invalidation from structural changes (remove, array shifts, move)
 * - Respects the submission bookmark to never collapse already-submitted changes
 *
 * @param changes Array of pending changes to potentially collapse
 * @param afterRev Optional revision bookmark - changes at or before this rev are not collapsed
 *                 (they may have been partially submitted to the server)
 * @returns Collapsed array of changes, maintaining correct ordering
 */
export function collapsePendingChanges(changes: Change[], afterRev?: number): Change[] {
  if (changes.length <= 1) {
    return changes;
  }

  // Track: path → { lastChange, lastIndex }
  const pathState = new Map<string, PathState>();
  // Output slots - null means the change was collapsed into a later one
  const outputSlots: (Change | null)[] = new Array(changes.length).fill(null);

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];

    // Never collapse changes at or before submission bookmark
    if (afterRev !== undefined && change.rev !== undefined && change.rev <= afterRev) {
      outputSlots[i] = change;
      continue;
    }

    // Check if this change invalidates any tracked paths before processing
    updatePathInvalidations(change, pathState);

    // Check if collapsible
    if (!isCollapsibleChange(change)) {
      outputSlots[i] = change;
      continue;
    }

    const path = change.ops[0].path;

    const existing = pathState.get(path);
    if (existing) {
      // Collapse: null out the previous slot, this change takes its place
      outputSlots[existing.lastIndex] = null;
    }

    pathState.set(path, { lastChange: change, lastIndex: i });
    outputSlots[i] = change;
  }

  return outputSlots.filter((c): c is Change => c !== null);
}

/**
 * Checks if a change can be collapsed with other changes on the same path.
 * Requirements:
 * - Single operation (multi-op changes are atomic)
 * - Operation is "replace"
 * - Value is a primitive (boolean, number, string, null)
 */
function isCollapsibleChange(change: Change): boolean {
  // Must be a single-op change
  if (change.ops.length !== 1) {
    return false;
  }

  const op = change.ops[0];

  // Must be a replace operation
  if (op.op !== 'replace') {
    return false;
  }

  // Must have a primitive value
  return isPrimitiveValue(op.value);
}

/**
 * Checks if a value is a primitive (can be safely collapsed).
 */
function isPrimitiveValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  return type === 'boolean' || type === 'number' || type === 'string';
}

/**
 * Updates path invalidations based on the current change's operations.
 * Removes tracked paths that are affected by structural changes.
 */
function updatePathInvalidations(change: Change, pathState: Map<string, PathState>): void {
  for (const op of change.ops) {
    // Remove and move operations invalidate the path and all children
    if (op.op === 'remove' || op.op === 'move') {
      invalidatePathAndChildren(op.path, pathState);

      // For move, also invalidate the destination
      if (op.op === 'move' && 'from' in op) {
        invalidatePathAndChildren(op.from as string, pathState);
      }
    }

    // Add and remove on array indices shift other elements
    if (op.op === 'add' || op.op === 'remove') {
      invalidateShiftedArrayPaths(op.path, pathState);
    }
  }
}

/**
 * Invalidates a path and all its children from tracking.
 */
function invalidatePathAndChildren(opPath: string, pathState: Map<string, PathState>): void {
  for (const trackedPath of pathState.keys()) {
    if (trackedPath === opPath || trackedPath.startsWith(opPath + '/')) {
      pathState.delete(trackedPath);
    }
  }
}

/**
 * Invalidates paths that might be affected by array index shifts.
 * When an add or remove happens at an array index, all paths under that array
 * with numeric indices could be affected.
 */
function invalidateShiftedArrayPaths(opPath: string, pathState: Map<string, PathState>): void {
  const segments = opPath.split('/');
  const lastSegment = segments[segments.length - 1];

  // Check if the last segment is a numeric array index
  if (/^\d+$/.test(lastSegment)) {
    // Get the array's path (everything except the last segment)
    const arrayPath = segments.slice(0, -1).join('/');

    // Invalidate all tracked paths under this array
    for (const trackedPath of pathState.keys()) {
      if (trackedPath.startsWith(arrayPath + '/')) {
        pathState.delete(trackedPath);
      }
    }
  }
}

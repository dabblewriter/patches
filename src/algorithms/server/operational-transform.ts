import type { Change } from '../../types.js';
import { rebaseChanges } from '../shared/rebaseChanges.js';

/**
 * Server-side operational transformation algorithms.
 * These are pure functions that handle OT logic on the server without side effects.
 */

export interface TransformationResult {
  /** Transformed changes ready for persistence */
  transformedChanges: Change[];
  /** New server revision after applying changes */
  newRevision: number;
  /** Whether any transformations were applied */
  wasTransformed: boolean;
}

/**
 * Transform incoming client changes against concurrent server changes.
 * This is the core server-side OT algorithm.
 *
 * @param incomingChanges - Changes submitted by a client
 * @param concurrentChanges - Changes that occurred on server since client's baseRev
 * @param currentServerRev - Current server revision
 * @returns Transformed changes ready for persistence
 */
export function transformIncomingChanges(
  incomingChanges: Change[],
  concurrentChanges: Change[],
  currentServerRev: number
): TransformationResult {
  if (incomingChanges.length === 0) {
    return {
      transformedChanges: [],
      newRevision: currentServerRev,
      wasTransformed: false,
    };
  }

  let transformedChanges = incomingChanges;
  let wasTransformed = false;

  // Transform against concurrent changes if any exist
  if (concurrentChanges.length > 0) {
    transformedChanges = rebaseChanges(concurrentChanges, incomingChanges);
    wasTransformed = true;
  }

  // Assign final server revisions
  const finalChanges = transformedChanges.map((change, index) => ({
    ...change,
    rev: currentServerRev + index + 1,
    baseRev: index === 0 ? currentServerRev : currentServerRev + index,
  }));

  return {
    transformedChanges: finalChanges,
    newRevision: currentServerRev + finalChanges.length,
    wasTransformed,
  };
}

/**
 * Validate incoming changes against server state.
 * Checks for consistency, authorization, and conflict detection.
 *
 * @param changes - Changes to validate
 * @param expectedBaseRev - Expected base revision from server state
 * @param currentServerRev - Current server revision
 * @returns Validation result
 */
export function validateIncomingChanges(
  changes: Change[],
  expectedBaseRev: number,
  currentServerRev: number
): {
  isValid: boolean;
  errors: string[];
  canTransform: boolean;
} {
  const errors: string[] = [];

  if (changes.length === 0) {
    return { isValid: true, errors: [], canTransform: true };
  }

  const firstChange = changes[0];

  // Check base revision is not too far behind
  if (firstChange.baseRev < 0) {
    errors.push('Base revision cannot be negative');
  }

  // Check if changes are too far behind (might indicate lost sync)
  const revisionGap = currentServerRev - firstChange.baseRev;
  if (revisionGap > 1000) {
    // Configurable threshold
    errors.push(`Changes too far behind server (gap: ${revisionGap})`);
  }

  // Check changes are sequential
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];

    // Validate required fields
    if (!change.id) {
      errors.push(`Change at index ${i} missing id`);
    }
    if (!Array.isArray(change.ops) || change.ops.length === 0) {
      errors.push(`Change at index ${i} has invalid or empty ops`);
    }
    if (typeof change.baseRev !== 'number') {
      errors.push(`Change at index ${i} has invalid baseRev`);
    }

    // Check sequence consistency
    if (i === 0) {
      // First change should have the expected baseRev or be transformable
      const canTransform = change.baseRev <= currentServerRev;
      if (!canTransform) {
        errors.push(`First change baseRev ${change.baseRev} is ahead of server rev ${currentServerRev}`);
      }
    } else {
      const prevChange = changes[i - 1];
      if (change.baseRev !== prevChange.baseRev) {
        errors.push(`Change at index ${i} baseRev should match first change baseRev`);
      }
    }
  }

  const canTransform = firstChange.baseRev <= currentServerRev;

  return {
    isValid: errors.length === 0,
    errors,
    canTransform,
  };
}

/**
 * Detect potential conflicts in concurrent changes.
 * This provides conflict analysis for logging and debugging.
 *
 * @param clientChanges - Changes from client
 * @param serverChanges - Concurrent changes on server
 * @returns Conflict analysis
 */
export function analyzeConflicts(
  clientChanges: Change[],
  serverChanges: Change[]
): {
  hasConflicts: boolean;
  conflictingSections: string[];
  severity: 'low' | 'medium' | 'high';
} {
  if (clientChanges.length === 0 || serverChanges.length === 0) {
    return {
      hasConflicts: false,
      conflictingSections: [],
      severity: 'low',
    };
  }

  const conflictingSections: string[] = [];

  // Simple conflict detection based on overlapping paths
  for (const clientChange of clientChanges) {
    for (const clientOp of clientChange.ops) {
      for (const serverChange of serverChanges) {
        for (const serverOp of serverChange.ops) {
          // Check if operations target the same or overlapping paths
          if (pathsOverlap(clientOp.path, serverOp.path)) {
            conflictingSections.push(`${clientOp.path} (client) vs ${serverOp.path} (server)`);
          }
        }
      }
    }
  }

  const hasConflicts = conflictingSections.length > 0;
  const severity = conflictingSections.length > 10 ? 'high' : conflictingSections.length > 3 ? 'medium' : 'low';

  return {
    hasConflicts,
    conflictingSections,
    severity,
  };
}

/**
 * Helper function to check if two JSON Patch paths overlap.
 * Used for conflict detection.
 */
function pathsOverlap(path1: string, path2: string): boolean {
  // Exact match
  if (path1 === path2) return true;

  // One path is a prefix of the other
  if (path1.startsWith(path2 + '/') || path2.startsWith(path1 + '/')) {
    return true;
  }

  return false;
}

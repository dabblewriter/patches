/**
 * Thrown by store implementations when `saveChanges` detects that a revision
 * already exists. This signals a concurrent-write conflict so `commitChanges`
 * can retry with fresh state.
 *
 * Store implementations should catch their native conflict errors (e.g.
 * Firestore ALREADY_EXISTS) and re-throw as `RevConflictError`.
 */
export class RevConflictError extends Error {
  constructor(message?: string) {
    super(message ?? 'Revision conflict: another commit wrote to the same revision');
    this.name = 'RevConflictError';
  }
}

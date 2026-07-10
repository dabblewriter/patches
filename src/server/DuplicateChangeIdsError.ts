/**
 * Thrown by store implementations when `saveChanges` detects that one or more
 * of the changes being saved carry an id that has already been committed to
 * this document — the authoritative, race-proof duplicate guard.
 *
 * Why this exists: `commitChanges` dedups re-sent change ids against the
 * committed changes after the incoming `baseRev`. A retry that the client has
 * rebased onto a newer tip carries a `baseRev` PAST the original commit, so
 * the committed copy falls outside that window and the read-side check cannot
 * see it (DAB-607). Two near-simultaneous sends of the same change can also
 * both pass the read-side check before either saves. Only the store, at write
 * time, can catch both — implementations should record committed change ids
 * atomically with the changes themselves (e.g. Firestore `create()` on an id
 * marker doc inside the same batch/transaction) and throw this error naming
 * the ids that already exist.
 *
 * `commitChanges` reacts by excluding the named ids from the incoming set and
 * retrying, so the request resolves as a resend (already-committed work is
 * confirmed, never double-applied) instead of committing a duplicate.
 */
export class DuplicateChangeIdsError extends Error {
  readonly docId: string;
  readonly duplicateIds: string[];

  constructor(docId: string, duplicateIds: string[], message?: string) {
    super(message ?? `Change id(s) already committed for doc ${docId}: ${duplicateIds.join(', ')}`);
    this.name = 'DuplicateChangeIdsError';
    this.docId = docId;
    this.duplicateIds = duplicateIds;
  }
}

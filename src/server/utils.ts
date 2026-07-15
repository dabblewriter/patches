import type { EditableVersionMetadata } from '../types.js';

// Must match the Disallowed list in EditableVersionMetadata (types.ts) — RPC callers
// bypass compile-time checks, and forged startRev/endRev corrupt snapshot selection.
const nonModifiableVersionFields = new Set([
  'id',
  'parentId',
  'groupId',
  'origin',
  'startedAt',
  'endedAt',
  'startRev',
  'endRev',
]);

/**
 * Validates that version metadata does not contain non-modifiable fields.
 * @throws Error if metadata contains any non-modifiable fields.
 */
export function assertVersionMetadata(metadata?: EditableVersionMetadata) {
  if (!metadata) return;
  for (const key in metadata) {
    if (nonModifiableVersionFields.has(key)) {
      throw new Error(`Cannot modify version field ${key}`);
    }
  }
}

/**
 * True when a `loadVersionState` read came back *missing* rather than as a real snapshot.
 *
 * A recorded version whose state is absent (`undefined`) or a zero-byte read (`''`, how a
 * truncated or never-written blob surfaces) is unservable — serving it would present the
 * document as EMPTY at the version's rev. Callers turn this into a retryable 503, or walk to
 * an ancestor with state. A `ReadableStream` is always treated as present: the
 * `loadVersionState` contract (see {@link VersioningStoreBackend.loadVersionState}) requires a
 * missing/zero-byte state to surface as `''`/`undefined`, never as an empty stream, so readers
 * can stream it straight through without draining it to measure its length.
 *
 * The single predicate keeps the three snapshot readers in step: the original doc-wipe bug was
 * one caller checking `=== undefined` while a zero-byte blob reads back as `''`.
 */
export function isMissingVersionState(
  rawState: string | ReadableStream<string> | undefined
): rawState is '' | undefined {
  return rawState === undefined || rawState === '';
}

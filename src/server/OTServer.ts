import { commitChanges, type CommitChangesOptions } from '../algorithms/ot/server/commitChanges.js';
import { createVersion } from '../algorithms/ot/server/createVersion.js';
import { findLatestMainVersion, getSnapshotStream } from '../algorithms/ot/server/getSnapshotAtRevision.js';
import { createChange } from '../data/change.js';
import { signal } from 'easy-signal';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import { getClientId } from '../net/serverContext.js';
import type { Change, ChangeInput, ChangeMutator, DeleteDocOptions, EditableVersionMetadata } from '../types.js';
import type { GetDocOptions, PatchesServer } from './PatchesServer.js';
import type { OTStoreBackend } from './types.js';
import { createTombstoneIfSupported, removeTombstoneIfExists } from './tombstone.js';
import { assertVersionMetadata } from './utils.js';
export type { CommitChangesOptions } from '../algorithms/ot/server/commitChanges.js';

/**
 * Configuration options for the OTServer.
 */
export interface OTServerOptions {
  /**
   * The maximum time difference in minutes between consecutive changes
   * to be considered part of the same editing session for versioning.
   * Defaults to 30 minutes.
   */
  sessionTimeoutMinutes?: number;
  /**
   * Create a version automatically once roughly this many changes accumulate since the last
   * version, independent of `sessionTimeoutMinutes`. Session-gap versioning never fires for a
   * continuous high-rate stream (changes seconds apart), so without this a single document can
   * accrue tens of thousands of un-versioned changes and become too expensive — or impossible —
   * to load. Snapshots are taken forward in bounded steps of at most this many changes, which
   * from a near-current state keeps cold-load replay under ~2N going forward; a document already
   * further behind (or a single commit larger than N) is caught up over consecutive bounded
   * steps. Defaults to 1000; set to `0` to disable. Note this is on by default, so enabling the
   * server starts taking count-based snapshots on high-rate documents that previously had none.
   */
  maxChangesPerVersion?: number;
}

/**
 * Handles the server-side Operational Transformation (OT) logic,
 * coordinating batches of changes, managing versioning based on sessions (including offline),
 * and persisting data using a backend store.
 *
 * For compression support, wrap your store with CompressedStoreBackend before passing it:
 * @example
 * import { OTServer, CompressedStoreBackend } from '@dabble/patches/server';
 * import { base64Compressor } from '@dabble/patches/compression';
 *
 * const compressedStore = new CompressedStoreBackend(store, base64Compressor);
 * const server = new OTServer(compressedStore);
 */
export class OTServer implements PatchesServer {
  /**
   * Static API definition for use with JSONRPCServer.register().
   * Maps method names to required access levels.
   */
  static api: ApiDefinition = {
    getDoc: 'read',
    getChangesSince: 'read',
    // Named params let AuthorizationProviders validate the commit payload (role-scoped writes)
    commitChanges: { access: 'write', params: ['docId', 'changes', 'options'] },
    deleteDoc: 'write',
    undeleteDoc: 'write',
  } as const;

  private readonly sessionTimeoutMillis: number;
  private readonly maxChangesPerVersion: number;
  /** Per-doc FIFO mutex (see {@link _withDocLock}). */
  private readonly _docLocks = new Map<string, Promise<unknown>>();
  readonly store: OTStoreBackend;

  /** Notifies listeners whenever a batch of changes is *successfully* committed. */
  public readonly onChangesCommitted =
    signal<(docId: string, changes: Change[], options?: CommitChangesOptions, originClientId?: string) => void>();

  /** Notifies listeners when a document is deleted. */
  public readonly onDocDeleted = signal<(docId: string, options?: DeleteDocOptions, originClientId?: string) => void>();

  constructor(store: OTStoreBackend, options: OTServerOptions = {}) {
    this.sessionTimeoutMillis = (options.sessionTimeoutMinutes ?? 30) * 60 * 1000;
    this.maxChangesPerVersion = options.maxChangesPerVersion ?? 1000;
    this.store = store;
  }

  /**
   * Get the state of a document as a ReadableStream of JSON.
   * Streams `{"state":...,"rev":N,"changes":[...]}` with the version state
   * flowing through without parsing.
   * @param docId - The ID of the document.
   * @param options - Optional read options; `rev` reads the document as of a revision.
   * @returns A ReadableStream of JSON string chunks.
   */
  async getDoc(docId: string, options?: GetDocOptions): Promise<ReadableStream<string>> {
    return getSnapshotStream(this.store, docId, options?.rev);
  }

  /**
   * Get changes that occurred after a specific revision.
   * @param docId - The ID of the document.
   * @param rev - The revision number.
   * @returns Array of changes after the given revision.
   */
  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    return this.store.listChanges(docId, { startAfter: rev });
  }

  /**
   * Commits a set of changes to a document, applying operational transformation as needed.
   *
   * Returns all changes the client needs to apply (catchup changes from others, followed
   * by the client's own transformed changes), plus an optional `docReloadRequired` flag.
   *
   * When `docReloadRequired` is true, the client must call `getDoc` to reload the full
   * current state before continuing — its local state is stale.
   *
   * @param docId - The ID of the document.
   * @param changes - The changes to commit.
   * @param options - Optional commit settings (e.g., forceCommit for migrations).
   * @returns An object with the committed changes and an optional reload flag.
   */
  async commitChanges(
    docId: string,
    changes: ChangeInput[],
    options?: CommitChangesOptions
  ): Promise<{ changes: Change[]; docReloadRequired?: true }> {
    const clientId = getClientId();
    // Stamp the sender's connection identity onto the changes so committed rows carry their
    // origin: the commit path's own-echo detection matches by change id / batch id, and without
    // origin awareness a foreign committed change with a colliding id is silently excluded from
    // the transform set — the rest of the batch then commits in the wrong frame (DAB-601).
    // Absent on changes committed before this stamp existed; matching falls back to id-only.
    if (clientId) changes = changes.map(c => (c.clientId === clientId ? c : { ...c, clientId }));
    return this._withDocLock(docId, async () => {
      const { catchupChanges, newChanges, docReloadRequired } = await commitChanges(
        this.store,
        docId,
        changes,
        this.sessionTimeoutMillis,
        { ...options, maxChangesPerVersion: this.maxChangesPerVersion }
      );

      // Notify about newly committed changes (broadcast to other clients)
      if (newChanges.length > 0) {
        try {
          await this.onChangesCommitted.emit(docId, newChanges, options, clientId);
        } catch (error) {
          console.error(`Failed to notify clients about committed changes for doc ${docId}:`, error);
        }
      }

      const result: { changes: Change[]; docReloadRequired?: true } = {
        changes: [...catchupChanges, ...newChanges],
      };
      if (docReloadRequired) result.docReloadRequired = true;
      return result;
    });
  }

  /**
   * Make a server-side change to a document.
   * Stateless — uses getCurrentRev instead of loading document state.
   */
  async change<T = Record<string, any>>(
    docId: string,
    mutator: ChangeMutator<T>,
    metadata?: Record<string, any>
  ): Promise<Change | null> {
    const rev = await this.store.getCurrentRev(docId);
    const patch = createJSONPatch<T>(mutator);
    if (patch.ops.length === 0) {
      return null;
    }

    // Provide rev like a client would; commitChanges handles conflicts
    const change = createChange(rev, rev + 1, patch.ops, metadata);

    // No patch.apply(state) — bad ops become noops at apply time (resilient state building)
    await this.commitChanges(docId, [change]);
    return change;
  }

  /**
   * Deletes a document.
   * Stateless — uses getCurrentRev instead of loading document state.
   * @param docId The document ID.
   * @param options - Optional deletion settings (e.g., skipTombstone for testing).
   */
  async deleteDoc(docId: string, options?: DeleteDocOptions): Promise<void> {
    const clientId = getClientId();
    return this._withDocLock(docId, async () => {
      const rev = await this.store.getCurrentRev(docId);
      await createTombstoneIfSupported(this.store, docId, rev, clientId, options?.skipTombstone);
      await this.store.deleteDoc(docId);
      await this.onDocDeleted.emit(docId, options, clientId);
    });
  }

  /**
   * Removes the tombstone for a deleted document, allowing it to be recreated.
   * @param docId The document ID.
   * @returns True if tombstone was found and removed, false if no tombstone existed.
   */
  async undeleteDoc(docId: string): Promise<boolean> {
    return this._withDocLock(docId, () => removeTombstoneIfExists(this.store, docId));
  }

  // === Version Operations ===

  /**
   * Captures the current state of a document as a new version.
   * Does NOT build state — creates version metadata + changes, then emits
   * `onVersionCreated` so subscribers can build and persist state out of band.
   *
   * The version chains to the latest main version, so the store builds its state from that
   * snapshot plus the changes since. Left unchained it would have to replay the document's
   * entire history from rev 1 (see `getBaseStateBeforeVersion`).
   *
   * @param docId The document ID.
   * @param metadata Optional metadata for the version.
   * @returns The ID of the created version, or null if no changes to capture.
   */
  async captureCurrentVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string | null> {
    assertVersionMetadata(metadata);
    const parent = await findLatestMainVersion(this.store, docId);
    const changes = await this.store.listChanges(docId, { startAfter: parent?.endRev ?? 0 });
    const version = await createVersion(this.store, docId, changes, { metadata, parentId: parent?.id });
    if (!version) {
      return null;
    }
    return version.id;
  }

  /**
   * Run `fn` exclusively per `docId`: same-doc calls run one at a time, FIFO. Without this a
   * `deleteDoc` can complete inside an in-flight commit's read-then-save window, so the commit
   * lands after the store wipe — leaving a live tombstone plus an orphan change tail (and a
   * broadcast for a deleted doc). Per-instance only; multi-instance deployments still rely on
   * the store's `RevConflictError` guard for commit races.
   */
  private _withDocLock<R>(docId: string, fn: () => Promise<R>): Promise<R> {
    const prior = this._docLocks.get(docId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Stored tail never rejects, so one failed op doesn't reject the whole chain; the caller
    // still sees `run`'s real outcome. GC the map entry once this is the last queued op.
    const tail = run.catch(() => undefined);
    this._docLocks.set(docId, tail);
    void tail.then(() => {
      if (this._docLocks.get(docId) === tail) this._docLocks.delete(docId);
    });
    return run;
  }
}

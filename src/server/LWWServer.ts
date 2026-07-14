import { createVersionMetadata } from '../data/version.js';
import { consolidateOps, convertDeltaOps } from '../algorithms/lww/consolidateOps.js';
import { createChange } from '../data/change.js';
import { signal } from 'easy-signal';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import { getClientId } from '../net/serverContext.js';
import type {
  Change,
  ChangeInput,
  ChangeMutator,
  CommitChangesOptions,
  DeleteDocOptions,
  EditableVersionMetadata,
} from '../types.js';
import { concatStreams } from './jsonReadable.js';
import type { GetDocOptions, PatchesServer } from './PatchesServer.js';
import { createTombstoneIfSupported, removeTombstoneIfExists } from './tombstone.js';
import type { LWWStoreBackend, VersioningStoreBackend } from './types.js';
import { assertVersionMetadata } from './utils.js';

/**
 * Configuration options for LWWServer.
 */
export interface LWWServerOptions {
  /**
   * How long committed change ids are retained for retry dedup, in milliseconds.
   * Must cover offline clients that restart and retry a persisted sending change
   * days later. Default: 30 days. Only used when the store implements seenChangeIds.
   */
  changeIdTTL?: number;
}

const DEFAULT_CHANGE_ID_TTL = 30 * 24 * 60 * 60 * 1000;

/**
 * Last-Write-Wins (LWW) server implementation.
 *
 * Unlike OTServer which stores changes and uses Operational Transformation,
 * LWWServer stores fields with timestamps. Conflicts are resolved by comparing
 * timestamps - the later timestamp wins.
 *
 * Key differences from OT:
 * - Stores fields, not changes
 * - No transformation needed
 * - Simpler conflict resolution
 * - Better suited for settings, preferences, status data
 *
 * @example
 * ```typescript
 * import { LWWServer } from '@dabble/patches/server';
 *
 * const store = new MyLWWStoreBackend();
 * const server = new LWWServer(store);
 *
 * // Commit changes with timestamps
 * const changes = await server.commitChanges('doc1', [{
 *   id: 'change1',
 *   ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: Date.now() }],
 * }]);
 * ```
 */
export class LWWServer implements PatchesServer {
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

  readonly store: LWWStoreBackend;

  private readonly _changeIdTTL: number;

  /** Per-doc FIFO mutex (see {@link _withDocLock}). */
  private readonly _docLocks = new Map<string, Promise<unknown>>();

  /** Notifies listeners whenever a batch of changes is successfully committed. */
  public readonly onChangesCommitted =
    signal<(docId: string, changes: Change[], options?: CommitChangesOptions, originClientId?: string) => void>();

  /** Notifies listeners when a document is deleted. */
  public readonly onDocDeleted = signal<(docId: string, options?: DeleteDocOptions, originClientId?: string) => void>();

  constructor(store: LWWStoreBackend, options: LWWServerOptions = {}) {
    this.store = store;
    this._changeIdTTL = options.changeIdTTL ?? DEFAULT_CHANGE_ID_TTL;
  }

  /**
   * Get the current state of a document as a ReadableStream of JSON.
   * Streams `{"state":...,"rev":N,"changes":[...]}` with the snapshot state
   * flowing through without parsing.
   *
   * @param docId - The document ID.
   * @param options - `rev` is unsupported for LWW (no per-revision history); passing it throws.
   * @returns A ReadableStream of JSON string chunks.
   */
  async getDoc(docId: string, options?: GetDocOptions): Promise<ReadableStream<string>> {
    if (options?.rev != null) throw new Error('LWW documents do not support reading at a specific revision');
    const snapshot = await this.store.getSnapshot(docId);
    const baseRev = snapshot?.rev ?? 0;

    const ops = await this.store.listOps(docId, { sinceRev: baseRev });

    // Synthesize a change from ops (if any)
    let changes: Change[] = [];
    if (ops.length > 0) {
      const sortedOps = sortOpsByCommitOrder(ops);
      const maxRev = Math.max(baseRev, ...ops.map(op => op.rev ?? 0));
      const maxTs = Math.max(...ops.map(op => op.ts ?? 0));
      changes = [createChange(baseRev, maxRev, sortedOps, { committedAt: maxTs || Date.now() })];
    }

    // Stream: snapshot state flows through without parsing, changes are stringified
    const statePayload: string | ReadableStream<string> = snapshot?.state ?? '{}';
    const rev = changes[changes.length - 1]?.rev || baseRev;
    return concatStreams(`{"state":`, statePayload, `,"rev":${rev},"changes":`, JSON.stringify(changes), '}');
  }

  /**
   * Get changes that occurred after a specific revision.
   * LWW doesn't store changes, so this synthesizes a change from ops.
   *
   * @param docId - The document ID.
   * @param rev - The revision number to get changes after.
   * @returns Array of synthesized changes (0 or 1 elements).
   */
  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    const ops = await this.store.listOps(docId, { sinceRev: rev });
    if (ops.length === 0) {
      return [];
    }

    // Sort in commit order so catch-up clients apply ops in the same order live clients did
    const sortedOps = sortOpsByCommitOrder(ops);
    const maxRev = Math.max(...ops.map(op => op.rev ?? 0));
    // Use max timestamp from ops as committedAt (these are already-committed changes)
    const maxTs = Math.max(...ops.map(op => op.ts ?? 0));

    return [createChange(rev, maxRev, sortedOps, { committedAt: maxTs || Date.now() })];
  }

  /**
   * Commit changes to a document using LWW conflict resolution.
   *
   * Uses the consolidateOps algorithm to:
   * 1. Handle parent hierarchy validation (returns correction ops)
   * 2. Consolidate incoming ops with existing ops using LWW rules
   * 3. Convert delta ops (@inc, @bit, etc.) to concrete replace ops
   *
   * @param docId - The document ID.
   * @param changes - The changes to commit (always 1 for LWW).
   * @param options - Optional commit options (ignored for LWW).
   * @returns An object with the committed changes (0-1 elements).
   */
  async commitChanges(
    docId: string,
    changes: ChangeInput[],
    options?: CommitChangesOptions
  ): Promise<{ changes: Change[]; docReloadRequired?: true }> {
    const clientId = getClientId();

    if (changes.length === 0) {
      return { changes: [] };
    }

    // Serialize per doc: this is a read-modify-write (listOps → consolidate → saveOps), so
    // concurrent commits reading the same base would lose @inc increments and let older-ts
    // writes overwrite newer ones. The emit stays inside the lock so broadcasts keep commit
    // order — listeners must not call back into same-doc server methods.
    return this._withDocLock(docId, async () => {
      // A batch normally carries 1 change for LWW, but flush-time batching can split an oversized
      // change into several — process every change's ops, not just the first
      const change = changes[0];
      const serverNow = Date.now();
      // Catchup floor: the last rev the client actually has (baseRev). Clients mint
      // rev = baseRev + 1 optimistically, so using change.rev would permanently skip ops
      // another client committed at exactly baseRev + 1.
      const clientRev = change.baseRev ?? (change.rev !== undefined ? Math.max(0, change.rev - 1) : undefined);

      // Retry dedup: LWW compacts ops per path and keeps no change log, so a client retrying
      // an unacked commit would re-apply delta ops (@inc/@bit/@max/@min) and double-count.
      // Backends that record change ids (see LWWStoreBackend.seenChangeIds) let us drop
      // already-committed changes here; without the capability retries re-apply as before.
      const seen = this.store.seenChangeIds
        ? new Set(
            await this.store.seenChangeIds(
              docId,
              changes.map(c => c.id)
            )
          )
        : undefined;
      const freshChanges = seen?.size ? changes.filter(c => !seen.has(c.id)) : changes;
      const dedupedPaths = new Set(
        seen?.size ? changes.filter(c => seen.has(c.id)).flatMap(c => c.ops.map(o => o.path)) : []
      );

      // Stamp and clamp timestamps: ops without ts get the change's createdAt (else server
      // time), and no client-supplied ts may exceed server time — a fast-clocked client would
      // otherwise wedge fields against all other writers.
      const newOps = freshChanges.flatMap(c =>
        c.ops.map(op => ({ ...op, ts: Math.min(op.ts ?? c.createdAt ?? serverNow, serverNow) }))
      );

      // Load all existing ops for this doc
      const existingOps = await this.store.listOps(docId);

      // Use the consolidateOps algorithm
      const { opsToSave, pathsToDelete, opsToReturn } = consolidateOps(existingOps, newOps);

      // Convert delta ops (@inc, @bit, etc.) to replace ops with concrete values
      const opsToStore = convertDeltaOps(opsToSave);

      // Get current rev before saving (efficient - doesn't reconstruct full state)
      const currentRev = await this.store.getCurrentRev(docId);
      let newRev = currentRev;

      // Save ops and delete paths atomically. Change ids ride in the same call — persisting
      // them separately could ack the ops and lose the ids, re-enabling double-applied retries.
      if (opsToStore.length > 0 || pathsToDelete.length > 0) {
        const changeIds = this.store.seenChangeIds
          ? { ids: freshChanges.map(c => c.id), expireAt: serverNow + this._changeIdTTL }
          : undefined;
        newRev = await this.store.saveOps(docId, opsToStore, pathsToDelete, changeIds);
        // Stamp the committed rev ourselves: the response/broadcast blocks below (and their
        // commit-order sorting) read op.rev from these objects. The memory backend HAPPENED to
        // mutate the caller's ops when storing them, which masked this — a contract-compliant
        // copying backend (any SQL/HTTP store) leaves them rev-less and the response echo
        // breaks (DAB-601). Backends stamp their own stored rows; we stamp our own copies.
        for (const op of opsToStore) op.rev = newRev;
      }

      // Build the response: corrections, the stored resolution of every sent path, and catchup.
      //
      // For every path the client sent — and every stored descendant of those paths — the
      // response must echo the SERVER's post-commit rows, not assume the client's own copy
      // suffices. The client confirms its sent ops optimistically (confirmSent installs them
      // as committed and prunes committed child entries); whenever the server's resolution
      // differs, only these rev-stamped echoes can correct it:
      // - a sent delta op (@inc/@bit/@max/@min) folded into whatever the server had —
      //   possibly a concurrent write the sender never saw;
      // - a sent op that LOST by LWW timestamp (the winner also lands in opsToReturn);
      // - a sent parent write that lost to a stored parent while newer child rows survive —
      //   the client's optimistic prune dropped those children, and without this echo no
      //   later catch-up redelivers them (their revs are already behind the client's).
      // Catchup (everything committed after the client's rev) is no longer filtered by sent
      // paths either: a sent path's row in that window is the resolution, not an echo.
      //
      // Deduped paths count as sent: a deduped change was committed by a prior attempt whose
      // ack was lost, so the retrying client still needs the stored resolution of those paths
      // (and their surviving children) to confirm its sending layer and converge.
      const sentPaths = new Set([...newOps.map(o => o.path), ...dedupedPaths]);
      // Post-commit op table, derived from the pre-save read (exact under the doc lock):
      // existing rows survive unless deleted or overwritten (same path or child) by this commit.
      const pathsToDeleteSet = new Set(pathsToDelete);
      const postOps = [
        ...existingOps.filter(
          op =>
            !pathsToDeleteSet.has(op.path) &&
            !opsToStore.some(s => op.path === s.path || op.path.startsWith(s.path + '/'))
        ),
        ...opsToStore,
      ];
      const responseOpsByPath = new Map<string, JSONPatchOp>();
      for (const op of opsToReturn) responseOpsByPath.set(op.path, op);
      for (const op of postOps) {
        if (isPathOrChild(op.path, sentPaths) || (clientRev !== undefined && (op.rev ?? 0) > clientRev)) {
          responseOpsByPath.set(op.path, op);
        }
      }
      // Commit order end to end: the client's open doc applies response ops in array order,
      // so an older parent row must precede the newer child rows that survive it.
      const responseOps = sortOpsByCommitOrder(Array.from(responseOpsByPath.values()));

      // Build response using createChange
      const responseChange = createChange(clientRev ?? 0, newRev, responseOps, {
        id: change.id,
        committedAt: serverNow,
      });

      // Emit notification for committed changes (if any updates were made)
      if (opsToStore.length > 0) {
        try {
          const broadcastChange = createChange(currentRev, newRev, opsToStore, {
            id: change.id,
            committedAt: serverNow,
          });
          await this.onChangesCommitted.emit(docId, [broadcastChange], options, clientId);
        } catch (error) {
          console.error(`Failed to notify clients about committed changes for doc ${docId}:`, error);
        }
      }

      return { changes: [responseChange] };
    });
  }

  /**
   * Delete a document and emit deletion signal.
   * Creates a tombstone if the store supports it.
   *
   * @param docId - The document ID.
   * @param options - Optional deletion options.
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
    return removeTombstoneIfExists(this.store, docId);
  }

  /**
   * Make a server-side change to a document.
   * Stateless — uses getCurrentRev instead of loading document state.
   * @param docId - The document ID.
   * @param mutator - A function that receives a JSONPatch and PathProxy to define the changes.
   * @param metadata - Optional metadata for the change.
   * @returns The created change, or null if no operations were generated.
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

    // Add timestamps to ops for LWW
    const serverNow = Date.now();
    const opsWithTs = patch.ops.map(op => ({ ...op, ts: serverNow }));

    // Provide rev like a client would; commitChanges handles conflicts
    const change = createChange(rev, rev + 1, opsWithTs, metadata);

    // No patch.apply(state) — bad ops become noops at apply time (resilient state building)
    await this.commitChanges(docId, [change]);
    return change;
  }

  /**
   * Captures the current state of a document as a new version.
   * Only works if store implements VersioningStoreBackend.
   * Saves version metadata via `store.createVersion`; building and persisting state
   * is the store's concern, inline or deferred (see `VersioningStoreBackend`).
   *
   * @param docId - The document ID.
   * @param metadata - Optional metadata for the version.
   * @returns The ID of the created version, or null if no document exists.
   */
  async captureCurrentVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string | null> {
    assertVersionMetadata(metadata);

    if (!this.isVersioningStore(this.store)) {
      throw new Error('LWW versioning requires a store that implements VersioningStoreBackend');
    }

    const rev = await this.store.getCurrentRev(docId);
    if (rev === 0) {
      return null; // No document to version
    }

    const now = Date.now();
    const versionMetadata = createVersionMetadata({
      origin: 'main',
      startedAt: now,
      endedAt: now,
      startRev: rev,
      endRev: rev,
      ...metadata,
    });

    await this.store.createVersion(docId, versionMetadata);

    return versionMetadata.id;
  }

  /**
   * Type guard to check if the store supports versioning.
   */
  private isVersioningStore(store: LWWStoreBackend): store is LWWStoreBackend & VersioningStoreBackend {
    return 'createVersion' in store;
  }

  /**
   * Run `fn` exclusively per `docId`: same-doc calls run one at a time, FIFO, each to
   * completion. Mirrors LWWAlgorithm's client-side lock — the store calls are individually
   * transactional but their composition (read → consolidate → write) is not.
   */
  private _withDocLock<R>(docId: string, fn: () => Promise<R>): Promise<R> {
    const prior = this._docLocks.get(docId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.catch(() => undefined);
    this._docLocks.set(docId, tail);
    void tail.then(() => {
      if (this._docLocks.get(docId) === tail) this._docLocks.delete(docId);
    });
    return run;
  }
}

// === Helper Functions ===

/**
 * Sort ops in commit (rev) order, ts as tiebreak. Live clients apply broadcasts in commit
 * order, so this is the only ordering that keeps catch-up replicas consistent with them —
 * a ts sort disagrees whenever a writer's clock ran behind (parent/child ops on one field).
 */
function sortOpsByCommitOrder(ops: JSONPatchOp[]): JSONPatchOp[] {
  return [...ops].sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0) || (a.ts ?? 0) - (b.ts ?? 0));
}

/**
 * Check if a path equals or is a child of any sent path.
 */
function isPathOrChild(path: string, sentPaths: Set<string>): boolean {
  for (const sent of sentPaths) {
    if (path === sent || path.startsWith(sent + '/')) {
      return true;
    }
  }
  return false;
}

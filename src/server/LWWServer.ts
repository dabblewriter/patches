import { createVersionMetadata } from '../data/version.js';
import { consolidateOps, convertDeltaOps } from '../algorithms/lww/consolidateOps.js';
import { createChange } from '../data/change.js';
import { signal } from '../event-signal.js';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import { JSONPatch } from '../json-patch/JSONPatch.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import { getClientId } from '../net/serverContext.js';
import type {
  Change,
  ChangeInput,
  ChangeMutator,
  CommitChangesOptions,
  DeleteDocOptions,
  EditableVersionMetadata,
  PatchesState,
} from '../types.js';
import type { PatchesServer } from './PatchesServer.js';
import { createTombstoneIfSupported, removeTombstoneIfExists } from './tombstone.js';
import type { LWWStoreBackend, VersioningStoreBackend } from './types.js';
import { assertVersionMetadata } from './utils.js';

/**
 * Configuration options for LWWServer.
 */
export interface LWWServerOptions {
  /**
   * Number of revisions between automatic snapshots.
   * Defaults to 200.
   */
  snapshotInterval?: number;
}

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
    commitChanges: 'write',
    deleteDoc: 'write',
    undeleteDoc: 'write',
  } as const;

  readonly store: LWWStoreBackend;
  private readonly snapshotInterval: number;

  /** Notifies listeners whenever a batch of changes is successfully committed. */
  public readonly onChangesCommitted =
    signal<(docId: string, changes: Change[], options?: CommitChangesOptions, originClientId?: string) => void>();

  /** Notifies listeners when a document is deleted. */
  public readonly onDocDeleted = signal<(docId: string, options?: DeleteDocOptions, originClientId?: string) => void>();

  constructor(store: LWWStoreBackend, options: LWWServerOptions = {}) {
    this.store = store;
    this.snapshotInterval = options.snapshotInterval ?? 200;
  }

  /**
   * Get the current state of a document.
   * Reconstructs state from snapshot + ops changed since snapshot.
   *
   * @param docId - The document ID.
   * @returns The document state and revision, or `{ state: {}, rev: 0 }` if not found.
   */
  async getDoc(docId: string): Promise<PatchesState> {
    const snapshot = await this.store.getSnapshot(docId);
    const baseState = snapshot?.state ?? {};
    const baseRev = snapshot?.rev ?? 0;

    const ops = await this.store.listOps(docId, { sinceRev: baseRev });
    if (ops.length === 0) {
      return { state: baseState, rev: baseRev };
    }

    // Apply ops to reconstruct current state
    const state = new JSONPatch(ops).apply(baseState);
    const rev = Math.max(baseRev, ...ops.map(op => op.rev ?? 0));
    return { state, rev };
  }

  /**
   * Get changes that occurred after a specific revision.
   * LWW doesn't store changes, so this synthesizes a change from ops.
   *
   * @param docId - The document ID.
   * @param rev - The revision number to get changes after.
   * @returns Array containing 0 or 1 synthesized changes.
   */
  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    const ops = await this.store.listOps(docId, { sinceRev: rev });
    if (ops.length === 0) {
      return [];
    }

    // Sort by ts so older ops apply first
    const sortedOps = [...ops].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
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
   * @returns Array containing 0-1 changes with catchup ops and new rev.
   */
  async commitChanges(docId: string, changes: ChangeInput[], options?: CommitChangesOptions): Promise<Change[]> {
    if (changes.length === 0) {
      return [];
    }

    const change = changes[0]; // LWW always receives 1 change
    const serverNow = Date.now();
    const clientRev = change.rev; // Client's last known rev (for catchup)

    // Add timestamps to ops that don't have them
    // Prefer change.createdAt if available, fallback to server time
    const newOps = change.ops.map(op => (op.ts ? op : { ...op, ts: change.createdAt ?? serverNow }));

    // Load all existing ops for this doc
    const existingOps = await this.store.listOps(docId);

    // Use the consolidateOps algorithm
    const { opsToSave, pathsToDelete, opsToReturn } = consolidateOps(existingOps, newOps);

    // Convert delta ops (@inc, @bit, etc.) to replace ops with concrete values
    const opsToStore = convertDeltaOps(opsToSave);

    // Get current rev before saving (efficient - doesn't reconstruct full state)
    const currentRev = await this.store.getCurrentRev(docId);
    let newRev = currentRev;

    // Save ops and delete paths atomically
    if (opsToStore.length > 0 || pathsToDelete.length > 0) {
      newRev = await this.store.saveOps(docId, opsToStore, pathsToDelete);
    }

    // Compact if needed (save snapshot every N revisions)
    if (newRev > 0 && newRev % this.snapshotInterval === 0) {
      const { state } = await this.getDoc(docId);
      await this.store.saveSnapshot(docId, state, newRev);
    }

    // Build catchup ops - start with correction ops from opsToReturn
    const responseOps = [...opsToReturn];
    if (clientRev !== undefined) {
      const opsSince = await this.store.listOps(docId, { sinceRev: clientRev });
      const sentPaths = new Set(change.ops.map(o => o.path));

      // Filter out ops client just sent (and their children), sort by ts
      const catchupOps = opsSince
        .filter(op => !isPathOrChild(op.path, sentPaths))
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      responseOps.push(...catchupOps);
    }

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
        await this.onChangesCommitted.emit(docId, [broadcastChange], options, getClientId());
      } catch (error) {
        console.error(`Failed to notify clients about committed changes for doc ${docId}:`, error);
      }
    }

    return [responseChange];
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
    const rev = await this.store.getCurrentRev(docId);
    await createTombstoneIfSupported(this.store, docId, rev, clientId, options?.skipTombstone);
    await this.store.deleteDoc(docId);
    await this.onDocDeleted.emit(docId, options, clientId);
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
    const { state, rev } = await this.getDoc(docId);
    const patch = createJSONPatch<T>(mutator);
    if (patch.ops.length === 0) {
      return null;
    }

    // Add timestamps to ops for LWW
    const serverNow = Date.now();
    const opsWithTs = patch.ops.map(op => ({ ...op, ts: serverNow }));

    // Provide rev like a client would; commitChanges handles conflicts
    const change = createChange(rev, rev + 1, opsWithTs, metadata);

    // Apply to local state to ensure no errors are thrown
    patch.apply(state);

    await this.commitChanges(docId, [change]);
    return change;
  }

  /**
   * Captures the current state of a document as a new version.
   * Only works if store implements VersioningStoreBackend.
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

    const { state, rev } = await this.getDoc(docId);
    if (rev === 0) {
      return null; // No document to version
    }

    const versionMetadata = createVersionMetadata({
      origin: 'main',
      startedAt: Date.now(),
      endedAt: Date.now(),
      startRev: rev,
      endRev: rev,
      ...metadata,
    });

    await this.store.createVersion(docId, versionMetadata, state);
    return versionMetadata.id;
  }

  /**
   * Type guard to check if the store supports versioning.
   */
  private isVersioningStore(store: LWWStoreBackend): store is LWWStoreBackend & VersioningStoreBackend {
    return 'createVersion' in store;
  }
}

// === Helper Functions ===

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

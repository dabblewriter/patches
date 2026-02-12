import { Delta } from '@dabble/delta';
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
import type { LWWStoreBackend, TextDeltaStoreBackend, VersioningStoreBackend } from './types.js';
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
 * Last-Write-Wins (LWW) server implementation with rich text support.
 *
 * LWWServer stores fields with timestamps. Conflicts are resolved by comparing
 * timestamps — the later timestamp wins. Rich text fields (`@txt` operations)
 * are additionally supported via Delta-based OT: concurrent text edits are
 * transformed and merged character-by-character rather than using timestamp
 * comparison.
 *
 * ## Rich Text Support
 *
 * To enable collaborative rich text editing, the store must implement
 * `TextDeltaStoreBackend` in addition to `LWWStoreBackend`. When enabled:
 *
 * - `@txt` ops are transformed against concurrent edits using Delta OT
 * - The field store always contains the current composed text (for state reconstruction)
 * - A separate delta log stores individual deltas (for transforms and client catchup)
 * - Deltas are pruned automatically after snapshots and when text fields are deleted
 *
 * If the store does not implement `TextDeltaStoreBackend`, `@txt` ops are treated
 * like regular `replace` operations (last timestamp wins, no character-level merge).
 *
 * @example
 * ```typescript
 * import { LWWServer } from '@dabble/patches/server';
 *
 * const store = new MyLWWStoreBackend(); // optionally implements TextDeltaStoreBackend
 * const server = new LWWServer(store);
 *
 * // Commit changes with timestamps
 * const changes = await server.commitChanges('doc1', [{
 *   id: 'change1',
 *   ops: [{ op: 'replace', path: '/name', value: 'Alice', ts: Date.now() }],
 * }]);
 *
 * // Rich text changes (requires TextDeltaStoreBackend)
 * const textChanges = await server.commitChanges('doc1', [{
 *   id: 'change2',
 *   ops: [{ op: '@txt', path: '/body', value: [{ retain: 5 }, { insert: ' World' }], ts: Date.now() }],
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
   * For text fields (when TextDeltaStoreBackend is available), returns composed
   * deltas from the delta log instead of the full text value from the field store.
   * This allows clients to transform the deltas against their local pending state.
   *
   * @param docId - The document ID.
   * @param rev - The revision number to get changes after.
   * @returns Array containing 0 or 1 synthesized changes.
   */
  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    const fieldOps = await this.store.listOps(docId, { sinceRev: rev });
    const textDeltaStore = this.getTextDeltaStore();

    // Get text deltas since rev (if text delta store is available)
    let textCatchupOps: { op: string; path: string; value: any }[] = [];
    const textPaths = new Set<string>();

    if (textDeltaStore) {
      const allTextDeltas = await textDeltaStore.getAllTextDeltasSince(docId, rev);
      textCatchupOps = composeTextDeltasByPath(allTextDeltas);
      for (const op of textCatchupOps) {
        textPaths.add(op.path);
      }
    }

    // Filter out text paths from field ops (they're covered by text deltas)
    const nonTextOps = fieldOps.filter(op => !textPaths.has(op.path));

    const allOps = [...nonTextOps, ...textCatchupOps];
    if (allOps.length === 0) {
      return [];
    }

    // Sort non-text ops by ts so older ops apply first (text ops are already composed)
    const sortedOps = [...nonTextOps].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    sortedOps.push(...textCatchupOps);

    const maxRev = Math.max(
      ...fieldOps.map(op => op.rev ?? 0),
      ...textCatchupOps.map(() => 0), // text ops don't carry rev individually
      0
    );
    const actualMaxRev = textDeltaStore
      ? Math.max(maxRev, ...(await textDeltaStore.getAllTextDeltasSince(docId, rev)).map(d => d.rev))
      : maxRev;
    const maxTs = Math.max(...fieldOps.map(op => op.ts ?? 0), 0);

    return [createChange(rev, actualMaxRev || rev, sortedOps, { committedAt: maxTs || Date.now() })];
  }

  /**
   * Commit changes to a document using LWW conflict resolution with rich text support.
   *
   * Non-text ops use the consolidateOps algorithm for LWW conflict resolution.
   * `@txt` ops (when TextDeltaStoreBackend is available) use revision-based Delta OT:
   * incoming text deltas are transformed against concurrent server deltas, then composed
   * with the current text to produce the new field value.
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
    const baseRev = change.baseRev ?? clientRev ?? 0;
    const textDeltaStore = this.getTextDeltaStore();

    // Add timestamps to ops that don't have them
    // Prefer change.createdAt if available, fallback to server time
    const newOps = change.ops.map(op => (op.ts ? op : { ...op, ts: change.createdAt ?? serverNow }));

    // Separate @txt ops from non-text ops when text delta store is available.
    // @txt ops use revision-based OT (transform against concurrent deltas),
    // while all other ops use timestamp-based LWW conflict resolution.
    const textOps = textDeltaStore ? newOps.filter(op => op.op === '@txt') : [];
    const nonTextOps = textDeltaStore ? newOps.filter(op => op.op !== '@txt') : newOps;

    // Load all existing ops for this doc
    const existingOps = await this.store.listOps(docId);

    // Process non-text ops through standard LWW consolidation
    const { opsToSave, pathsToDelete, opsToReturn } = consolidateOps(existingOps, nonTextOps);

    // Convert delta ops (@inc, @bit, etc.) to replace ops with concrete values
    const opsToStore = convertDeltaOps(opsToSave);

    // Process @txt ops: transform against concurrent server deltas, compose with current text
    const textOpsToStore: { op: string; path: string; value: any; ts?: number }[] = [];
    const transformedTextDeltas: { path: string; delta: any[] }[] = [];

    for (const textOp of textOps) {
      // Get recent text deltas for this path since the client's base revision
      const recentDeltas = await textDeltaStore!.getTextDeltasSince(docId, textOp.path, baseRev);

      // Transform the incoming delta against all concurrent server deltas
      let incomingDelta = new Delta(textOp.value);
      for (const recent of recentDeltas) {
        const serverDelta = new Delta(recent.delta);
        incomingDelta = serverDelta.transform(incomingDelta, true);
      }

      // Get the current text content from the field store and compose
      const existingOp = existingOps.find(op => op.path === textOp.path);
      const currentText = existingOp?.value ? new Delta(existingOp.value) : new Delta().insert('\n');
      const newText = currentText.compose(incomingDelta);

      // Store the full composed text in the field store (as replace for state reconstruction)
      textOpsToStore.push({
        op: 'replace',
        path: textOp.path,
        value: newText,
        ts: textOp.ts,
      });

      // Track the transformed delta for the delta log and broadcast
      transformedTextDeltas.push({ path: textOp.path, delta: incomingDelta.ops });
    }

    // Collect all paths being deleted or overwritten (for text delta cleanup)
    const allPathsToDelete = [...pathsToDelete];
    // If a non-text op overwrites a text field path, include it for delta cleanup
    for (const op of opsToStore) {
      if (textDeltaStore && op.op === 'replace') {
        // Check if this path or any parent overwrites a text field
        for (const existing of existingOps) {
          if (existing.path === op.path || existing.path.startsWith(op.path + '/')) {
            // Check if it was a text field being overwritten by non-text
            if (!textOps.some(t => t.path === existing.path)) {
              allPathsToDelete.push(existing.path);
            }
          }
        }
      }
    }

    // Combine all ops to store
    const allOpsToStore = [...opsToStore, ...textOpsToStore];

    // Get current rev before saving
    const currentRev = await this.store.getCurrentRev(docId);
    let newRev = currentRev;

    // Save ops and delete paths atomically
    if (allOpsToStore.length > 0 || pathsToDelete.length > 0) {
      newRev = await this.store.saveOps(docId, allOpsToStore, pathsToDelete);
    }

    // Save text deltas to the delta log (for future transforms and catchup)
    if (textDeltaStore) {
      for (const { path, delta } of transformedTextDeltas) {
        await textDeltaStore.appendTextDelta(docId, path, delta, newRev);
      }

      // Clean up text deltas for deleted/overwritten paths
      const textPathsToClean = allPathsToDelete.filter(p => !transformedTextDeltas.some(t => t.path === p));
      if (textPathsToClean.length > 0) {
        await textDeltaStore.pruneTextDeltas(docId, newRev, textPathsToClean);
      }
    }

    // Compact if needed (save snapshot every N revisions)
    if (newRev > 0 && newRev % this.snapshotInterval === 0) {
      const { state } = await this.getDoc(docId);
      await this.store.saveSnapshot(docId, state, newRev);
      // Prune text deltas up to snapshot rev
      if (textDeltaStore) {
        await textDeltaStore.pruneTextDeltas(docId, newRev);
      }
    }

    // Build catchup ops - start with correction ops from opsToReturn
    const responseOps = [...opsToReturn];
    if (clientRev !== undefined) {
      const opsSince = await this.store.listOps(docId, { sinceRev: clientRev });
      const sentPaths = new Set(change.ops.map(o => o.path));

      // Non-text catchup: field values the client hasn't seen, excluding sent paths and text paths
      const textSentPaths = new Set(textOps.map(o => o.path));
      const catchupOps = opsSince
        .filter(op => !isPathOrChild(op.path, sentPaths) && !textSentPaths.has(op.path))
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      responseOps.push(...catchupOps);

      // Text catchup: composed deltas for text fields the client missed (excluding paths they sent)
      if (textDeltaStore) {
        const allTextDeltas = await textDeltaStore.getAllTextDeltasSince(docId, clientRev);
        const textCatchup = composeTextDeltasByPath(allTextDeltas, textSentPaths);
        responseOps.push(...textCatchup);
      }
    }

    // Build response using createChange
    const responseChange = createChange(clientRev ?? 0, newRev, responseOps, {
      id: change.id,
      committedAt: serverNow,
    });

    // Emit notification for committed changes (if any updates were made)
    const broadcastOps = [
      ...opsToStore,
      ...transformedTextDeltas.map(({ path, delta }) => ({
        op: '@txt' as const,
        path,
        value: delta,
      })),
    ];
    if (broadcastOps.length > 0) {
      try {
        const broadcastChange = createChange(currentRev, newRev, broadcastOps, {
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

  /**
   * Returns the TextDeltaStoreBackend if the store implements it, or null.
   * Cached after first check for performance.
   */
  private _textDeltaStore: TextDeltaStoreBackend | null | undefined;
  private getTextDeltaStore(): TextDeltaStoreBackend | null {
    if (this._textDeltaStore === undefined) {
      this._textDeltaStore = isTextDeltaStore(this.store) ? this.store : null;
    }
    return this._textDeltaStore;
  }
}

// === Helper Functions ===

/**
 * Type guard to check if a store implements TextDeltaStoreBackend.
 */
function isTextDeltaStore(store: LWWStoreBackend): store is LWWStoreBackend & TextDeltaStoreBackend {
  return 'appendTextDelta' in store && 'getTextDeltasSince' in store;
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

/**
 * Composes text deltas by path into `@txt` ops for client catchup.
 * Groups deltas by path and composes all deltas for each path into a single delta.
 * Optionally excludes specific paths (e.g., paths the client just sent).
 */
function composeTextDeltasByPath(
  deltas: { path: string; delta: any[]; rev: number }[],
  excludePaths?: Set<string>
): { op: string; path: string; value: any }[] {
  const byPath = new Map<string, Delta>();

  for (const { path, delta } of deltas) {
    if (excludePaths?.has(path)) continue;
    const existing = byPath.get(path);
    if (existing) {
      byPath.set(path, existing.compose(new Delta(delta)));
    } else {
      byPath.set(path, new Delta(delta));
    }
  }

  return Array.from(byPath.entries()).map(([path, delta]) => ({
    op: '@txt',
    path,
    value: delta.ops,
  }));
}

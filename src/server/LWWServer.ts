import { createId } from 'crypto-id';
import { signal } from '../event-signal.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import { getClientId } from '../net/serverContext.js';
import type {
  Change,
  ChangeInput,
  CommitChangesOptions,
  DeleteDocOptions,
  EditableVersionMetadata,
  PatchesState,
} from '../types.js';
import type { PatchesServer } from './PatchesServer.js';
import type { FieldMeta, LWWStoreBackend, LWWVersioningStoreBackend } from './types.js';
import { createTombstoneIfSupported, removeTombstoneIfExists } from './tombstone.js';
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

const SPECIAL_OPS = new Set(['@inc', '@bit', '@max', '@min']);

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
  public readonly onChangesCommitted = signal<(docId: string, changes: Change[], originClientId?: string) => void>();

  /** Notifies listeners when a document is deleted. */
  public readonly onDocDeleted = signal<(docId: string, options?: DeleteDocOptions, originClientId?: string) => void>();

  constructor(store: LWWStoreBackend, options: LWWServerOptions = {}) {
    this.store = store;
    this.snapshotInterval = options.snapshotInterval ?? 200;
  }

  /**
   * Get the current state of a document.
   * Reconstructs state from snapshot + fields changed since snapshot.
   *
   * @param docId - The document ID.
   * @returns The document state and revision, or `{ state: {}, rev: 0 }` if not found.
   */
  async getDoc(docId: string): Promise<PatchesState> {
    const snapshot = await this.store.getSnapshot(docId);
    const baseState = snapshot?.state ?? {};
    const baseRev = snapshot?.rev ?? 0;

    const fields = await this.store.listFields(docId, { sinceRev: baseRev });
    if (fields.length === 0) {
      return { state: baseState, rev: baseRev };
    }

    // Apply fields to reconstruct current state
    const state = applyFields(baseState, fields);
    const rev = Math.max(baseRev, ...fields.map((f: FieldMeta) => f.rev));
    return { state, rev };
  }

  /**
   * Get changes that occurred after a specific revision.
   * LWW doesn't store changes, so this synthesizes a change from fields.
   *
   * @param docId - The document ID.
   * @param rev - The revision number to get changes after.
   * @returns Array containing 0 or 1 synthesized changes.
   */
  async getChangesSince(docId: string, rev: number): Promise<Change[]> {
    const fields = await this.store.listFields(docId, { sinceRev: rev });
    if (fields.length === 0) {
      return [];
    }

    // Sort by ts so older ops apply first
    const sortedFields = [...fields].sort((a: FieldMeta, b: FieldMeta) => a.ts - b.ts);
    const ops = sortedFields.map((f: FieldMeta) => fieldToOp(f));
    const maxRev = Math.max(...fields.map((f: FieldMeta) => f.rev));

    // Synthesize a change from fields
    return [
      {
        id: createId(8),
        ops,
        rev: maxRev,
        baseRev: rev,
        createdAt: Date.now(),
        committedAt: Date.now(),
      },
    ];
  }

  /**
   * Commit changes to a document using LWW conflict resolution.
   *
   * For each operation:
   * 1. Check parent hierarchy (skip if parent is primitive)
   * 2. Compare incoming timestamp with existing field timestamp
   * 3. If incoming wins (ts >= existing.ts), update the field
   * 4. Build catchup ops for fields changed since client's rev
   *
   * @param docId - The document ID.
   * @param changes - The changes to commit (always 1 for LWW).
   * @param _options - Optional commit options (ignored for LWW).
   * @returns Array containing 0-1 changes with catchup ops and new rev.
   */
  async commitChanges(docId: string, changes: ChangeInput[], _options?: CommitChangesOptions): Promise<Change[]> {
    if (changes.length === 0) {
      return [];
    }

    const change = changes[0]; // LWW always receives 1 change
    const ops = change.ops;
    const serverNow = Date.now();
    const clientRev = change.rev; // Client's last known rev (for catchup)

    // Collect all paths we need: op paths + all parent paths
    const pathsToLoad = collectPathsWithParents(ops);

    // Load existing fields as a Map for efficient lookup
    const existingFieldsList = await this.store.listFields(docId, { paths: [...pathsToLoad] });
    const existingFields = new Map(existingFieldsList.map((f: FieldMeta) => [f.path, f]));

    // Process each op at field level
    const updates: FieldMeta[] = [];
    const correctionPaths = new Set<string>();

    for (const op of ops) {
      const incomingTs = op.ts ?? serverNow;

      // Check if parent is primitive (invalid hierarchy)
      const primitiveParent = findPrimitiveParent(op.path, existingFields);
      if (primitiveParent) {
        correctionPaths.add(primitiveParent);
        continue; // Skip this op, will send correction
      }

      const existing = existingFields.get(op.path);

      // Determine if this op should be applied
      let shouldApply = false;
      let newValue: any;

      if (SPECIAL_OPS.has(op.op)) {
        // Special ops have custom handling
        const result = computeSpecialOpValue(op, existing);
        shouldApply = result.apply;
        newValue = result.value;
      } else if (!existing || incomingTs >= existing.ts) {
        // LWW: incoming wins if ts >= existing.ts
        shouldApply = true;
        newValue = op.op === 'remove' ? undefined : op.value;
      }

      if (shouldApply) {
        updates.push({
          path: op.path,
          ts: incomingTs,
          rev: 0, // Will be set by saveFields
          value: newValue,
        });
      }
    }

    // Get current rev for catchup comparison (derive from snapshot + fields)
    const { rev: currentRev } = await this.getDoc(docId);
    let newRev = currentRev;

    // Save updates if any (saveFields atomically increments and returns new rev)
    if (updates.length > 0) {
      newRev = await this.store.saveFields(docId, updates);
    }

    // Compact if needed (save snapshot every N revisions)
    if (newRev > 0 && newRev % this.snapshotInterval === 0) {
      const { state } = await this.getDoc(docId);
      await this.store.saveSnapshot(docId, state, newRev);
    }

    // Build catchup ops if client sent rev
    let responseOps: JSONPatchOp[] = [];
    if (clientRev !== undefined) {
      const fieldsSince = await this.store.listFields(docId, { sinceRev: clientRev });
      const sentPaths = new Set(ops.map(o => o.path));

      // Filter out fields client just sent (and their children)
      // Sort by ts so older ops apply first
      responseOps = fieldsSince
        .filter((f: FieldMeta) => !isPathOrChild(f.path, sentPaths))
        .sort((a: FieldMeta, b: FieldMeta) => a.ts - b.ts)
        .map((f: FieldMeta) => fieldToOp(f));
    }

    // Add self-healing corrections for invalid hierarchy
    for (const path of correctionPaths) {
      const field = existingFields.get(path);
      if (field) {
        responseOps.push(fieldToOp(field));
      }
    }

    // Build response change
    const responseChange: Change = {
      id: change.id,
      ops: responseOps,
      rev: newRev,
      baseRev: clientRev ?? 0,
      createdAt: Date.now(),
      committedAt: Date.now(),
    };

    // Emit notification for committed changes (if any updates were made)
    if (updates.length > 0) {
      try {
        // Build a change with the updates for broadcasting
        const broadcastChange: Change = {
          id: change.id,
          ops: updates.map((f: FieldMeta) => fieldToOp(f)),
          rev: newRev,
          baseRev: currentRev,
          createdAt: Date.now(),
          committedAt: Date.now(),
        };
        await this.onChangesCommitted.emit(docId, [broadcastChange], getClientId());
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
    const { rev } = await this.getDoc(docId);
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
   * Captures the current state of a document as a new version.
   * Only works if store implements LWWVersioningStoreBackend.
   *
   * @param docId - The document ID.
   * @param metadata - Optional metadata for the version.
   * @returns The ID of the created version, or null if no document exists.
   */
  async captureCurrentVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string | null> {
    assertVersionMetadata(metadata);

    if (!this.isVersioningStore(this.store)) {
      throw new Error('LWW versioning requires a store that implements LWWVersioningStoreBackend');
    }

    const { state, rev } = await this.getDoc(docId);
    if (rev === 0) {
      return null; // No document to version
    }

    const versionId = createId(8);
    await this.store.createVersion(docId, versionId, state, rev, metadata);
    return versionId;
  }

  /**
   * Type guard to check if the store supports versioning.
   */
  private isVersioningStore(store: LWWStoreBackend): store is LWWVersioningStoreBackend {
    return 'createVersion' in store;
  }
}

// === Helper Functions ===

/**
 * Collect all paths from ops plus all their parent paths.
 * For example, /a/b/c -> [/a/b/c, /a/b, /a]
 */
function collectPathsWithParents(ops: JSONPatchOp[]): Set<string> {
  const paths = new Set<string>();
  for (const op of ops) {
    paths.add(op.path);
    // Add parent paths
    let parent = op.path;
    while (parent.lastIndexOf('/') > 0) {
      parent = parent.substring(0, parent.lastIndexOf('/'));
      paths.add(parent);
    }
  }
  return paths;
}

/**
 * Find if any parent of this path is a primitive value.
 * Returns the path of the primitive parent, or null if hierarchy is valid.
 */
function findPrimitiveParent(path: string, fields: Map<string, FieldMeta>): string | null {
  let parent = path;
  while (parent.lastIndexOf('/') > 0) {
    parent = parent.substring(0, parent.lastIndexOf('/'));
    const field = fields.get(parent);
    if (field && field.value !== undefined && !isObject(field.value)) {
      return parent;
    }
  }
  return null;
}

/**
 * Check if a value is an object (or array).
 */
function isObject(value: any): boolean {
  return value !== null && typeof value === 'object';
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
 * Convert a FieldMeta to a JSON Patch op.
 */
function fieldToOp(field: FieldMeta): JSONPatchOp {
  if (field.value === undefined) {
    return { op: 'remove', path: field.path };
  }
  return { op: 'replace', path: field.path, value: field.value, ts: field.ts };
}

/**
 * Apply fields to a base state to reconstruct current state.
 */
function applyFields(baseState: any, fields: FieldMeta[]): any {
  // Sort by ts so older values are applied first
  const sorted = [...fields].sort((a, b) => a.ts - b.ts);

  let state = baseState;
  for (const field of sorted) {
    state = setPath(state, field.path, field.value);
  }
  return state;
}

/**
 * Set a value at a path in an object, returning a new object.
 */
function setPath(obj: any, path: string, value: any): any {
  if (!path || path === '/') {
    return value;
  }

  const keys = path.split('/').filter(Boolean);
  const result = Array.isArray(obj) ? [...obj] : { ...obj };
  let current: any = result;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null) {
      // Create intermediate object
      current[key] = {};
    } else if (typeof current[key] === 'object') {
      // Clone the intermediate object
      current[key] = Array.isArray(current[key]) ? [...current[key]] : { ...current[key] };
    }
    current = current[key];
  }

  const lastKey = keys[keys.length - 1];
  if (value === undefined) {
    delete current[lastKey];
  } else {
    current[lastKey] = value;
  }

  return result;
}

/**
 * Compute the result of a special operation (@inc, @bit, @max, @min).
 */
function computeSpecialOpValue(op: JSONPatchOp, existing: FieldMeta | undefined): { apply: boolean; value: any } {
  const existingValue = existing?.value ?? 0;

  switch (op.op) {
    case '@inc':
      // Increment: always applies (additive)
      return { apply: true, value: (Number(existingValue) || 0) + (Number(op.value) || 0) };

    case '@bit':
      // Bitwise OR: always applies
      return { apply: true, value: (Number(existingValue) || 0) | (Number(op.value) || 0) };

    case '@max': {
      // Max: apply if incoming is greater
      const maxVal = Math.max(Number(existingValue) || 0, Number(op.value) || 0);
      return { apply: maxVal !== existingValue, value: maxVal };
    }

    case '@min': {
      // Min: apply if incoming is smaller
      const minVal = Math.min(
        existing === undefined ? Number(op.value) || 0 : Number(existingValue) || 0,
        Number(op.value) || 0
      );
      return { apply: minVal !== existingValue || existing === undefined, value: minVal };
    }

    default:
      return { apply: false, value: existingValue };
  }
}

import { commitChanges, type CommitChangesOptions } from '../algorithms/ot/server/commitChanges.js';
import { createVersion } from '../algorithms/ot/server/createVersion.js';
import { getSnapshotAtRevision, getSnapshotStream } from '../algorithms/ot/server/getSnapshotAtRevision.js';
import { createChange } from '../data/change.js';
import { signal } from 'easy-signal';
import { createJSONPatch } from '../json-patch/createJSONPatch.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import { getClientId } from '../net/serverContext.js';
import type { Change, ChangeInput, ChangeMutator, DeleteDocOptions, EditableVersionMetadata } from '../types.js';
import type { PatchesServer } from './PatchesServer.js';
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
    commitChanges: 'write',
    deleteDoc: 'write',
    undeleteDoc: 'write',
  } as const;

  private readonly sessionTimeoutMillis: number;
  readonly store: OTStoreBackend;

  /** Notifies listeners whenever a batch of changes is *successfully* committed. */
  public readonly onChangesCommitted =
    signal<(docId: string, changes: Change[], options?: CommitChangesOptions, originClientId?: string) => void>();

  /** Notifies listeners when a document is deleted. */
  public readonly onDocDeleted = signal<(docId: string, options?: DeleteDocOptions, originClientId?: string) => void>();

  constructor(store: OTStoreBackend, options: OTServerOptions = {}) {
    this.sessionTimeoutMillis = (options.sessionTimeoutMinutes ?? 30) * 60 * 1000;
    this.store = store;
  }

  /**
   * Get the current state of a document as a ReadableStream of JSON.
   * Streams `{"state":...,"rev":N,"changes":[...]}` with the version state
   * flowing through without parsing.
   * @param docId - The ID of the document.
   * @returns A ReadableStream of JSON string chunks.
   */
  async getDoc(docId: string): Promise<ReadableStream<string>> {
    return getSnapshotStream(this.store, docId);
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
    const { catchupChanges, newChanges, docReloadRequired } = await commitChanges(
      this.store,
      docId,
      changes,
      this.sessionTimeoutMillis,
      options
    );

    // Notify about newly committed changes (broadcast to other clients)
    if (newChanges.length > 0) {
      try {
        await this.onChangesCommitted.emit(docId, newChanges, options, getClientId());
      } catch (error) {
        console.error(`Failed to notify clients about committed changes for doc ${docId}:`, error);
      }
    }

    const result: { changes: Change[]; docReloadRequired?: true } = {
      changes: [...catchupChanges, ...newChanges],
    };
    if (docReloadRequired) result.docReloadRequired = true;
    return result;
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

  // === Version Operations ===

  /**
   * Captures the current state of a document as a new version.
   * Does NOT build state — creates version metadata + changes, then emits
   * `onVersionCreated` so subscribers can build and persist state out of band.
   *
   * @param docId The document ID.
   * @param metadata Optional metadata for the version.
   * @returns The ID of the created version, or null if no changes to capture.
   */
  async captureCurrentVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string | null> {
    assertVersionMetadata(metadata);
    const { changes } = await getSnapshotAtRevision(this.store, docId);
    const version = await createVersion(this.store, docId, changes, { metadata });
    if (!version) {
      return null;
    }
    return version.id;
  }
}

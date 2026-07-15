import { getStateBeforeVersionAsStream } from '../algorithms/ot/server/buildVersionState.js';
import type { SkippedChange } from '../algorithms/ot/shared/applyChanges.js';
import { isStatusError, StatusError } from '../net/error.js';
import type { ApiDefinition } from '../net/protocol/JSONRPCServer.js';
import type { Change, EditableVersionMetadata, ListVersionsOptions, VersionMetadata } from '../types.js';
import { jsonReadable } from './jsonReadable.js';
import type { PatchesServer } from './PatchesServer.js';
import type { OTStoreBackend, VersioningStoreBackend } from './types.js';
import { assertVersionMetadata, isMissingVersionState } from './utils.js';

/**
 * Options for {@link PatchesHistoryManager}.
 */
export interface PatchesHistoryManagerOptions {
  /**
   * Telemetry hook for committed changes skipped while reconstructing a
   * history-scrubbing baseline (`getStateBeforeVersion`). Called once per
   * skipped change with the docId and full skip context. Defaults to
   * `console.error` logging inside `applyChangesForReconstruction`.
   */
  onSkippedChange?: (docId: string, skipped: SkippedChange) => void;
}

/**
 * Helps retrieve historical information (versions, changes) for a document
 * using the versioning model based on IDs and metadata.
 *
 * Works with any PatchesServer that implements captureCurrentVersion
 * (both OTServer and LWWServer with VersioningStoreBackend).
 */
export class PatchesHistoryManager {
  static api: ApiDefinition = {
    listVersions: 'read',
    createVersion: 'write',
    updateVersion: 'write',
    getVersionState: 'read',
    getVersionChanges: 'read',
    getStateBeforeVersion: 'read',
  } as const;

  protected readonly store: VersioningStoreBackend;
  protected readonly options: PatchesHistoryManagerOptions;

  constructor(
    protected readonly patches: PatchesServer,
    store: VersioningStoreBackend,
    options: PatchesHistoryManagerOptions = {}
  ) {
    this.store = store;
    this.options = options;
  }

  /**
   * Lists version metadata for the document, supporting various filters.
   * @param docId - The ID of the document.
   * @param options Filtering and sorting options (e.g., limit, reverse, origin, groupId, date range).
   * @returns A list of version metadata objects.
   */
  async listVersions(docId: string, options: ListVersionsOptions = {}): Promise<VersionMetadata[]> {
    if (!options.orderBy) {
      options.orderBy = 'startedAt';
    }
    return await this.store.listVersions(docId, options);
  }

  /**
   * Create a new named version snapshot of a document's current state.
   * @param docId The document ID.
   * @param name The name of the version.
   * @returns The ID of the created version, or null if no changes to capture.
   */
  async createVersion(docId: string, metadata?: EditableVersionMetadata): Promise<string | null> {
    assertVersionMetadata(metadata);
    return await this.patches.captureCurrentVersion(docId, metadata);
  }

  /**
   * Updates the name of a specific version.
   * @param docId - The ID of the document.
   * @param versionId - The ID of the version to update.
   * @param name - The new name for the version.
   */
  async updateVersion(docId: string, versionId: string, metadata: EditableVersionMetadata) {
    assertVersionMetadata(metadata);
    return this.store.updateVersion(docId, versionId, metadata);
  }

  /**
   * Loads the full document state snapshot for a specific version by its ID.
   * Returns a ReadableStream so the state can be streamed to clients via RPC.
   * @param docId - The ID of the document.
   * @param versionId - The unique ID of the version.
   * @returns A ReadableStream of the JSON state.
   * @throws StatusError 404 when the version does not exist, retryable StatusError 503 when
   *   its state is not available (lost, or a deferred build that hasn't landed), or Error if
   *   state loading fails.
   */
  async getVersionState(docId: string, versionId: string): Promise<ReadableStream<string>> {
    let rawState: string | ReadableStream<string> | undefined;
    try {
      rawState = await this.store.loadVersionState(docId, versionId);
    } catch (error) {
      // Duck-typed, not `instanceof`: a store from a consuming package (pup) throws its own
      // StatusError class, which must still pass through verbatim rather than be wrapped generic.
      if (isStatusError(error)) throw error;
      console.error(`Failed to load state for version ${versionId} of doc ${docId}.`, error);
      throw new Error(`Could not load state for version ${versionId}.`, { cause: error });
    }
    if (!isMissingVersionState(rawState)) {
      return typeof rawState === 'string' ? jsonReadable(rawState) : rawState;
    }
    // Missing state (undefined, or '' from a zero-byte blob) is not servable as a document:
    // distinguish a version that doesn't exist (404) from one whose state isn't available (503).
    // The disambiguating load stays guarded too, so a transient failure here surfaces
    // logged/wrapped like every other failure mode of this method — not raw as a code-less
    // JSON-RPC -32000 leaking the store's stack.
    let version: VersionMetadata | undefined;
    try {
      version = await this.store.loadVersion(docId, versionId);
    } catch (error) {
      if (isStatusError(error)) throw error;
      console.error(`Failed to load version ${versionId} of doc ${docId}.`, error);
      throw new Error(`Could not load version ${versionId}.`, { cause: error });
    }
    if (!version) throw new StatusError(404, `Version ${versionId} not found for doc ${docId}.`);
    throw new StatusError(503, `State for version ${versionId} of doc ${docId} is unavailable; retry later.`, {
      docId,
      versionId,
    });
  }

  /**
   * Returns the document state immediately before a version's changes begin.
   *
   * Uses the version's `parentId` chain to find the correct baseline — so
   * offline-branch session 2 returns the state after session 1, not after the
   * last main-timeline version. Bridges any gap between the parent's `endRev`
   * and the version's `startRev` by applying intermediate changes.
   *
   * Use this as the baseline when scrubbing through a version's individual changes.
   *
   * Only available for OT stores.
   *
   * @param docId - The document ID.
   * @param versionId - The version whose pre-state to compute.
   * @returns A ReadableStream of the JSON state at `version.startRev - 1`.
   */
  async getStateBeforeVersion(docId: string, versionId: string): Promise<ReadableStream<string>> {
    if (!('listChanges' in this.store)) {
      throw new Error('getStateBeforeVersion is only supported for OT stores.');
    }
    const otStore = this.store as OTStoreBackend;
    const version = await otStore.loadVersion(docId, versionId);
    if (!version) {
      // Same 404 contract as getVersionState — both are RPC-exposed `read`, so a missing
      // version surfaces one consistent, code-carrying status rather than a generic Error.
      throw new StatusError(404, `Version ${versionId} not found for doc ${docId}.`);
    }
    // History viewing is reconstruction of settled history, not live apply: a
    // historically-invalid committed op (from lenient-era commits) must not make
    // the scrubbing baseline permanently unreadable. Skips are surfaced through
    // the onSkippedChange telemetry hook (or console.error by default).
    const { onSkippedChange } = this.options;
    return getStateBeforeVersionAsStream(otStore, docId, version, {
      reconstruction: onSkippedChange ? { onSkippedChange: skipped => onSkippedChange(docId, skipped) } : {},
    });
  }

  /**
   * Loads the list of original client changes that were included in a specific version.
   * Useful for replaying/scrubbing through the operations within an offline or online session.
   * @param docId - The ID of the document.
   * @param versionId - The unique ID of the version.
   * @returns An array of Change objects.
   * @throws Error if the version ID is not found or change loading fails.
   */
  async getVersionChanges(docId: string, versionId: string): Promise<Change[]> {
    try {
      return (await this.store.loadVersionChanges?.(docId, versionId)) ?? [];
    } catch (error) {
      console.error(`Failed to load changes for version ${versionId} of doc ${docId}.`, error);
      throw new Error(`Could not load changes for version ${versionId}.`, { cause: error });
    }
  }
}

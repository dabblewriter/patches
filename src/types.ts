import { JSONPatch } from './json-patch/JSONPatch.js';
import type { JSONPatchOp } from './json-patch/types.js';

/**
 * A change being submitted to the server. Unlike committed Change, rev and baseRev are optional.
 * If omitted, the server fills them in using the current latest revision (apply to latest).
 * This is useful for server-to-server operations like migrations so that you don't need to
 * fetch the document just to get its revision number.
 */
export interface ChangeInput {
  /** Unique identifier for the change, generated client-side. */
  id: string;
  /** The patch operations. */
  ops: JSONPatchOp[];
  /** Optional base revision. If omitted, server uses current revision (apply to latest). */
  baseRev?: number;
  /** Optional revision number. If omitted, server assigns based on current state. */
  rev?: number;
  /** Client-side ISO timestamp when the change was created (with timezone offset). */
  createdAt: string;
  /** Optional batch identifier for grouping changes that belong to the same client batch (for multi-batch offline/large edits). */
  batchId?: string;
  /** Optional arbitrary metadata associated with the change. */
  [metadata: string]: any;
}

/**
 * A change that has been committed to the server with assigned revision numbers.
 * This is the canonical form of changes stored and returned by the server.
 */
export interface Change extends ChangeInput {
  /** The server revision this change was based on. */
  baseRev: number;
  /** The revision number assigned by the server after commit. */
  rev: number;
  /** Server-side ISO timestamp when the change was committed (UTC with Z). */
  committedAt: string;
}

/**
 * Represents the state of a document in the OT protocol.
 * @property state - The state of the document.
 * @property rev - The revision number of the state.
 */
export interface PatchesState<T = any> {
  state: T;
  rev: number;
}

/**
 * Represents a snapshot of a document in the OT protocol.
 * @property state - The state of the document.
 * @property rev - The revision number of the state.
 * @property changes - Any unapplied changes since `rev` that may be applied to the `state` to get the latest state.
 */
export interface PatchesSnapshot<T = any> extends PatchesState<T> {
  changes: Change[];
}

/**
 * Represents the syncing state of a document.
 * @property initial - The document is not syncing.
 * @property updating - The document is syncing.
 * @property null - The document is not syncing.
 * @property Error - The document is syncing with an error.
 */
export type SyncingState = 'initial' | 'updating' | null | Error;

/** Status options for a branch */
export type BranchStatus = 'open' | 'closed' | 'merged' | 'archived' | 'abandoned';

export interface Branch {
  /** The ID of the branch document. */
  id: string;
  /** The ID of the document this document was branched from. */
  docId: string;
  /** The revision number on the source document where the branch occurred. */
  branchedAtRev: number;
  /** Server-side ISO timestamp when the branch was created (UTC with Z). */
  createdAt: string;
  /** Optional user-friendly name for the branch. */
  name?: string;
  /** Current status of the branch. */
  status: BranchStatus;
  /** Optional arbitrary metadata associated with the branch record. */
  [metadata: string]: any;
}

export type EditableBranchMetadata = Disallowed<Branch, 'id' | 'docId' | 'branchedAtRev' | 'createdAt' | 'status'>;

/**
 * Metadata, state snapshot, and included changes for a specific version.
 */
export interface VersionMetadata {
  /** Unique identifier (UUID) for this version record. */
  id: string;
  name?: string;
  /** ID of the parent version in the history DAG. Undefined for root versions and for the first branched version. */
  parentId?: string;
  /** Identifier linking versions from the same offline batch or branch. */
  groupId?: string;
  /** Indicates how the version was created ('main', 'offline-branch', 'branch'). */
  origin: 'main' | 'offline-branch' | 'branch';
  /** Was this version created while offline? Tracks creation context separately from timeline position. */
  isOffline?: boolean;
  /** User-defined name if origin is 'branch'. */
  branchName?: string;
  /** Server-side ISO timestamp of version start (UTC with Z). */
  startedAt: string;
  /** Server-side ISO timestamp of version end (UTC with Z). */
  endedAt: string;
  /** The ending revision number of this version (the last change's rev). */
  endRev: number;
  /** The starting revision number of this version (the first change's rev). */
  startRev: number;
  /** Optional arbitrary metadata associated with the version. */
  [metadata: string]: any;
}

type Disallowed<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>> & {
  [P in K]?: never;
};

export type EditableVersionMetadata = Disallowed<
  VersionMetadata,
  'id' | 'parentId' | 'groupId' | 'origin' | 'branchName' | 'startedAt' | 'endedAt' | 'endRev' | 'startRev'
>;

/**
 * Options for committing changes.
 */
export interface CommitChangesOptions {
  /**
   * If true, save changes even if they result in no state modification.
   * Useful for migrations where change history must be preserved exactly.
   */
  forceCommit?: boolean;
  /**
   * Enable historical import mode for migrations. When true:
   * - Preserves `committedAt` if provided (otherwise sets to serverNow)
   * - Uses first incoming change's timestamp for session gap detection (not serverNow)
   * - Creates versions with origin: 'main' instead of 'offline'
   */
  historicalImport?: boolean;
}

/**
 * Options for listing committed server changes. *Always* ordered by revision number.
 */
export interface ListChangesOptions {
  /** List changes committed strictly *after* this revision number. */
  startAfter?: number;
  /** List changes committed strictly *before* this revision number. */
  endBefore?: number;
  /** Maximum number of changes to return. */
  limit?: number;
  /** Return changes in descending revision order (latest first). Defaults to false (ascending). */
  reverse?: boolean;
  /** Filter out changes that have the given batch ID. */
  withoutBatchId?: string;
}

/**
 * Options for listing version metadata.
 */
export interface ListVersionsOptions {
  /** List versions whose orderBy field is *after* this value. */
  startAfter?: number | string;
  /** List versions whose orderBy field is strictly *before* this value. */
  endBefore?: number | string;
  /** Maximum number of versions to return. */
  limit?: number;
  /** Sort by startedAt, endRev, or startRev. Defaults to 'endRev'. */
  orderBy?: 'startedAt' | 'endRev' | 'startRev';
  /** Return versions in descending order. Defaults to false (ascending). When reversed, startAfter and endBefore apply to the *reversed* list. */
  reverse?: boolean;
  /** Filter by the origin type. */
  origin?: 'main' | 'offline-branch' | 'branch';
  /** Filter by the group ID (branch ID or offline batch ID). */
  groupId?: string;
}

/** Detects if T is exactly `any` */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** Untyped path proxy that allows arbitrary deep property access */
type DeepPathProxy = { [key: string]: DeepPathProxy } & { toString: () => string };

/**
 * A proxy type for creating JSON Pointer paths in a type-safe way.
 * This type makes all optional properties required to allow path navigation
 * without null checks, but should only be used for path generation, not value access.
 *
 * Defaults to `any`, which returns a `DeepPathProxy` allowing arbitrary deep property access.
 * When a specific type is provided, returns a strictly typed proxy.
 */
export type PathProxy<T = any> =
  IsAny<T> extends true
    ? DeepPathProxy
    : {
        [P in keyof T]-?: NonNullable<T[P]> extends object ? PathProxy<NonNullable<T[P]>> : { toString: () => string };
      } & { toString: () => string };

/**
 * Type signature for change mutator functions that use path-only proxies.
 * The mutator receives a JSONPatch instance and a PathProxy for type-safe path creation.
 * All modifications must be done through explicit patch operations.
 */
export type ChangeMutator<T> = (patch: JSONPatch, root: PathProxy<T>) => void;

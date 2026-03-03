// Core server implementations
export { LWWServer, type LWWServerOptions } from './LWWServer.js';
export { OTServer, type CommitChangesOptions, type OTServerOptions } from './OTServer.js';

// Branch managers
export type { BranchManager } from './BranchManager.js';
export { LWWBranchManager } from './LWWBranchManager.js';
export { OTBranchManager, PatchesBranchManager } from './OTBranchManager.js';

// In-memory backends (for testing)
export { LWWMemoryStoreBackend } from './LWWMemoryStoreBackend.js';

// History manager
export { PatchesHistoryManager } from './PatchesHistoryManager.js';

// Version state building utilities
export { buildVersionState, getBaseStateBeforeVersion } from '../algorithms/ot/server/buildVersionState.js';

// Stream utilities
export { concatStreams, jsonReadable, parseVersionState, readStreamAsString } from './jsonReadable.js';

// Concurrency utilities
export { blockable, blockableResponse, blocking, singleInvocation } from '../utils/concurrency.js';

// Errors
export { RevConflictError } from './RevConflictError.js';

// Utilities
export {
  assertBranchMetadata,
  assertBranchOpenForMerge,
  assertNotABranch,
  branchManagerApi,
  createBranchRecord,
  generateBranchId,
  wrapMergeCommit,
  type BranchIdGenerator,
  type BranchLoader,
} from './branchUtils.js';
export { CompressedStoreBackend } from './CompressedStoreBackend.js';
export { createTombstoneIfSupported, isTombstoneStore, removeTombstoneIfExists } from './tombstone.js';
export { assertVersionMetadata } from './utils.js';

// Interfaces
export type { DeleteDocOptions } from '../types.js';
export type { PatchesServer } from './PatchesServer.js';
export type {
  BranchingStoreBackend,
  ListFieldsOptions,
  LWWStoreBackend,
  OTStoreBackend,
  ServerStoreBackend,
  SnapshotResult,
  TombstoneStoreBackend,
  VersioningStoreBackend,
} from './types.js';

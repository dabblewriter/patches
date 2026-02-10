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
  TombstoneStoreBackend,
  VersioningStoreBackend,
} from './types.js';

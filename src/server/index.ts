// Core server implementations
export { OTServer, type OTServerOptions, type CommitChangesOptions } from './OTServer.js';
export { LWWServer, type LWWServerOptions } from './LWWServer.js';

// Branch managers
export type { BranchManager } from './BranchManager.js';
export { OTBranchManager, PatchesBranchManager } from './OTBranchManager.js';
export { LWWBranchManager } from './LWWBranchManager.js';

// In-memory backends (for testing)
export { LWWMemoryStoreBackend } from './LWWMemoryStoreBackend.js';

// History manager
export { PatchesHistoryManager } from './PatchesHistoryManager.js';

// Utilities
export { CompressedStoreBackend } from './CompressedStoreBackend.js';
export { assertVersionMetadata } from './utils.js';
export { isTombstoneStore, createTombstoneIfSupported, removeTombstoneIfExists } from './tombstone.js';
export {
  branchManagerApi,
  assertBranchMetadata,
  generateBranchId,
  createBranchRecord,
  assertNotABranch,
  assertBranchOpenForMerge,
  wrapMergeCommit,
  type BranchIdGenerator,
  type BranchLoader,
} from './branchUtils.js';

// Interfaces
export type { PatchesServer } from './PatchesServer.js';
export type {
  ServerStoreBackend,
  OTStoreBackend,
  VersioningStoreBackend,
  TombstoneStoreBackend,
  BranchingStoreBackend,
  // LWW store interfaces
  FieldMeta,
  ListFieldsOptions,
  LWWStoreBackend,
  LWWVersioningStoreBackend,
  // Deprecated alias for backwards compatibility
  PatchesStoreBackend,
} from './types.js';
export type { DeleteDocOptions } from '../types.js';

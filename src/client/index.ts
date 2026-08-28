export * from './BaseDoc.js';
export * from './factories.js';
export * from './IndexedDBStore.js';
export * from './OTIndexedDBStore.js';
export * from './LWWIndexedDBStore.js';
export * from './OTInMemoryStore.js';
export * from './LWWInMemoryStore.js';
export * from './LWWDoc.js';
export * from './LWWAlgorithm.js';
export * from './LWWBatcher.js';
export * from './OTDoc.js';
export * from './OTAlgorithm.js';
export * from './Patches.js';
export * from './PatchesDoc.js';
export * from './PatchesBranchClient.js';
export * from './PatchesHistoryClient.js';
export type * from './BranchClientStore.js';
export type * from './PatchesStore.js';
export type * from './OTClientStore.js';
export type * from './LWWClientStore.js';
export type * from './ClientAlgorithm.js';
// Sync-recovery errors, exported so consumers can `instanceof` instead of matching by name
export { MissingChangesError } from '../algorithms/ot/client/applyCommittedChanges.js';
export { ApplyChangesError } from '../algorithms/ot/shared/applyChanges.js';
// (isLossyEjectionError deliberately checks by name, not instanceof — it must survive
// an RPC/worker boundary that rehydrates errors.)
export { LossyEjectionError, isLossyEjectionError } from '../algorithms/ot/shared/ejectPendingChange.js';
export {
  isNonCloneableOpError,
  isUnsplittableChangeError,
  NonCloneableOpError,
  UnsplittableChangeError,
  UnstoredPendingError,
} from '../net/error.js';
// The splitter itself, plus telemetry for changes it can't get under the storage
// budget. `breakChangesIntoBatches` is public because apps commit over REST on
// paths `PatchesSync.flushDoc` never sees (branch merges, heals); without it they
// reimplement the splitting and drift from the budget the library was configured with.
export {
  breakChangesIntoBatches,
  onOversizedOp,
  type BreakChangesIntoBatchesOptions,
  type ChangeSplitOptions,
  type OversizedOpReason,
  type OversizedOpReport,
  type SizeCalculator,
} from '../algorithms/ot/shared/changeBatching.js';

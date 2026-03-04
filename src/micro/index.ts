export { MicroClient } from './client.js';
export type { ClientOptions } from './client.js';
export { MicroDoc } from './doc.js';
export type { Updatable } from './doc.js';
export { applyBitmask, bitmask, buildState, combineBitmasks, consolidateOps, effectiveFields, generateId, mergeField } from './ops.js';
export { MemoryDbBackend, MicroServer } from './server.js';
export { BIT, INC, MAX, parseSuffix, REF_THRESHOLD, TXT } from './types.js';
export type { Change, ChangeLogEntry, CommitResult, DbBackend, DocState, Field, FieldMap, ObjectStore, TextLogEntry } from './types.js';


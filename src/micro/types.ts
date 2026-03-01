/** A field value with LWW timestamp. */
export interface Field { val: any; ts: number }

/** Map of dot-notation field keys (with optional suffix) to values. */
export type FieldMap = Record<string, Field>;

/** A change sent from client to server. */
export interface Change { id: string; rev: number; fields: FieldMap }

/** Result from server after committing a change. */
export interface CommitResult { rev: number; fields: FieldMap }

/** Full document state. */
export interface DocState { rev: number; fields: FieldMap }

/** Suffix constants for special field types. */
export const INC = '+', BIT = '~', TXT = '#', MAX = '^';
const SUFFIXES = new Set([INC, BIT, TXT, MAX]);

/** Parse a field key into its path and suffix (if any). */
export function parseSuffix(key: string): { path: string; suffix: string } {
  const last = key[key.length - 1];
  return SUFFIXES.has(last) ? { path: key.slice(0, -1), suffix: last } : { path: key, suffix: '' };
}

/** Server-side text log entry for OT. */
export interface TextLogEntry { key: string; delta: any; rev: number }

/** Server-side change log entry for idempotency. */
export interface ChangeLogEntry { changeId: string; ts: number }

/** Pluggable server-side database backend. */
export interface DbBackend {
  getFields(docId: string): Promise<FieldMap>;
  getField(docId: string, key: string): Promise<Field | null>;
  setFields(docId: string, fields: FieldMap): Promise<void>;
  getTextLog(docId: string, key: string, sinceRev?: number): Promise<TextLogEntry[]>;
  appendTextLog(docId: string, entry: TextLogEntry): Promise<void>;
  compactTextLog(docId: string, key: string, throughRev: number, composedDelta: any): Promise<void>;
  hasChange(docId: string, changeId: string): Promise<boolean>;
  addChange(docId: string, entry: ChangeLogEntry): Promise<void>;
  pruneChanges(docId: string, beforeTs: number): Promise<void>;
  getRev(docId: string): Promise<number>;
  setRev(docId: string, rev: number): Promise<void>;
}

/** Pluggable object storage for large values (S3/R2). */
export interface ObjectStore {
  put(key: string, value: any): Promise<string>;
  get(ref: string): Promise<any>;
  del(ref: string): Promise<void>;
}

/** Large value threshold in bytes (64KB). */
export const REF_THRESHOLD = 65536;

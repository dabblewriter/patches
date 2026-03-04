/** Operation type for a field. */
export type Op = '=' | '!' | '+' | '~' | '^' | '#';

/** A field value with operation type and LWW timestamp. */
export interface Field {
  op: Op;
  val: any;
  ts: number;
}

/** Map of dot-notation field paths to field values. */
export type FieldMap = Record<string, Field>;

/** A change sent from client to server. */
export interface Change {
  id: string;
  rev: number;
  fields: FieldMap;
}

/** Result from server after committing a change. */
export interface CommitResult {
  rev: number;
  fields: FieldMap;
}

/** Full document state. */
export interface DocState {
  rev: number;
  fields: FieldMap;
}

/** Server-side text log entry for OT. */
export interface TextLogEntry {
  key: string;
  delta: any;
  rev: number;
}

/** Server-side change log entry for idempotency. */
export interface ChangeLogEntry {
  changeId: string;
  ts: number;
}

/** Data for an atomic commit operation. */
export interface CommitWrite {
  fields: FieldMap;
  textLogEntries?: TextLogEntry[];
  changeLogEntry?: ChangeLogEntry;
  expectedRev: number;
}

/** Thrown when an atomic commit fails due to a revision conflict. */
export class RevConflictError extends Error {
  constructor(
    public expectedRev: number,
    public actualRev: number
  ) {
    super(`Rev conflict: expected ${expectedRev}, got ${actualRev}`);
    this.name = 'RevConflictError';
  }
}

/** Sync result including text log for TXT field rebasing. */
export interface SyncResult extends DocState {
  textLog: Record<string, any[]>;
}

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

  /**
   * Atomically set fields, append text log entries, log the change ID,
   * and increment rev. Throws RevConflictError if current rev !== expectedRev.
   * Returns the new rev.
   *
   * Optional. If not implemented, MicroServer falls back to non-atomic writes
   * (safe for single-server deployments). Multi-server deployments must either
   * implement this method or route all requests for a document to the same server.
   */
  commit?(docId: string, write: CommitWrite): Promise<number>;
}

/** Pluggable object storage for large values (S3/R2). */
export interface ObjectStore {
  put(key: string, value: any): Promise<string>;
  get(ref: string): Promise<any>;
  del(ref: string): Promise<void>;
}

/** Large value threshold in bytes (64KB). */
export const REF_THRESHOLD = 65536;

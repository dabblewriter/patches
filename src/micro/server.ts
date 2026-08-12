import { Delta } from '@dabble/delta';
import { descendantKeys, mergeField } from './ops.js';
import {
  CompactionError,
  RevConflictError,
  REF_THRESHOLD,
  type Change,
  type ChangeLogEntry,
  type CommitResult,
  type CommitWrite,
  type DbBackend,
  type DocState,
  type Field,
  type FieldMap,
  type ObjectStore,
  type SyncResult,
  type TextLogEntry,
} from './types.js';

type Subscriber = (fields: FieldMap, rev: number, changeId: string) => void;

const MAX_RETRIES = 3;

/** True when the base rev falls strictly inside a compacted entry's range. */
const insideCompactedRange = (log: TextLogEntry[], baseRev: number) =>
  log.some(e => e.startRev !== undefined && e.startRev < baseRev && baseRev < e.rev);

export class MicroServer {
  private _subs = new Map<string, Set<Subscriber>>();
  private _queues = new Map<string, Promise<unknown>>();

  constructor(
    private _db: DbBackend,
    private _objects?: ObjectStore
  ) {}

  /** Get full document state. */
  async getDoc(docId: string): Promise<DocState> {
    const [fields, rev] = await Promise.all([this._fields(docId), this._db.getRev(docId)]);
    return { fields, rev };
  }

  /**
   * Get the current state plus text log entries since a revision, so clients
   * can resync and rebase pending TXT ops. Keys whose log has been compacted
   * across `sinceRev` are omitted from the text log (the client reconciles
   * from the snapshot instead).
   */
  async getChangesSince(docId: string, sinceRev: number): Promise<SyncResult> {
    const { fields, rev } = await this.getDoc(docId);
    const textLog: Record<string, TextLogEntry[]> = {};
    if (sinceRev < rev) {
      const txtKeys = Object.keys(fields).filter(key => fields[key].op === '#');
      const logs = await Promise.all(txtKeys.map(key => this._db.getTextLog(docId, key, sinceRev)));
      txtKeys.forEach((key, i) => {
        if (!insideCompactedRange(logs[i], sinceRev)) textLog[key] = logs[i];
      });
    }
    return { fields, rev, textLog };
  }

  /** Process an incoming change from a client. Commits are serialized per doc. */
  commitChanges(docId: string, change: Change): Promise<CommitResult> {
    return this._enqueue(docId, () => this._commitChanges(docId, change, MAX_RETRIES));
  }

  private async _commitChanges(docId: string, change: Change, _retries: number): Promise<CommitResult> {
    const touched = Object.keys(change.fields);
    const [dup, rev, existingFields] = await Promise.all([
      this._db.hasChange(docId, change.id),
      this._db.getRev(docId),
      this._fields(docId, touched),
    ]);

    if (dup) {
      // Already committed (a retried send). Return the committed resolution of
      // the touched paths — never re-apply, never starve the confirm path.
      const fields: FieldMap = {};
      for (const key of touched) {
        const f = existingFields[key];
        // TXT fields return the full committed text as an absolute value.
        if (f) fields[key] = f.op === '#' ? { op: '=', val: f.val, ts: f.ts } : f;
      }
      return { rev, fields };
    }

    const resultFields: FieldMap = {};
    const fieldsToSave: FieldMap = {};
    const textLogEntries: TextLogEntry[] = [];
    let hasCombinableOps = false;

    for (const [key, incoming] of Object.entries(change.fields)) {
      const existing = existingFields[key];
      if (incoming.op === '+' || incoming.op === '~' || incoming.op === '#') hasCombinableOps = true;

      if (incoming.op === '#') {
        // Get text log entries since client's rev for OT
        const log = await this._db.getTextLog(docId, key, change.rev);
        if (insideCompactedRange(log, change.rev)) {
          throw new CompactionError(change.rev); // client must resync and re-send
        }
        let delta = new Delta(incoming.val);

        // Transform against concurrent edits
        for (const entry of log) {
          delta = new Delta(entry.delta).transform(delta, true);
        }

        // Compose transformed delta into current full text
        const base = existing?.val ? new Delta(existing.val) : new Delta();
        fieldsToSave[key] = { op: '#', val: base.compose(delta).ops, ts: incoming.ts };
        textLogEntries.push({ key, delta: delta.ops, rev: rev + 1 });

        // Broadcast the transformed delta (not the full text)
        resultFields[key] = { op: '#', val: delta.ops, ts: incoming.ts };
        continue;
      }

      const resolved = mergeField(existing, incoming);
      if (existing && resolved === existing) continue; // incoming lost the merge; nothing to write

      if (incoming.op === '=' || incoming.op === '!') {
        // A parent set/delete tombstones descendant fields (LWW ts-respecting)
        // so deleted subtrees cannot resurrect from child rows.
        for (const childKey of descendantKeys(existingFields, key, incoming.ts)) {
          if (existingFields[childKey].val === null) continue;
          const tombstone: Field = { op: '!', val: null, ts: incoming.ts };
          fieldsToSave[childKey] = tombstone;
          resultFields[childKey] = tombstone;
        }
      }

      resultFields[key] = resolved;
      fieldsToSave[key] = resolved;
    }

    if (!Object.keys(resultFields).length) {
      return { rev, fields: {} };
    }

    // Offload oversized values AFTER resultFields is built, so broadcasts and
    // commit results always carry real values — refs never escape the server.
    const saveFields: FieldMap = { ...fieldsToSave };
    await Promise.all(
      Object.entries(fieldsToSave).map(async ([key, field]) => {
        saveFields[key] = await this._offload(docId, key, field);
      })
    );

    const changeLogEntry = hasCombinableOps ? { changeId: change.id, ts: Date.now() } : undefined;

    // Commit all writes, atomically if the backend supports it
    const newRev = await this._commit(docId, {
      fields: saveFields,
      textLogEntries: textLogEntries.length ? textLogEntries : undefined,
      changeLogEntry,
      expectedRev: rev,
    });

    if (newRev === null) {
      // CAS conflict — retry
      if (_retries <= 0) throw new RevConflictError(rev, -1);
      return this._commitChanges(docId, change, _retries - 1);
    }

    this._broadcast(docId, resultFields, newRev, change.id);
    return { rev: newRev, fields: resultFields };
  }

  /** Compact text log entries up to a revision. */
  async compactTextLog(docId: string, key: string, throughRev: number) {
    const entries = await this._db.getTextLog(docId, key, 0);
    if (entries.length < 2) return;
    const toCompose = entries.filter(e => e.rev <= throughRev);
    if (toCompose.length < 2) return;
    let composed = new Delta(toCompose[0].delta);
    for (let i = 1; i < toCompose.length; i++) {
      composed = composed.compose(new Delta(toCompose[i].delta));
    }
    await this._db.compactTextLog(docId, key, throughRev, composed.ops);
  }

  /** Prune old change log entries. */
  async pruneChanges(docId: string, beforeTs: number) {
    await this._db.pruneChanges(docId, beforeTs);
  }

  /** Subscribe to changes for a document. */
  subscribe(docId: string, cb: Subscriber) {
    let subs = this._subs.get(docId);
    if (!subs) {
      subs = new Set();
      this._subs.set(docId, subs);
    }
    subs.add(cb);
    return () => {
      subs!.delete(cb);
      if (!subs!.size) this._subs.delete(docId);
    };
  }

  /** Get subscriber count for a document. */
  subscriberCount(docId: string): number {
    return this._subs.get(docId)?.size ?? 0;
  }

  private _broadcast(docId: string, fields: FieldMap, rev: number, changeId: string) {
    const subs = this._subs.get(docId);
    if (!subs) return;
    for (const cb of subs) cb(fields, rev, changeId);
  }

  /** Serialize work per doc id so read-modify-write commits never interleave. */
  private _enqueue<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._queues.get(docId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this._queues.set(docId, tail);
    void tail.then(() => {
      if (this._queues.get(docId) === tail) this._queues.delete(docId);
    });
    return run;
  }

  /** Commit writes, using atomic commit if available. Returns new rev or null on CAS conflict. */
  private async _commit(docId: string, write: CommitWrite): Promise<number | null> {
    if (this._db.commit) {
      try {
        return await this._db.commit(docId, write);
      } catch (e) {
        if (e instanceof RevConflictError || (e as Error)?.name === 'RevConflictError') return null;
        throw e;
      }
    }

    // Non-atomic fallback. Safe on a single instance because commits are
    // serialized per doc, but validate the rev anyway.
    const currentRev = await this._db.getRev(docId);
    if (currentRev !== write.expectedRev) return null;
    if (Object.keys(write.fields).length) {
      await this._db.setFields(docId, write.fields);
    }
    if (write.textLogEntries) {
      for (const entry of write.textLogEntries) {
        await this._db.appendTextLog(docId, entry);
      }
    }
    if (write.changeLogEntry) {
      await this._db.addChange(docId, write.changeLogEntry);
    }
    const newRev = write.expectedRev + 1;
    await this._db.setRev(docId, newRev);
    return newRev;
  }

  /** Read a document's fields, hydrating refs for `keys` only (all keys if omitted). */
  private async _fields(docId: string, keys?: string[]): Promise<FieldMap> {
    return this._hydrate(await this._db.getFields(docId), keys);
  }

  /** Resolve `{ __ref }` stubs so refs never reach merge logic or clients. */
  private async _hydrate(fields: FieldMap, keys?: string[]): Promise<FieldMap> {
    if (!this._objects) return fields;
    const refKeys = (keys ?? Object.keys(fields)).filter(key => fields[key]?.val?.__ref);
    if (!refKeys.length) return fields;
    const out = { ...fields };
    await Promise.all(
      refKeys.map(async key => {
        out[key] = { ...out[key], val: await this._objects!.get(out[key].val.__ref) };
      })
    );
    return out;
  }

  /** Swap oversized values for ObjectStore refs on the stored copy only. */
  private async _offload(docId: string, key: string, field: Field): Promise<Field> {
    if (!this._objects || field.val == null) return field;
    const size = typeof field.val === 'string' ? field.val.length : JSON.stringify(field.val).length;
    if (size <= REF_THRESHOLD) return field;
    const ref = await this._objects.put(`${docId}/${key}`, field.val);
    return { op: field.op, val: { __ref: ref, __rev: field.ts }, ts: field.ts };
  }
}

// --- In-memory DbBackend for testing/development ---

export class MemoryDbBackend implements DbBackend {
  private _fields = new Map<string, FieldMap>();
  private _textLog = new Map<string, TextLogEntry[]>();
  private _changeLog = new Map<string, ChangeLogEntry[]>();
  private _revs = new Map<string, number>();

  async getFields(docId: string): Promise<FieldMap> {
    return { ...(this._fields.get(docId) ?? {}) };
  }
  async getField(docId: string, key: string): Promise<Field | null> {
    return this._fields.get(docId)?.[key] ?? null;
  }
  async setFields(docId: string, fields: FieldMap): Promise<void> {
    const existing = this._fields.get(docId) ?? {};
    this._fields.set(docId, { ...existing, ...fields });
  }
  async getTextLog(docId: string, key: string, sinceRev = 0): Promise<TextLogEntry[]> {
    return (this._textLog.get(`${docId}:${key}`) ?? []).filter(e => e.rev > sinceRev);
  }
  async appendTextLog(docId: string, entry: TextLogEntry): Promise<void> {
    const k = `${docId}:${entry.key}`;
    const log = this._textLog.get(k) ?? [];
    log.push(entry);
    this._textLog.set(k, log);
  }
  async compactTextLog(docId: string, key: string, throughRev: number, composedDelta: any): Promise<void> {
    const k = `${docId}:${key}`;
    const log = this._textLog.get(k) ?? [];
    const composed = log.filter(e => e.rev <= throughRev);
    const remaining = log.filter(e => e.rev > throughRev);
    const startRev = composed.length ? Math.min(...composed.map(e => e.startRev ?? e.rev - 1)) : 0;
    remaining.unshift({ key, delta: composedDelta, rev: throughRev, startRev });
    this._textLog.set(k, remaining);
  }
  async hasChange(docId: string, changeId: string): Promise<boolean> {
    return (this._changeLog.get(docId) ?? []).some(e => e.changeId === changeId);
  }
  async addChange(docId: string, entry: ChangeLogEntry): Promise<void> {
    const log = this._changeLog.get(docId) ?? [];
    log.push(entry);
    this._changeLog.set(docId, log);
  }
  async pruneChanges(docId: string, beforeTs: number): Promise<void> {
    const log = this._changeLog.get(docId) ?? [];
    this._changeLog.set(
      docId,
      log.filter(e => e.ts >= beforeTs)
    );
  }
  async getRev(docId: string): Promise<number> {
    return this._revs.get(docId) ?? 0;
  }
  async setRev(docId: string, rev: number): Promise<void> {
    this._revs.set(docId, rev);
  }

  async commit(docId: string, write: CommitWrite): Promise<number> {
    const currentRev = this._revs.get(docId) ?? 0;
    if (currentRev !== write.expectedRev) {
      throw new RevConflictError(write.expectedRev, currentRev);
    }
    const newRev = currentRev + 1;
    if (Object.keys(write.fields).length) {
      const existing = this._fields.get(docId) ?? {};
      this._fields.set(docId, { ...existing, ...write.fields });
    }
    if (write.textLogEntries) {
      for (const entry of write.textLogEntries) {
        const k = `${docId}:${entry.key}`;
        const log = this._textLog.get(k) ?? [];
        log.push(entry);
        this._textLog.set(k, log);
      }
    }
    if (write.changeLogEntry) {
      const log = this._changeLog.get(docId) ?? [];
      log.push(write.changeLogEntry);
      this._changeLog.set(docId, log);
    }
    this._revs.set(docId, newRev);
    return newRev;
  }
}

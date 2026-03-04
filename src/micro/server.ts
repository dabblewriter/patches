import { Delta } from '@dabble/delta';
import { applyBitmask } from './ops.js';
import {
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

type Subscriber = (fields: FieldMap, rev: number) => void;

const MAX_RETRIES = 3;

export class MicroServer {
  private _subs = new Map<string, Set<Subscriber>>();

  constructor(
    private _db: DbBackend,
    private _objects?: ObjectStore
  ) {}

  /** Get full document state. */
  async getDoc(docId: string): Promise<DocState> {
    const [fields, rev] = await Promise.all([this._db.getFields(docId), this._db.getRev(docId)]);
    return { fields, rev };
  }

  /** Get fields changed since a given revision, including text log for TXT field rebasing. */
  async getChangesSince(docId: string, sinceRev: number): Promise<SyncResult> {
    const { fields, rev } = await this.getDoc(docId);
    const textLog: Record<string, any[]> = {};

    // Collect text log entries for TXT fields so clients can rebase pending ops
    for (const [key, field] of Object.entries(fields)) {
      if (field.op === '#') {
        const entries = await this._db.getTextLog(docId, key, sinceRev);
        textLog[key] = entries.map(e => e.delta);
      }
    }

    return { fields, rev, textLog };
  }

  /** Process an incoming change from a client. */
  async commitChanges(docId: string, change: Change, _retries = MAX_RETRIES): Promise<CommitResult> {
    // Idempotency check
    if (await this._db.hasChange(docId, change.id)) {
      const rev = await this._db.getRev(docId);
      return { rev, fields: {} };
    }

    const rev = await this._db.getRev(docId);
    const resultFields: FieldMap = {};
    const fieldsToSave: FieldMap = {};
    const textLogEntries: TextLogEntry[] = [];
    let hasCombinableOps = false;

    for (const [key, incoming] of Object.entries(change.fields)) {
      const existing = await this._db.getField(docId, key);

      let resolved: Field;

      switch (incoming.op) {
        case '+': {
          const ev = existing?.val ?? 0;
          resolved = { op: '+', val: ev + incoming.val, ts: incoming.ts };
          hasCombinableOps = true;
          break;
        }
        case '~': {
          const ev = existing?.val ?? 0;
          resolved = { op: '~', val: applyBitmask(ev, incoming.val), ts: incoming.ts };
          hasCombinableOps = true;
          break;
        }
        case '^': {
          const ev = existing?.val ?? 0;
          resolved = incoming.val >= ev ? incoming : existing!;
          if (resolved === existing) continue; // no change
          break;
        }
        case '#': {
          hasCombinableOps = true;
          // Get text log entries since client's rev for OT
          const log = await this._db.getTextLog(docId, key, change.rev);
          let delta = new Delta(incoming.val);

          // Transform against concurrent edits
          for (const entry of log) {
            const serverDelta = new Delta(entry.delta);
            delta = serverDelta.transform(delta, true);
          }

          // Compose transformed delta into current full text
          const base = existing?.val ? new Delta(existing.val) : new Delta();
          resolved = { op: '#', val: base.compose(delta).ops, ts: incoming.ts };

          textLogEntries.push({ key, delta: delta.ops, rev: rev + 1 });

          // Store the transformed delta (not full text) in result for broadcast
          resultFields[key] = { op: '#', val: delta.ops, ts: incoming.ts };
          // Save full text to DB
          await this._handleLargeValue(docId, key, resolved);
          fieldsToSave[key] = resolved;
          continue; // skip the common handling below
        }
        default: {
          // LWW: incoming wins if ts >= existing
          if (existing && incoming.ts < existing.ts) continue;
          resolved = incoming;
        }
      }

      // Handle large values
      await this._handleLargeValue(docId, key, resolved);

      resultFields[key] = resolved;
      fieldsToSave[key] = resolved;
    }

    if (!Object.keys(resultFields).length) {
      return { rev, fields: {} };
    }

    const changeLogEntry = hasCombinableOps ? { changeId: change.id, ts: Date.now() } : undefined;

    // Commit all writes, atomically if the backend supports it
    const newRev = await this._commit(docId, {
      fields: fieldsToSave,
      textLogEntries: textLogEntries.length ? textLogEntries : undefined,
      changeLogEntry,
      expectedRev: rev,
    });

    if (newRev === null) {
      // CAS conflict — retry
      if (_retries <= 0) throw new RevConflictError(rev, -1);
      return this.commitChanges(docId, change, _retries - 1);
    }

    this._broadcast(docId, resultFields, newRev);
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

  private _broadcast(docId: string, fields: FieldMap, rev: number, exclude?: Subscriber) {
    const subs = this._subs.get(docId);
    if (!subs) return;
    for (const cb of subs) {
      if (cb !== exclude) cb(fields, rev);
    }
  }

  /** Commit writes, using atomic commit if available. Returns new rev or null on CAS conflict. */
  private async _commit(docId: string, write: CommitWrite): Promise<number | null> {
    if (this._db.commit) {
      try {
        return await this._db.commit(docId, write);
      } catch (e) {
        if (e instanceof RevConflictError) return null;
        throw e;
      }
    }

    // Non-atomic fallback (safe for single-server deployments)
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

  private async _handleLargeValue(docId: string, key: string, field: Field) {
    if (!this._objects) return;
    const json = JSON.stringify(field.val);
    if (json.length > REF_THRESHOLD) {
      const ref = await this._objects.put(`${docId}/${key}`, field.val);
      field.val = { __ref: ref, __rev: field.ts };
    }
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
    const remaining = log.filter(e => e.rev > throughRev);
    remaining.unshift({ key, delta: composedDelta, rev: throughRev });
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

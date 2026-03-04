import { Delta } from '@dabble/delta';
import { applyBitmask } from './ops.js';
import { BIT, INC, MAX, parseSuffix, REF_THRESHOLD, TXT, type Change, type ChangeLogEntry, type CommitResult, type DbBackend, type DocState, type Field, type FieldMap, type ObjectStore, type TextLogEntry } from './types.js';

type Subscriber = (fields: FieldMap, rev: number) => void;

export class MicroServer {
  private _subs = new Map<string, Set<Subscriber>>();

  constructor(private _db: DbBackend, private _objects?: ObjectStore) { }

  /** Get full document state. */
  async getDoc(docId: string): Promise<DocState> {
    const [fields, rev] = await Promise.all([this._db.getFields(docId), this._db.getRev(docId)]);
    return { fields, rev };
  }

  /** Get fields changed since a given revision (for reconnection). */
  async getChangesSince(docId: string, sinceRev: number): Promise<CommitResult> {
    // For simplicity, return full doc if sinceRev is 0
    const { fields, rev } = await this.getDoc(docId);
    if (sinceRev === 0) return { fields, rev };
    // The DB backend could optimize this, but for now return all fields
    // A production backend would track per-field revisions
    return { fields, rev };
  }

  /** Process an incoming change from a client. */
  async commitChanges(docId: string, change: Change): Promise<CommitResult> {
    // Idempotency check
    if (await this._db.hasChange(docId, change.id)) {
      const rev = await this._db.getRev(docId);
      return { rev, fields: {} };
    }

    const resultFields: FieldMap = {};
    let rev = await this._db.getRev(docId);
    let hasCombinableOps = false;

    for (const [key, incoming] of Object.entries(change.fields)) {
      const { suffix } = parseSuffix(key);
      const existing = await this._db.getField(docId, key);

      let resolved: Field;

      switch (suffix) {
        case INC: {
          const ev = existing?.val ?? 0;
          resolved = { val: ev + incoming.val, ts: incoming.ts };
          hasCombinableOps = true;
          break;
        }
        case BIT: {
          const ev = existing?.val ?? 0;
          resolved = { val: applyBitmask(ev, incoming.val), ts: incoming.ts };
          hasCombinableOps = true;
          break;
        }
        case MAX: {
          const ev = existing?.val ?? 0;
          resolved = incoming.val >= ev ? incoming : existing!;
          if (resolved === existing) continue; // no change
          break;
        }
        case TXT: {
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
          resolved = { val: base.compose(delta).ops, ts: incoming.ts };

          // Append to text log
          await this._db.appendTextLog(docId, { key, delta: delta.ops, rev: rev + 1 });

          // Store the transformed delta (not full text) in result for broadcast
          resultFields[key] = { val: delta.ops, ts: incoming.ts };
          // Still need to save full text to DB
          await this._handleLargeValue(docId, key, resolved);
          const toSave: FieldMap = {};
          toSave[key] = resolved;
          await this._db.setFields(docId, toSave);
          continue; // skip the common save below
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
      const toSave: FieldMap = {};
      toSave[key] = resolved;
      await this._db.setFields(docId, toSave);
    }

    // Log change ID for idempotency (only needed for combinable ops)
    if (hasCombinableOps) {
      await this._db.addChange(docId, { changeId: change.id, ts: Date.now() });
    }

    // Increment revision
    rev++;
    await this._db.setRev(docId, rev);

    // Broadcast to other subscribers
    if (Object.keys(resultFields).length) {
      this._broadcast(docId, resultFields, rev);
    }

    return { rev, fields: resultFields };
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
    if (!subs) { subs = new Set(); this._subs.set(docId, subs); }
    subs.add(cb);
    return () => { subs!.delete(cb); if (!subs!.size) this._subs.delete(docId); };
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
    this._changeLog.set(docId, log.filter(e => e.ts >= beforeTs));
  }
  async getRev(docId: string): Promise<number> {
    return this._revs.get(docId) ?? 0;
  }
  async setRev(docId: string, rev: number): Promise<void> {
    this._revs.set(docId, rev);
  }
}

import { Delta } from '@dabble/delta';
import { createId } from 'crypto-id';
import { type Field, type FieldMap, type TextLogEntry } from './types.js';

// --- Bitmask operations (copied from patches so micro stays portable) ---

/** Create a bitmask value. Bottom 15 bits = on, top 15 bits = off. */
export function bitmask(index: number, value: boolean): number {
  if (index < 0 || index > 14) throw new Error('Index must be between 0 and 14');
  return value ? 1 << index : 1 << (index + 15);
}

/** Apply a bitmask to a number. */
export function applyBitmask(num: number, mask: number): number {
  return (num & ~((mask >> 15) & 0x7fff)) | (mask & 0x7fff);
}

/** Combine two bitmasks into one. */
export function combineBitmasks(a: number, b: number): number {
  const aOff = (a >> 15) & 0x7fff,
    aOn = a & 0x7fff;
  const bOff = (b >> 15) & 0x7fff,
    bOn = b & 0x7fff;
  return (((aOff & ~bOn) | bOff) << 15) | ((aOn & ~bOff) | bOn);
}

// --- Utilities ---

/** Generate a random ID. */
export function generateId(): string {
  return createId(22);
}

export const asNumber = (v: any): number => (typeof v === 'number' ? v : 0);

/**
 * Descendant keys of a dot-notation path. When `beforeTs` is given, children
 * with a newer timestamp are excluded (LWW: they survive a parent write).
 */
export function descendantKeys(fields: FieldMap, path: string, beforeTs?: number): string[] {
  const prefix = path + '.';
  return Object.keys(fields).filter(
    key => key.startsWith(prefix) && (beforeTs === undefined || fields[key].ts <= beforeTs)
  );
}

/** Delete descendant keys of a dot-notation path from a field map (in place). */
export function clearDescendants(fields: FieldMap, path: string, beforeTs?: number) {
  for (const key of descendantKeys(fields, path, beforeTs)) delete fields[key];
}

// --- Field merge ---

/** Merge a single incoming field with an existing value, based on op type. */
export function mergeField(existing: Field | undefined, incoming: Field): Field {
  switch (incoming.op) {
    case '+':
      return { op: '+', val: asNumber(existing?.val) + incoming.val, ts: incoming.ts };
    case '~':
      return { op: '~', val: applyBitmask(asNumber(existing?.val), incoming.val), ts: incoming.ts };
    case '^':
      if (!existing || existing.val == null) return incoming;
      return incoming.val >= existing.val ? incoming : existing;
    case '#':
      return incoming; // text composed separately
    default:
      return !existing || incoming.ts >= existing.ts ? incoming : existing;
  }
}

// --- Consolidation ---

/** Combine an incoming op with an existing pending op on the same key. */
function consolidateField(ex: Field, field: Field): Field {
  if (ex.op === field.op) {
    switch (field.op) {
      case '+':
        return { op: '+', val: ex.val + field.val, ts: field.ts };
      case '~':
        return { op: '~', val: combineBitmasks(ex.val, field.val), ts: field.ts };
      case '^':
        return field.val >= ex.val ? field : ex;
      case '#':
        return { op: '#', val: new Delta(ex.val).compose(new Delta(field.val)).ops, ts: field.ts };
      default:
        return field;
    }
  }
  // Existing op is absolute ('=' set or '!' delete): apply the incoming op to that
  // absolute value so the combined op keeps absolute semantics.
  if (ex.op === '=' || ex.op === '!') {
    const base = ex.op === '!' ? undefined : ex.val;
    switch (field.op) {
      case '+':
        return { op: '=', val: asNumber(base) + field.val, ts: field.ts };
      case '~':
        return { op: '=', val: applyBitmask(asNumber(base), field.val), ts: field.ts };
      case '^':
        return { op: '=', val: base != null && !(field.val >= base) ? base : field.val, ts: field.ts };
      case '#':
        return { op: '=', val: new Delta(base ?? []).compose(new Delta(field.val)).ops, ts: field.ts };
    }
  }
  // Mixed relative ops ('+' then '~', etc.): last op wins.
  return field;
}

/** Consolidate new ops into existing pending ops (client-side batching). */
export function consolidateOps(pending: FieldMap, newOps: FieldMap): FieldMap {
  const result = { ...pending };
  for (const [key, field] of Object.entries(newOps)) {
    // A set/delete of a parent path supersedes any pending ops on its children.
    if (field.op === '=' || field.op === '!') clearDescendants(result, key);
    const ex = result[key];
    result[key] = ex ? consolidateField(ex, field) : field;
  }
  return result;
}

// --- Pending TXT rebase ---

/**
 * Transform pending TXT field deltas against server text log entries (for resync).
 * Entries at `excludeRev` are skipped (the client's own committed change, which
 * pending ops were already built on top of).
 */
export function transformPendingTxt(
  pending: FieldMap,
  textLog: Record<string, TextLogEntry[]>,
  excludeRev?: number
): FieldMap {
  const result = { ...pending };
  for (const [key, entries] of Object.entries(textLog)) {
    if (result[key]?.op !== '#') continue;
    let p = new Delta(result[key].val);
    for (const entry of entries) {
      if (entry.rev === excludeRev) continue;
      p = new Delta(entry.delta).transform(p, true); // server has priority
    }
    result[key] = { op: '#', val: p.ops, ts: result[key].ts };
  }
  return result;
}

// --- State building ---

/** Convert flat dot-notation FieldMap to a nested object. */
export function buildState<T = Record<string, any>>(fields: FieldMap): T {
  const obj: any = {};
  const created = new Set<any>([obj]);
  // Sorted so parent paths are assigned before their children.
  for (const key of Object.keys(fields).sort()) {
    const field = fields[key];
    if (field.val == null) continue;
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur[parts[i]];
      // Clone containers taken from field values so we never mutate stored fields,
      // and replace scalars so a child path can always be set.
      if (!created.has(next)) {
        next = next && typeof next === 'object' ? { ...next } : {};
        cur[parts[i]] = next;
        created.add(next);
      }
      cur = next;
    }
    cur[parts[parts.length - 1]] = field.val;
  }
  return obj as T;
}

/** Layer one unconfirmed field map on top of a result map (in place). */
function mergeFieldsInto(result: FieldMap, layer: FieldMap) {
  for (const [key, field] of Object.entries(layer)) {
    if (field.op === '#') {
      const base = result[key]?.val ? new Delta(result[key].val) : new Delta();
      result[key] = { op: '#', val: base.compose(new Delta(field.val)).ops, ts: field.ts };
    } else {
      if (field.op === '=' || field.op === '!') clearDescendants(result, key, field.ts);
      result[key] = mergeField(result[key], field);
    }
  }
}

/** Compute effective fields by layering confirmed + sending + pending. */
export function effectiveFields(confirmed: FieldMap, sending: FieldMap | null, pending: FieldMap): FieldMap {
  const result = { ...confirmed };
  const layers = sending ? [sending, pending] : [pending];
  for (const layer of layers) mergeFieldsInto(result, layer);
  return result;
}

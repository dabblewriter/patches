import { Delta } from '@dabble/delta';
import type { Field, FieldMap } from './types.js';
import { INC, BIT, TXT, MAX, parseSuffix } from './types.js';

// --- Bitmask operations (copied from patches) ---

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
  const aOff = (a >> 15) & 0x7fff, aOn = a & 0x7fff;
  const bOff = (b >> 15) & 0x7fff, bOn = b & 0x7fff;
  return (((aOff & ~bOn) | bOff) << 15) | ((aOn & ~bOff) | bOn);
}

// --- Utilities ---

/** Generate a random ID. */
export function generateId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// --- Field merge ---

/** Merge a single incoming field with an existing value, based on suffix type. */
export function mergeField(existing: Field | undefined, incoming: Field, suffix: string): Field {
  const ev = existing?.val ?? 0;
  switch (suffix) {
    case INC: return { val: ev + incoming.val, ts: incoming.ts };
    case BIT: return { val: applyBitmask(ev, incoming.val), ts: incoming.ts };
    case MAX: return incoming.val >= ev ? incoming : existing!;
    case TXT: return incoming; // text composed separately
    default: return incoming.ts >= (existing?.ts ?? 0) ? incoming : existing!;
  }
}

// --- Consolidation ---

/** Consolidate new ops into existing pending ops (client-side batching). */
export function consolidateOps(pending: FieldMap, newOps: FieldMap): FieldMap {
  const result = { ...pending };
  for (const [key, field] of Object.entries(newOps)) {
    const ex = result[key];
    if (!ex) { result[key] = field; continue; }
    const { suffix } = parseSuffix(key);
    switch (suffix) {
      case INC: result[key] = { val: ex.val + field.val, ts: field.ts }; break;
      case BIT: result[key] = { val: combineBitmasks(ex.val, field.val), ts: field.ts }; break;
      case MAX: result[key] = field.val >= ex.val ? field : ex; break;
      case TXT: result[key] = { val: new Delta(ex.val).compose(new Delta(field.val)).ops, ts: field.ts }; break;
      default: result[key] = field;
    }
  }
  return result;
}

// --- State building ---

/** Convert flat dot-notation FieldMap to a nested object. Strips suffixes from keys. */
export function buildState<T = Record<string, any>>(fields: FieldMap): T {
  const obj: any = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.val == null) continue;
    const { path } = parseSuffix(key);
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ??= {};
    cur[parts[parts.length - 1]] = field.val;
  }
  return obj as T;
}

/** Compute effective fields by layering confirmed + sending + pending. */
export function effectiveFields(confirmed: FieldMap, sending: FieldMap | null, pending: FieldMap): FieldMap {
  const result = { ...confirmed };
  const layers = sending ? [sending, pending] : [pending];
  for (const layer of layers) {
    for (const [key, field] of Object.entries(layer)) {
      const { suffix } = parseSuffix(key);
      if (suffix === TXT) {
        const base = result[key]?.val ? new Delta(result[key].val) : new Delta();
        result[key] = { val: base.compose(new Delta(field.val)).ops, ts: field.ts };
      } else {
        result[key] = mergeField(result[key], field, suffix);
      }
    }
  }
  return result;
}

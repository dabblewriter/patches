import { CompactPatchOp, JSONPatchOp, PatchSymbol } from '../types.js';

export const Compact = {
  /**
   * Validates a CompactPatchOp array
   */
  validate(ops: CompactPatchOp[]) {
    if (ops.length === 0) return true;
    return ops.every(op => Array.isArray(op) && typeof op[0] === 'string' && SYMBOL_TO_ACTION.has(op[0][0] as any));
  },

  /**
   * Checks if an array is already a CompactPatchOp array
   */
  is(ops: any): ops is CompactPatchOp[] {
    if (!Array.isArray(ops)) return false;
    if (ops.length === 0) return true;
    const firstOp = ops[0];
    return Array.isArray(firstOp) && typeof firstOp[0] === 'string' && SYMBOL_TO_ACTION.has(firstOp[0][0] as any);
  },

  /**
   * Converts an array of operations to CompactPatchOp format
   * If the input is already in CompactPatchOp format, it is returned as-is
   */
  to(ops: JSONPatchOp[] | CompactPatchOp[]): CompactPatchOp[] {
    return Compact.is(ops) ? ops : ops.map(jsonPatchOpToCompact);
  },

  /**
   * Converts an array of operations to JSONPatchOp format
   * If the input is already in JSONPatchOp format, it is returned as-is
   */
  from(ops: JSONPatchOp[] | CompactPatchOp[]): JSONPatchOp[] {
    return !Compact.is(ops) ? ops : ops.map(compactPatchOpToJSON);
  },

  /**
   * Returns the operation symbol for a given operation
   */
  getOp([first]: CompactPatchOp) {
    return first[0] as PatchSymbol;
  },

  /**
   * Returns the path for a given operation
   */
  getPath([first]: CompactPatchOp) {
    return first.slice(1);
  },

  /**
   * Returns the value for a given operation
   */
  getValue([first, value]: CompactPatchOp) {
    return fromOps.has(first[0]) ? undefined : value;
  },

  /**
   * Returns the from value for a given operation
   */
  getFrom([first, from]: CompactPatchOp): string {
    return fromOps.has(first[0]) ? from : undefined;
  },

  /**
   * Returns the soft value for a given operation
   */
  getSoft([, , soft]: CompactPatchOp) {
    return soft;
  },

  /**
   * Creates a new operation
   */
  create(op: string, path: string, valueOrFrom?: any, soft?: boolean): CompactPatchOp {
    const symbol = getOpSymbol(op);
    const compactOp: CompactPatchOp = [`${symbol}${path}`];
    if (valueOrFrom !== undefined) compactOp.push(valueOrFrom);
    if (soft) compactOp.push(1);
    return compactOp;
  },

  /**
   * Update an operation
   */
  update(op: CompactPatchOp, updates: Partial<JSONPatchOp>) {
    if (updates.op || updates.path) {
      op[0] = `${updates.op ? getOpSymbol(updates.op) : Compact.getOp(op)}${updates.path || Compact.getPath(op)}`;
    }
    if (updates.from || 'value' in updates) {
      op[1] = updates.from || updates.value;
    }
    return op;
  },
};

/**
 * Returns the symbol for a given operation name
 */
function getOpSymbol(op: string): PatchSymbol {
  if (!op || op.length === 1) return op as PatchSymbol;
  if (!ACTION_TO_SYMBOL.has(op)) throw new Error(`Unknown operation type: ${op}`);
  return ACTION_TO_SYMBOL.get(op)!;
}

// Cache for operation symbols to improve performance
const SYMBOL_TO_ACTION = new Map<PatchSymbol, string>([
  ['+', 'add'],
  ['=', 'replace'],
  ['-', 'remove'],
  ['>', 'move'],
  ['&', 'copy'],
  ['T', '@txt'],
  ['^', '@inc'],
  ['~', '@bit'],
]);

export const ACTION_TO_SYMBOL = new Map<string, PatchSymbol>([
  ['add', '+'],
  ['replace', '='],
  ['remove', '-'],
  ['move', '>'],
  ['copy', '&'],
  ['@changeText', 'T'],
  ['@txt', 'T'],
  ['@inc', '^'],
  ['@bit', '~'],
]);

export const fromOps = new Set(['move', 'copy', '>', '&']);

/**
 * Converts a JSONPatchOp to a CompactPatchOp
 */
function jsonPatchOpToCompact(patchOp: JSONPatchOp): CompactPatchOp {
  const { op, path, value, from, soft } = patchOp;
  const symbol = ACTION_TO_SYMBOL.get(op);
  if (!symbol) throw new Error(`Unknown operation type: ${op}`);

  if (symbol === '-') {
    return [`${symbol}${path}`];
  } else if (soft) {
    return [`${symbol}${path}`, from || value, 1];
  } else {
    return [`${symbol}${path}`, from || value];
  }
}

/**
 * Converts a CompactPatchOp to a JSONPatchOp
 */
function compactPatchOpToJSON(compactOp: CompactPatchOp): JSONPatchOp {
  const [opStr, value, soft] = compactOp;
  const symbol = opStr[0] as PatchSymbol;
  const op = SYMBOL_TO_ACTION.get(symbol);
  if (!op) throw new Error(`Invalid operation symbol: ${symbol}`);

  const path = opStr.slice(1);
  let jsonOp: JSONPatchOp = { op, path };
  if (fromOps.has(op)) jsonOp.from = value;
  else if (value !== undefined) jsonOp.value = value;
  if (soft) jsonOp.soft = true;
  return jsonOp;
}

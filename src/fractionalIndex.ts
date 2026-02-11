/**
 * Utilities for fractional indexing to sort documents by a string field instead of putting them in an array. This is
 * for use with the LastWriteWins algorithm provided by syncable.
 */
const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const INTEGER_ZERO = 'a0';
const SMALLEST_INTEGER = 'A00000000000000000000000000';
const LARGEST_INTEGER = 'zzzzzzzzzzzzzzzzzzzzzzzzzzz';
const ZERO = digits[0];

fractionalIndex.sort = sortByOrder;
fractionalIndex.heal = healDuplicateOrders;

/**
 * Generate a fractional index which is a sortable string(s) between a and b. Use an empty string or null/undefined to
 * represent the start and end of the range.
 *
 * Pass a count to generate N fractional indexes between a and b.
 *
 * See https://www.figma.com/blog/realtime-editing-of-ordered-sequences/#fractional-indexing and
 * https://observablehq.com/@dgreensp/implementing-fractional-indexing for more information.
 */
export function fractionalIndex(a: string | undefined | null, b: string | undefined | null): string;
export function fractionalIndex(a: string | undefined | null, b: string | undefined | null, count: number): string[];
export function fractionalIndex(
  a: string | undefined | null,
  b: string | undefined | null,
  count?: number
): string | string[] {
  // Generate N fractional indexes between a and b
  if (count !== undefined) {
    if (count === 0) {
      return [];
    }
    if (count === 1) {
      return [fractionalIndex(a, b)];
    }
    if (!b) {
      let c = fractionalIndex(a, b);
      const result = [c];
      for (let i = 0; i < count - 1; i++) {
        c = fractionalIndex(c, b);
        result.push(c);
      }
      return result;
    }
    if (!a) {
      let c = fractionalIndex(a, b);
      const result = [c];
      for (let i = 0; i < count - 1; i++) {
        c = fractionalIndex(a, c);
        result.push(c);
      }
      result.reverse();
      return result;
    }
    const mid = Math.floor(count / 2);
    const c = fractionalIndex(a, b);
    return [...fractionalIndex(a, c, mid), c, ...fractionalIndex(c, b, count - mid - 1)];
  }

  // Generate a fractional index between a and b
  if (a && b && a >= b) {
    [a, b] = [b, a];
  }
  if (!a && !b) {
    return INTEGER_ZERO;
  }
  if (a) {
    validatestring(a, true);
  }
  if (b) {
    validatestring(b, false);
  }
  if (!a) {
    const ib = getIntegerPart(b!);
    const fb = b!.slice(ib.length);
    if (ib === SMALLEST_INTEGER) {
      return ib + midpoint('', fb);
    }
    return ib < b! ? ib : decrementInteger(ib)!;
  }
  if (!b) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return !i ? ia + midpoint(fa, null) : i;
  }
  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) {
    return ia + midpoint(fa, fb);
  }
  const i = incrementInteger(ia);
  return i! < b ? i! : ia + midpoint(fa, null);
}

function midpoint(a: string | undefined | null, b: string | undefined | null): string {
  if (a && b && a >= b) {
    [a, b] = [b, a];
  }
  if ((a && a.slice(-1) === ZERO) || (b && b.slice(-1) === ZERO)) {
    throw new Error('Trailing zero');
  }
  if (!a) a = '';
  if (b) {
    let n = 0;
    while ((a[n] || ZERO) === b[n]) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
  }
  const digitA = a ? digits.indexOf(a[0]) : 0;
  const digitB = b ? digits.indexOf(b[0]) : digits.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return digits[midDigit];
  } else {
    if (b && b.length > 1) {
      return b.slice(0, 1);
    } else {
      return digits[digitA] + midpoint(a?.slice(1), null);
    }
  }
}

function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  } else if (head >= 'A' && head <= 'Z') {
    return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  } else {
    throw new Error('Invalid order key head: ' + head);
  }
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int[0])) {
    throw new Error('Invalid integer part of order key: ' + int);
  }
}

function incrementInteger(x: string): string {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) {
      digs[i] = ZERO;
    } else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') {
      return 'a0';
    }
    if (head === 'z') {
      return '';
    }
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') {
      digs.push(ZERO);
    } else {
      digs.pop();
    }
    return h + digs.join('');
  } else {
    return head + digs.join('');
  }
}

function decrementInteger(x: string): string {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = digits.slice(-1);
    } else {
      digs[i] = digits[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') {
      return 'Z' + digits.slice(-1);
    }
    if (head === 'A') {
      return '';
    }
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') {
      digs.push(digits.slice(-1));
    } else {
      digs.pop();
    }
    return h + digs.join('');
  } else {
    return head + digs.join('');
  }
}

function getIntegerPart(key: string): string {
  const integerPartLength = getIntegerLength(key[0]);
  if (integerPartLength > key.length) {
    throw new Error('Invalid order key: ' + key);
  }
  return key.slice(0, integerPartLength);
}

function validatestring(key: string, lowValue: boolean): void {
  if ((lowValue && key === LARGEST_INTEGER) || (!lowValue && key === SMALLEST_INTEGER)) {
    throw new Error('Invalid order key: ' + key);
  }
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.slice(-1) === ZERO) {
    throw new Error('Invalid order key: ' + key);
  }
}

/** Order field parameter type: field name, or false when values are order strings directly */
type OrderFieldParam = string | false;

function createOrderGetter<T>(orderField: OrderFieldParam): (value: T) => string {
  return orderField === false
    ? (value: T) => value as string
    : (value: T) => (value as Record<string, string>)[orderField];
}

/**
 * Sort a map of items by their fractional index order, with key as tiebreaker.
 *
 * @param items - Object keyed by ID. Values can be objects with an order field, or strings (the order itself).
 * @param orderField - The field name containing the order string (default: 'order'). Use false if values ARE the order strings.
 * @returns Array of [key, value] tuples sorted by order, then by key
 *
 * @example
 * // Objects with 'order' field (default)
 * const sorted = sortByOrder({ b: { order: 'a2' }, a: { order: 'a1' } });
 * // [['a', { order: 'a1' }], ['b', { order: 'a2' }]]
 *
 * @example
 * // Values are the order strings directly
 * const sorted = sortByOrder({ b: 'a2', a: 'a1' }, false);
 * // [['a', 'a1'], ['b', 'a2']]
 */
export function sortByOrder<T extends Record<string, unknown> | string>(
  items: Record<string, T>,
  orderField: OrderFieldParam = 'order'
): Array<[string, T]> {
  const getOrder = createOrderGetter<T>(orderField);
  return Object.entries(items).sort((a, b) => {
    const orderCmp = getOrder(a[1]).localeCompare(getOrder(b[1]));
    if (orderCmp !== 0) return orderCmp;
    return a[0].localeCompare(b[0]);
  });
}

/**
 * Detect duplicate `order` values and return fixes. Duplicates can occur when multiple
 * clients generate the same fractional index while offline (e.g., both appending to a list).
 *
 * This function does NOT mutate the input. Apply the returned fixes using your change API.
 *
 * @param items - Object keyed by ID. Values can be objects with an order field, or strings (the order itself).
 * @param orderField - The field name containing the order string (default: 'order'). Use false if values ARE the order strings.
 * @returns Map of key → new order string, or null if no duplicates found
 *
 * @example
 * // Objects with 'order' field (default)
 * const fixes = healDuplicateOrders({ a: { order: 'a1' }, b: { order: 'a1' } });
 * if (fixes) {
 *   doc.change((patch, root) => {
 *     for (const [key, newOrder] of Object.entries(fixes)) {
 *       patch.replace(root.items[key].order, newOrder);
 *     }
 *   });
 * }
 *
 * @example
 * // Objects with custom field name
 * const fixes = healDuplicateOrders({ a: { sortKey: 'a1' } }, 'sortKey');
 *
 * @example
 * // Values are the order strings directly
 * const fixes = healDuplicateOrders({ a: 'a1', b: 'a1' }, false);
 */
export function healDuplicateOrders<T extends Record<string, unknown> | string>(
  items: Record<string, T>,
  orderField: OrderFieldParam = 'order'
): Record<string, string> | null {
  const getOrder = createOrderGetter<T>(orderField);
  const fixes: Record<string, string> = {};
  const entries = sortByOrder(items, orderField);

  if (entries.length < 2) return null;

  // Track the effective previous order (may differ after fixes)
  let prevOrder = getOrder(entries[0][1]);

  for (let i = 1; i < entries.length; i++) {
    const [key, item] = entries[i];
    const currentOrder = getOrder(item);

    // Fix if current order is <= previous (duplicate or now out of order after a fix)
    if (currentOrder <= prevOrder) {
      // Find the next different order to use as upper bound
      let nextOrder: string | null = null;
      for (let j = i + 1; j < entries.length; j++) {
        const candidateOrder = getOrder(entries[j][1]);
        if (candidateOrder > prevOrder) {
          nextOrder = candidateOrder;
          break;
        }
      }
      const newOrder = fractionalIndex(prevOrder, nextOrder);
      fixes[key] = newOrder;
      prevOrder = newOrder;
    } else {
      prevOrder = currentOrder;
    }
  }

  return Object.keys(fixes).length > 0 ? fixes : null;
}

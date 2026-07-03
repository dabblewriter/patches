import type { Change } from '../../src/types.js';

/**
 * Simulate a wire hop: JSON round-trip a value. Every client↔server boundary in the fuzz
 * harness clones through this so in-process object sharing can't hide (or cause) mutation
 * bugs — `commitChanges` mutates the incoming change objects, and stores hand out internal
 * references. Also matches production fidelity: `undefined` props drop, class instances
 * (e.g. Delta) collapse to plain JSON.
 */
export function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Drain a ReadableStream<string> (the server getDoc envelope) into a string. */
export async function readAll(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

/**
 * Normalize a state object for deep-equality: JSON round-trip so Delta instances,
 * undefined props, and prototype differences can't produce false mismatches between a
 * client that applied changes in memory and one that hydrated from a serialized snapshot.
 */
export function norm(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Canonical JSON: object keys sorted recursively, so states that differ only in property
 * insertion order (e.g. a client that applied fields in delivery order vs a server that
 * rebuilt them path-sorted) compare equal. Insertion order is not part of the convergence
 * contract for JSON documents.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(norm(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Compact single-line description of a batch of changes, for action traces. */
export function describeChanges(changes: Change[]): string {
  if (changes.length === 0) return '(none)';
  const revs =
    changes.length === 1 ? `rev ${changes[0].rev}` : `revs ${changes[0].rev}-${changes[changes.length - 1].rev}`;
  const ops = changes.flatMap(c => c.ops.map(op => `${op.op} ${op.path || "''"}`));
  const shown = ops.slice(0, 4).join(', ') + (ops.length > 4 ? `, +${ops.length - 4} more` : '');
  return `${revs} [${shown}]`;
}

import { PRNG } from './prng.js';

/**
 * Substrate fault injection for the convergence fuzz harnesses (Phase 3).
 *
 * The protocol-level fault knobs (drop/dup/reorder/lost legs) exercise message
 * chaos over a PERFECT substrate — stores that never fail, transactions that
 * always commit. Real incidents live one layer down: IndexedDB transactions
 * abort, Firestore rejects under contention (the gRPC-10 class), a write dies
 * between the ack and the persist. Every one of this week's review-caught bugs
 * (LWW rev-stamp backend contract, the seenChangeIds TOCTOU, rollback on
 * ambiguous timeout) was a substrate-contract bug nothing injected.
 *
 * These wrappers make named methods on a store/backend fail with a seeded
 * probability, BEFORE the method mutates anything — modeling the all-or-nothing
 * abort semantics of IndexedDB transactions and Firestore transactions (a
 * partial in-memory mutation would model a failure mode the real substrates
 * cannot produce). The harness catches {@link InjectedFault} at each call site
 * and mirrors what production does there: keep-and-retry at the mint path
 * (#85), retry-on-a-later-flush at the commit path (PatchesSync ladder),
 * gap-resync after a failed broadcast apply.
 *
 * Determinism: faults draw from their OWN seeded PRNG, not the scheduler's —
 * the action script for a seed stays draw-aligned with its faults-off run
 * until a fault actually diverges control flow, which makes fault findings far
 * easier to minimize against their clean baseline.
 */

/** Marker error for an injected substrate fault — call sites match on this class. */
export class InjectedFault extends Error {
  constructor(method: string) {
    super(`injected substrate fault: ${method}`);
    this.name = 'InjectedFault';
  }
}

export function isInjectedFault(error: unknown): error is InjectedFault {
  return error instanceof InjectedFault;
}

export interface FaultInjector {
  /** Live switch — quiesce turns faults off so runs always drain. */
  active: boolean;
  /** Seeded roll for one intercepted call. */
  shouldFail(p: number): boolean;
}

export function createFaultInjector(seed: number): FaultInjector {
  const rng = new PRNG((seed ^ 0x0fa17) >>> 0);
  return {
    active: true,
    shouldFail(p: number): boolean {
      return p > 0 && rng.chance(p);
    },
  };
}

/**
 * Wrap `target` so each method named in `failableMethods` rejects with
 * {@link InjectedFault} (before delegating — nothing mutates on a fault) with
 * probability `p` while the injector is active. `p === 0` returns the target
 * untouched, so existing seeds' runs are byte-identical when the knob is off.
 */
export function withInjectedFaults<T extends object>(
  target: T,
  failableMethods: readonly (keyof T & string)[],
  injector: FaultInjector,
  p: number,
  onFault?: (method: string) => void
): T {
  if (p <= 0) return target;
  const failable = new Set<string>(failableMethods);
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof prop !== 'string' || !failable.has(prop) || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(obj) : value;
      }
      return (...args: unknown[]) => {
        if (injector.active && injector.shouldFail(p)) {
          onFault?.(prop);
          return Promise.reject(new InjectedFault(prop));
        }
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

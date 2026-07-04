/**
 * Convergence fuzz suite v1 — property-based, deterministic, pure in-memory.
 *
 * WHAT THIS DOES
 * --------------
 * From a numeric seed, a scheduler generates and executes a script of interleaved actions
 * against N simulated clients and a real server:
 *
 * - OT: OTAlgorithm + OTInMemoryStore + OTDoc per client, against OTServer over an
 *   in-memory OTStoreBackend (tests/fuzz/otFuzzBackend.ts).
 * - LWW: LWWAlgorithm + LWWInMemoryStore + LWWDoc per client, against LWWServer over the
 *   real LWWMemoryStoreBackend.
 *
 * Actions: client edits (a realistic op mix for a text-ish doc — @txt delta inserts and
 * deletes, add/remove/replace on nested object paths, array ops, occasional moves; for LWW
 * a settings-ish mix including @inc), flushes, broadcast deliveries with fault injection
 * (DELAY + REORDER via random inbox picks, DUPLICATION, DROP-then-resync via the
 * MissingChangesError → getChangesSince recovery path), lost commit request/response legs
 * (exercising the id-based idempotent retry), client disconnect/reconnect (offline batches
 * accumulate, then flush through the offline-session server paths), mid-stream doc reloads
 * (the PatchesSync._reloadDocFromServer flow), and time jumps that cross the session
 * timeout so session-gap and count-based versioning fire mid-run.
 *
 * After the script, the harness QUIESCES (reconnect all, deliver everything, flush
 * everything, final catch-up) and asserts the core convergence properties:
 *
 *   P1  every client's committed state (and live doc state) deep-equals the server's head
 *       state — for OT, the head is independently cross-checked between a full change-log
 *       replay and the version-snapshot read path;
 *   P2  no pending changes remain anywhere;
 *   P3  (OT) every locally-minted change id appears in the server change log EXACTLY once,
 *       or was provably rebased away to a no-op — no silent drops, no duplicates;
 *   P4  (OT) the server change log is contiguous (revs 1..N).
 *
 * DETERMINISM
 * -----------
 * Given a seed, behavior is byte-identical:
 * - all randomness flows through one mulberry32 PRNG (tests/fuzz/prng.ts);
 * - the clock is fake (vi.useFakeTimers) and advanced only by seeded increments;
 * - the `crypto-id` package (change/version ids) is mocked with a deterministic counter
 *   (tests/fuzz/deterministicIds.ts), reset at the start of every run.
 *
 * ON FAILURE
 * ----------
 * The failing test prints the seed, the derived config, the full action script (every edit,
 * flush, delivery, fault, disconnect, reload — in order), and a one-line repro:
 *
 *   FUZZ_ALGO=ot  FUZZ_SEED=<seed> npm test -- tests/fuzz/convergence.spec.ts
 *   FUZZ_ALGO=lww FUZZ_SEED=<seed> npm test -- tests/fuzz/convergence.spec.ts
 *
 * CI SHAPE
 * --------
 * The fixed panel below (25 OT seeds + 10 LWW seeds) runs as part of the normal suite and
 * must always pass. For deeper local/nightly runs there is an opt-in soak:
 *
 *   FUZZ_ITERATIONS=500 npm test -- tests/fuzz/convergence.spec.ts            # OT soak
 *   FUZZ_ALGO=lww FUZZ_ITERATIONS=500 npm test -- tests/fuzz/convergence.spec.ts
 *   FUZZ_ITERATIONS=500 FUZZ_SEED=42000 npm test -- tests/fuzz/convergence.spec.ts
 *
 * (soak seeds are FUZZ_SEED..FUZZ_SEED+N-1, default base 1000000). A found bug should be
 * captured as a pinned `it.skip` with its seed and divergence notes, not fixed in the same
 * PR as fuzzer changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import process from 'node:process';
import { resetDeterministicIds } from './deterministicIds.js';
import { LWWFuzzHarness, type LWWFuzzConfig } from './lwwFuzzHarness.js';
import { OTFuzzHarness, type OTFuzzConfig } from './otFuzzHarness.js';
import { PRNG } from './prng.js';

vi.mock('crypto-id', async () => (await import('./deterministicIds.js')).cryptoIdMock);

// ─── Config derivation: one seed fully defines a run ────────────────────────

function otConfigFromSeed(seed: number): OTFuzzConfig {
  const rng = new PRNG((seed ^ 0xa5a5a5a5) >>> 0);
  const cfg: OTFuzzConfig = {
    seed,
    clients: rng.intBetween(2, 4),
    actions: rng.intBetween(80, 200),
    dropP: rng.pick([0, 0.05, 0.15]),
    dupP: rng.pick([0, 0.05, 0.15]),
    reorderP: rng.pick([0, 0.1, 0.25]),
    lostResponseP: rng.pick([0, 0.03, 0.08]),
    lostRequestP: rng.pick([0, 0.03, 0.08]),
    maxChangesPerVersion: rng.pick([0, 10, 30, 1000]),
    sessionTimeoutMinutes: rng.pick([1, 5, 30]),
    // FINDING-1 (fixed): the rebase walks' advance direction now resolves conflicting
    // intents toward the later writer (transformPatch's `otherOpsFirst`), so concurrent
    // moves converge and move ops are back in the panel mix.
    moveOps: true,
    // DAB-601: richer edit mix (compound move+array changes, copies, nested containers) —
    // a CONSTANT, not an rng.pick: drawing here would shift the config-derivation sequence
    // and change every existing seed's derived knobs. OFF until the class it exposes is
    // fixed: ~6% of rich-mix seeds commit a compound change whose move source a concurrent
    // commit consumed (surfacing as "[op:add] require value" from move.apply's pluck) — the
    // FINDING-1 family reached through multi-op changes. See OT_RICH_PANEL_SEEDS for the CI
    // coverage that stays on, and the NEW-FINDING skip for the repro.
    richOps: false,
    // Phase 3 substrate faults (see faultInjection.ts) — CONSTANTS for the same reason as
    // richOps: a draw here would shift every existing seed's derived knobs. Off in derived
    // configs; exercised by the fault panel below and the FUZZ_FAULTS=1 soak modifier.
    clientStoreFailP: 0,
    serverBackendFailP: 0,
  };
  // FINDING-3 (fixed): commitChanges now excludes the sender's own committed echoes (matched
  // by id, mirroring the batchId exclusion) from the transform set, so lost commit responses
  // are back in the panel mix.
  return cfg;
}

function lwwConfigFromSeed(seed: number): LWWFuzzConfig {
  const rng = new PRNG((seed ^ 0x5a5a5a5a) >>> 0);
  const cfg: LWWFuzzConfig = {
    seed,
    clients: rng.intBetween(2, 4),
    actions: rng.intBetween(80, 200),
    // FINDING-7 (fixed): dropped broadcasts are detected as a rev gap (a batch whose
    // baseRev is ahead of committedRev throws MissingChangesError → getChangesSince
    // recovery, mirroring OT), so drops are back in the panel mix.
    dropP: rng.pick([0, 0.05, 0.15]),
    dupP: rng.pick([0, 0.05, 0.1]),
    lostResponseP: rng.pick([0, 0.03, 0.08]),
    lostRequestP: rng.pick([0, 0.03, 0.08]),
    // FINDING-2 (fixed): a stale broadcast (rev already covered by committedRev) is now
    // skipped wholesale by LWWAlgorithm.applyServerChanges, so the un-drained ordering —
    // a queued broadcast applied after a newer commit response, production's blockable-
    // receive window — is safe; both orderings are fuzzed.
    drainInboxBeforeFlush: rng.pick([true, false]),
    // FINDING-4/FINDING-6 (fixed): the commit response now echoes the server's stored
    // resolution for every sent path and its surviving children (and the doc merge
    // shields subtrees under a local parent write), so parent/child write races converge
    // and parent replaces are back in the edit mix.
    parentOps: true,
  };
  return cfg;
}

// ─── Runners ─────────────────────────────────────────────────────────────────

function printFailure(algo: string, seed: number, cfg: object, trace: string[], err: unknown): void {
  const lines = [
    '',
    `═══ CONVERGENCE FUZZ FAILURE (${algo}) ═══`,
    `Seed:   ${seed}`,
    `Config: ${JSON.stringify(cfg)}`,
    `Repro:  FUZZ_ALGO=${algo.toLowerCase()} FUZZ_SEED=${seed} npm test -- tests/fuzz/convergence.spec.ts`,
    `Error:  ${err instanceof Error ? err.message : String(err)}`,
    'Action script:',
    ...trace.map(line => `  ${line}`),
    '═══ END FUZZ FAILURE ═══',
    '',
  ];
  console.error(lines.join('\n'));
}

async function runOTFuzz(seed: number, overrides: Partial<OTFuzzConfig> = {}): Promise<void> {
  resetDeterministicIds();
  const cfg = { ...otConfigFromSeed(seed), ...overrides };
  const harness = new OTFuzzHarness(new PRNG(seed), cfg);
  try {
    await harness.run();
    await harness.assertConverged();
  } catch (err) {
    printFailure('OT', seed, cfg, harness.trace, err);
    throw err;
  }
}

async function runLWWFuzz(seed: number, overrides: Partial<LWWFuzzConfig> = {}): Promise<void> {
  resetDeterministicIds();
  const cfg = { ...lwwConfigFromSeed(seed), ...overrides };
  const harness = new LWWFuzzHarness(new PRNG(seed), cfg);
  try {
    await harness.run();
    await harness.assertConverged();
  } catch (err) {
    printFailure('LWW', seed, cfg, harness.trace, err);
    throw err;
  }
}

// ─── Shared setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  // Expected, benign warnings (e.g. OTAlgorithm's baseRev re-stamp notice on the
  // reload-with-pending path) would otherwise flood the output on long runs.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── CI panel: fixed seeds, must always pass, fast ───────────────────────────

const OT_PANEL_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];

const LWW_PANEL_SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];

// Substrate-fault CI coverage (Phase 3): screened-green seeds run with store/backend fault
// injection armed (see faultInjection.ts) so the fault paths stay exercised while faults are
// off in derived configs. Two of these seeds are fixed findings, kept as regressions:
// - 1000126/1000212/1000228/1000275: reconcilePending's drop-then-save loss (P3
//   silent-loss), fixed by the atomic pending replacement (#89).
// - 1000319: duplicate commit (P3) — the torn-reload window plus the id-blind doc/store
//   pending merge let a rebased resend sail past the server's baseRev-scoped dedup;
//   fixed by the single-transaction reconcile + id-aware merge (#91).
const OT_FAULT_PANEL_SEEDS = [
  1000000, 1000001, 1000002, 1000126, 1000212, 1000228, 1000275, 1000319, 1000003, 1000004, 1000005,
];

// Rich-mix CI coverage (DAB-601): screened-green seeds run the extended edit mix (compound
// move+array changes, copy ops, nested containers) so the new kinds stay exercised while
// `richOps` is off in derived configs (see otConfigFromSeed).
const OT_RICH_PANEL_SEEDS = [1000000, 1000001, 1000002, 1000003, 1000004, 1000005, 1000006, 1000007, 1000008, 1000009];

describe('convergence fuzz — OT panel', () => {
  for (const seed of OT_PANEL_SEEDS) {
    it(`converges (seed ${seed})`, async () => {
      await runOTFuzz(seed);
    }, 30_000);
  }

  for (const seed of OT_RICH_PANEL_SEEDS) {
    it(`converges with the rich edit mix (seed ${seed})`, async () => {
      await runOTFuzz(seed, { richOps: true });
    }, 30_000);
  }

  for (const seed of OT_FAULT_PANEL_SEEDS) {
    it(`converges under substrate faults (seed ${seed})`, async () => {
      await runOTFuzz(seed, { clientStoreFailP: 0.04, serverBackendFailP: 0.04 });
    }, 30_000);
  }

  // NEW-FINDING (post-torn-reload-fix soak): the transform-layer consumed-source class is
  // reachable WITHOUT the rich mix — a chain of plain single-op `move` changes inside one
  // offline batch (session-timeout path), transformed against concurrent commits, produces a
  // committed move whose source an earlier leg consumed. Fails strict apply on delivery as
  // "[op:add] require value, but got undefined" — the same family as the seed-10 compound
  // pin above, via a different mint shape, so fixing the compound case must cover chained
  // batches too. Repro: FUZZ_FAULTS=1 FUZZ_SEED=1000393 FUZZ_ITERATIONS=1 (faults only
  // shape the interleaving; the poison commit itself is the server transform's).
  it.skip('NEW-FINDING: chained offline-batch moves commit a consumed-source move (seed 1000393, faults)', async () => {
    await runOTFuzz(1000393, { clientStoreFailP: 0.04, serverBackendFailP: 0.04 });
  }, 30_000);

  // NEW-FINDING (DAB-601 harness extension, day one): with the rich mix on, ~6% of soak
  // seeds commit a compound change whose `move` source a concurrent commit already consumed.
  // Strict replay fails inside move.apply — the plucked source is undefined and surfaces as
  // "[op:add] require value, but got undefined" from the move's internal add. PRE-EXISTING
  // (reproduces with the DAB-601 src fixes stashed); the single-op mix could never mint the
  // shape. Pinned per the suite convention (found bugs are pinned, not fixed, in the PR that
  // changes the fuzzer). More repro seeds: 1000017, 1000021, 1000025 (+56 more per 1000).
  it.skip('NEW-FINDING: compound move with consumed source commits and wedges strict replay (seed 10, rich mix)', async () => {
    await runOTFuzz(10, { richOps: true });
  }, 30_000);

  // FINDING-1 regression (fixed): a client's `move` whose source path was concurrently
  // moved/removed used to be committed pointing at a path that no longer existed, producing
  // a committed change that failed strict apply on every replay. Root cause: the OT diamond
  // walks advance a committed change through the local queue with the transform arguments
  // swapped relative to real time, so each side let ITS later op win the same-path conflict
  // and the two halves disagreed. transformPatch's `otherOpsFirst` now resolves those
  // conflicts toward the later writer in the advance direction (same-source moves, same-path
  // sets, and sets clobbering a move's source — which also ghost-kill the move destination).
  it('FINDING-1 regression: concurrent move/remove converges (seed 4)', async () => {
    await runOTFuzz(4, { moveOps: true, richOps: false });
  }, 60_000);

  // FINDING-3 regression (fixed): a client flushed [A], the server committed A but the
  // response was lost; the client kept editing (B, C minted on top of pending A) and later
  // re-flushed [A, B, C]. Without a batchId, commitChanges deduped A by id from the incoming
  // set but left A's committed copy in the transform set, so B and C were rebased against
  // the client's own echo of A — whose effects their frames already included — double-
  // shifting array/text ops. The transform set now excludes committed changes matching the
  // incoming request's change ids (mirroring the batchId exclusion), keeping the server walk
  // in lockstep with the client's rebaseChanges. (moveOps pinned to the repro-era mix so the
  // seed's action script stays byte-identical to the original finding.)
  it('FINDING-3 regression: lost-response retry converges (seed 10)', async () => {
    await runOTFuzz(10, { lostResponseP: 0.03, moveOps: false, richOps: false });
  }, 60_000);

  // FINDING-5 regression (fixed): the reload flow (PatchesSync._reloadDocFromServer)
  // reconciled pending only against committed changes up to the getDoc envelope's rev — the
  // LAST VERSION's rev — while saveDoc installed the envelope's tail through the server
  // HEAD as committed. committedRev jumped to head, catch-up never redelivered
  // (versionRev, head], and un-rebased pending crashed doc.import (ApplyChangesError
  // crash-loop) or landed at stale offsets. The reconcile window now extends through the
  // envelope's last installed change. (Repro-era knobs pinned: the seed came from a soak
  // run with moves and lost responses excluded.)
  it('FINDING-5 regression: reload with pending rebases against the whole installed envelope tail (seed 1000035)', async () => {
    await runOTFuzz(1000035, { moveOps: false, lostResponseP: 0, richOps: false });
  }, 60_000);
});

describe('convergence fuzz — LWW panel', () => {
  for (const seed of LWW_PANEL_SEEDS) {
    it(`converges (seed ${seed})`, async () => {
      await runLWWFuzz(seed);
    }, 30_000);
  }

  // FINDING-2 regression (fixed): a broadcast emitted at rev N can still be queued/in-flight
  // when the same client's commit for rev N+1 returns; LWW client stores applied committed
  // fields unconditionally per path, so the late rev-N ops overwrote newer rev-N+1 values
  // and committedRev (already at N+1) meant no catch-up ever healed it. Production hits the
  // window because broadcasts and commit responses travel on different channels, and
  // PatchesSync's blockable receive defers — but does not reorder — a broadcast arriving
  // mid-flush. LWWAlgorithm.applyServerChanges now skips a batch whose rev is already
  // covered by committedRev wholesale (commit responses stay exempt, recognized by the
  // change ids confirmSent recorded: their corrections legitimately carry old revs).
  // (Repro-era knobs pinned so the seed's action script stays byte-identical; verified to
  // fail with the guard reverted.)
  it('FINDING-2 regression: stale broadcast after commit response is skipped (seed 102)', async () => {
    await runLWWFuzz(102, { dropP: 0, drainInboxBeforeFlush: false, parentOps: true });
  }, 60_000);

  // FINDING-4 regression (fixed): a client's parent write (replace /counters) racing a
  // newer committed child write left the OPEN DOC disagreeing with its own store — the
  // commit response filtered the sent path, so nothing corrected the doc after the server
  // resolved the race (the doc had meanwhile applied the foreign child op on top of its
  // optimistic parent). Fixed from both ends: mergeServerWithLocal shields subtrees under
  // a local parent write, and the commit response echoes the server's stored resolution
  // for every sent path (LWWDoc's echo keys ignore the server-stamped rev so those echoes
  // still register as pure echoes when nothing changed).
  // (Repro-era knobs pinned so the seed's action script stays byte-identical. This is a
  // LEG-level pin: it fails with the whole LWW fix stack reverted — the exact F4 shape,
  // "c2 live doc state diverged from server" — but passes with only the F4/F6 commit
  // reverted because the F2 stale guard happens to heal this particular script.
  // Per-commit discrimination for F4/F6 lives in the mergeServerWithLocal.spec and
  // LWWServer.spec unit pins.)
  it('FINDING-4 regression: open doc converges with its store after a parent/child race (seed 100)', async () => {
    await runLWWFuzz(100, { dropP: 0, drainInboxBeforeFlush: true, parentOps: true });
  }, 60_000);

  // FINDING-6 regression (fixed): a parent write that LOSES to a newer stored parent used
  // to prune a surviving newer child row permanently — the client had /counters/streak
  // (rev 26) committed, flushed its own replace /counters, and the response's catchup
  // filter dropped the child as "child of a sent path" while confirmSent's optimistic
  // prune removed it locally; with committedRev already past 26 nothing redelivered it.
  // The response now echoes the post-commit stored rows for sent paths AND their
  // surviving children, in commit order, so the correction rebuilds parent + children.
  // (Repro-era knobs pinned so the seed's action script stays byte-identical; verified to
  // fail without the sent-path echo commit.)
  it('FINDING-6 regression: rejected parent write keeps surviving newer children (seed 1000069)', async () => {
    await runLWWFuzz(1000069, { dropP: 0, drainInboxBeforeFlush: true, parentOps: true });
  }, 60_000);

  // FINDING-7 regression (fixed): a dropped broadcast was permanently lost once a later
  // broadcast advanced committedRev past it — LWW had no contiguity check (OT throws
  // MissingChangesError and pulls the tail). LWWAlgorithm.applyServerChanges now throws
  // MissingChangesError when a batch's baseRev is ahead of committedRev; PatchesSync's
  // existing recovery (syncDoc → getChangesSince) fills the gap, and the harness mirrors
  // that in deliver(). This is the plain SSE-event-loss scenario (no reconnect).
  // (Repro-era knobs pinned so the seed's action script stays byte-identical — this
  // variant produces real drops and gap recoveries, and fails P1 with the guard
  // reverted; the seed-derived knobs at HEAD produce a script with zero drops.)
  it('FINDING-7 regression: dropped broadcast triggers gap recovery (seed 104)', async () => {
    await runLWWFuzz(104, { dropP: 0.15, parentOps: false, drainInboxBeforeFlush: true });
  }, 60_000);
});

// ─── Opt-in repro + soak (see header) ────────────────────────────────────────

const FUZZ_SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined;
const FUZZ_ITERATIONS = process.env.FUZZ_ITERATIONS ? Number(process.env.FUZZ_ITERATIONS) : 0;
const FUZZ_ALGO = (process.env.FUZZ_ALGO ?? 'ot').toLowerCase();

describe.runIf(FUZZ_SEED !== undefined && FUZZ_ITERATIONS === 0)('convergence fuzz — seed repro', () => {
  it(`replays ${FUZZ_ALGO} seed ${FUZZ_SEED}`, async () => {
    expect(Number.isFinite(FUZZ_SEED)).toBe(true);
    if (FUZZ_ALGO === 'lww') await runLWWFuzz(FUZZ_SEED!);
    else await runOTFuzz(FUZZ_SEED!);
  }, 60_000);
});

// FUZZ_FAULTS=1 runs the soak with substrate faults armed (OT only for now — the LWW
// harness gets the same treatment in a follow-up). Rates are deliberately low: a fault
// on ~1 in 25 substrate calls perturbs plenty of flushes/applies per run without
// starving the scenario of successful traffic.
const FUZZ_FAULTS = process.env.FUZZ_FAULTS === '1';
const FAULT_OVERRIDES = { clientStoreFailP: 0.04, serverBackendFailP: 0.04 };

describe.runIf(FUZZ_ITERATIONS > 0)('convergence fuzz — soak', () => {
  const base = FUZZ_SEED ?? 1_000_000;
  for (let i = 0; i < FUZZ_ITERATIONS; i++) {
    const seed = base + i;
    it(`soak ${FUZZ_ALGO} seed ${seed}${FUZZ_FAULTS ? ' (faults)' : ''}`, async () => {
      if (FUZZ_ALGO === 'lww') await runLWWFuzz(seed);
      else await runOTFuzz(seed, FUZZ_FAULTS ? FAULT_OVERRIDES : {});
    }, 60_000);
  }
});

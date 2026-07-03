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
    dropP: rng.pick([0, 0.05, 0.15]),
    dupP: rng.pick([0, 0.05, 0.1]),
    lostResponseP: rng.pick([0, 0.03, 0.08]),
    lostRequestP: rng.pick([0, 0.03, 0.08]),
    drainInboxBeforeFlush: true, // FINDING-2 — un-drained ordering diverges; see below
    parentOps: false, // FINDING-4/FINDING-6 — parent/child write races diverge; see below
  };
  // FINDING-7 — a dropped broadcast is unrecoverable once a later broadcast advances
  // committedRev past it (LWW has no gap detection); excluded from the passing panel.
  // (Disconnect/reconnect windows still exercise missed-event recovery — committedRev
  // does not advance while offline, so reconnect catch-up covers those.)
  cfg.dropP = 0;
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

describe('convergence fuzz — OT panel', () => {
  for (const seed of OT_PANEL_SEEDS) {
    it(`converges (seed ${seed})`, async () => {
      await runOTFuzz(seed);
    }, 30_000);
  }

  // FINDING-1 regression (fixed): a client's `move` whose source path was concurrently
  // moved/removed used to be committed pointing at a path that no longer existed, producing
  // a committed change that failed strict apply on every replay. Root cause: the OT diamond
  // walks advance a committed change through the local queue with the transform arguments
  // swapped relative to real time, so each side let ITS later op win the same-path conflict
  // and the two halves disagreed. transformPatch's `otherOpsFirst` now resolves those
  // conflicts toward the later writer in the advance direction (same-source moves, same-path
  // sets, and sets clobbering a move's source — which also ghost-kill the move destination).
  it('FINDING-1 regression: concurrent move/remove converges (seed 4)', async () => {
    await runOTFuzz(4, { moveOps: true });
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
    await runOTFuzz(10, { lostResponseP: 0.03, moveOps: false });
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
    await runOTFuzz(1000035, { moveOps: false, lostResponseP: 0 });
  }, 60_000);
});

describe('convergence fuzz — LWW panel', () => {
  for (const seed of LWW_PANEL_SEEDS) {
    it(`converges (seed ${seed})`, async () => {
      await runLWWFuzz(seed);
    }, 30_000);
  }
});

// ─── FINDINGS: real divergences found by this fuzzer ─────────────────────────
//
// Pinned repros for engine bugs the fuzzer surfaced. Each is skipped (this suite must land
// green and engine fixes belong in their own PRs) and excluded from the passing panel via
// the config knobs noted below. Un-skip to reproduce; the failure prints the full action
// script.

describe('convergence fuzz — findings (pinned repros, skipped)', () => {
  // FINDING-2 (LWW, stale broadcast after commit response): a broadcast emitted at rev N can
  // still be queued/in-flight when the same client's commit for rev N+1 returns. LWW client
  // stores apply committed fields unconditionally per path (no rev/ts comparison across
  // batches), so the late rev-N ops overwrite newer rev-N+1 field values, and the client's
  // committedRev (already at N+1) means no later catch-up ever heals it (seed 102: c2 keeps
  // a /flags/focus value the server has removed). Production hits this window because
  // broadcasts and commit responses travel on different channels, and PatchesSync's
  // blockable receive defers — but does not reorder — a broadcast that arrives mid-flush.
  // Panel knob: drainInboxBeforeFlush: true. (The pinned repro also sets parentOps: true —
  // seed 102 with drainInboxBeforeFlush: false alone converges; this seed's script only
  // opens the stale-broadcast window on the parent/child paths.)
  it.skip('FINDING-2: stale broadcast applied after commit response regresses LWW fields (seed 102)', async () => {
    await runLWWFuzz(102, { drainInboxBeforeFlush: false, parentOps: true });
  }, 60_000);

  // FINDING-4 (LWW, open doc vs store after a parent/child conflict): client c2 writes a
  // parent path (replace /counters) while another client's newer child write
  // (/counters/words) is committed concurrently. The server folds the newer child value
  // into c2's committed parent op (server and c2's STORE both converge on the folded
  // value), but c2's OPEN DOC never applies the folded value: the commit response filters
  // /counters as a just-sent path, and the folded op carries c2's own path+ts so the doc's
  // echo tracking treats it as the already-applied optimistic op and skips it. The open doc
  // then disagrees with its own store (doc counters.words=10, store/server=824 in this run)
  // with no pending work and matching committedRev — permanent until the doc is reloaded.
  // Panel knob: parentOps: false.
  it.skip('FINDING-4: LWW open doc diverges from its own store after parent/child conflict (seed 100)', async () => {
    await runLWWFuzz(100, { parentOps: true });
  }, 60_000);

  // FINDING-6 (LWW, rejected parent write prunes a surviving child): needs NO network
  // faults — just a parent write racing a newer child write. c1 has already received the
  // committed child op (/counters/streak = 2, rev 26) via broadcast. c1 then flushes its
  // own replace /counters, which LOSES to the server's newer parent (rev 25) — the commit
  // response carries the stored parent as a correction op, but the catchup filter drops
  // the rev-26 child ("ops the client just sent and their children"). Applying the parent
  // correction prunes /counters/streak from c1's committed fields (parent writes delete
  // child entries), and with committedRev already at 27 no catch-up ever redelivers rev 26:
  // c1 permanently shows streak=0 while the server (and every other client) has streak=2.
  // The correction path needs to echo surviving newer children along with a rejected
  // parent, or not filter children of sent-but-rejected paths.
  // Panel knob: parentOps: false.
  it.skip('FINDING-6: LWW rejected parent write permanently drops a newer child value (seed 1000069)', async () => {
    await runLWWFuzz(1000069, { parentOps: true });
  }, 60_000);

  // FINDING-7 (LWW, dropped broadcast is permanently lost — no gap detection): c3's
  // transport drops the rev-9 broadcast carrying `remove /flags/spellcheck`, then applies
  // the rev-10 broadcast — the LWW client store advances committedRev to 10 with no
  // contiguity check (OT throws MissingChangesError here and pulls the tail; LWW has no
  // equivalent), so every later catch-up asks for changes since >= 10 and the rev-9 remove
  // is never redelivered. c3 keeps /flags/spellcheck forever unless some client writes
  // that exact path again. This is the plain SSE-event-loss scenario (no reconnect), and
  // it needs either gap detection on broadcast revs or rev-floor tracking below the last
  // contiguous rev.
  // Panel knob: dropP forced to 0 for LWW.
  it.skip('FINDING-7: LWW dropped broadcast permanently loses a remove (seed 104)', async () => {
    await runLWWFuzz(104, { dropP: 0.15 });
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

describe.runIf(FUZZ_ITERATIONS > 0)('convergence fuzz — soak', () => {
  const base = FUZZ_SEED ?? 1_000_000;
  for (let i = 0; i < FUZZ_ITERATIONS; i++) {
    const seed = base + i;
    it(`soak ${FUZZ_ALGO} seed ${seed}`, async () => {
      if (FUZZ_ALGO === 'lww') await runLWWFuzz(seed);
      else await runOTFuzz(seed);
    }, 60_000);
  }
});

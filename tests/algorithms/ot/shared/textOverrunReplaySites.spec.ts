import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every replay of a document's own committed log must decide `@txt` overrun padding by the
 * caller's rule, not a hardcoded one.
 *
 * This exists because three review rounds each found the same class of fault: the decision is
 * hand-wired at N call sites, the sites are found by grep, and so the invariant lived in
 * reviewers' heads rather than in the suite. These are deliberately source-level assertions —
 * the thing worth catching is a NEW replay site added without the option, which no behavioural
 * test of the existing sites can see.
 */

const SRC = join(import.meta.dirname, '../../../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const rel = (file: string) => file.slice(SRC.length + 1).replaceAll('\\', '/');

/** Files allowed to reconstruct a committed log, and why each one is safe. */
const KNOWN_REPLAY_SITES = [
  // Takes the caller's whole ReconstructionOptions and threads it down, including the gap-bridge
  // and full-history fallbacks.
  'algorithms/ot/server/buildVersionState.ts',
  // Thin wrapper over the above; forwards options.
  'algorithms/ot/server/getStateAtRevision.ts',
  // Branch seed (persists its result), merge base (feeds a committed program), duplication guard
  // (compares against a policy-rendered head). All three take the manager's option.
  'server/OTBranchManager.ts',
  // Public surface: forwards the consumer's option.
  'client/PatchesHistoryClient.ts',
  // Commit-time array-index check. Explicitly pads: the state is only used to decide whether an
  // array index is in range, and `@txt` padding changes a text field's length, never an array's.
  'algorithms/ot/server/commitChanges.ts',
];

describe('@txt overrun padding — every committed-log replay takes the caller rule', () => {
  it('no call site passes an empty `reconstruction: {}`', () => {
    // An empty object silently means "drop every overrun" — one of the two corrupting answers.
    // A site that genuinely wants a fixed rule has to say which.
    const offenders = sourceFiles(SRC)
      .filter(file => /reconstruction:\s*\{\s*\}/.test(readFileSync(file, 'utf8')))
      .map(rel);

    expect(offenders, 'thread legacyTextOverrunPadding through these, or pass an explicit boolean').toEqual([]);
  });

  it('only known files reconstruct a log', () => {
    const sites = sourceFiles(SRC)
      .filter(file => /applyChangesForReconstruction\s*\(|getStateAtRevision\s*\(/.test(readFileSync(file, 'utf8')))
      .map(rel)
      .filter(f => !f.startsWith('algorithms/ot/shared/applyChanges')) // the implementation itself
      .sort();

    // A new entry here is not automatically wrong — it needs the option threaded and a line above
    // saying why it is safe.
    expect(sites, 'a new replay site must thread legacyTextOverrunPadding and be listed here').toEqual(
      [...KNOWN_REPLAY_SITES].sort()
    );
  });

  // `getStateAtRevision` is a pass-through — it forwards whatever `reconstruction` it is handed
  // and names nothing — so it is exempt. Every other site must make a visible decision.
  it('each known site makes a visible decision about the option', () => {
    for (const site of KNOWN_REPLAY_SITES.filter(s => !s.endsWith('getStateAtRevision.ts'))) {
      const text = readFileSync(join(SRC, site), 'utf8');
      expect(text, `${site} reconstructs a log but never mentions legacyTextOverrunPadding`).toContain(
        'legacyTextOverrunPadding'
      );
    }
  });
});

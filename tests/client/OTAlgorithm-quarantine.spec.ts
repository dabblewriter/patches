import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../src/algorithms/ot/shared/applyChanges';
import { OTAlgorithm } from '../../src/client/OTAlgorithm';
import { OTInMemoryStore } from '../../src/client/OTInMemoryStore';
import type { JSONPatchOp } from '../../src/json-patch/types';
import type { Change } from '../../src/types';

/** The doc state a user sees = committed state with the pending queue applied. */
async function liveState(store: OTInMemoryStore, docId: string): Promise<any> {
  const snapshot = await store.getDoc(docId);
  return applyChanges(snapshot!.state, snapshot!.changes);
}

/**
 * OT poison-pill ejection at the algorithm level. Unlike LWW (a single sending slot),
 * an OT pending queue is a sequential program: ejecting a change removes it AND rebases its
 * successors into the frame that skips it. The rebase math is proven in
 * tests/algorithms/ot/shared/ejectPendingChange.spec.ts; this suite covers the algorithm's
 * sequencing, store persistence, and the verify/eject contract.
 */
describe('OTAlgorithm quarantine', () => {
  const DOC = 'q-doc';

  /** Committed base state { a: 0, s: 'x' } at rev 1. */
  async function setup() {
    const store = new OTInMemoryStore();
    const algorithm = new OTAlgorithm(store);
    await algorithm.trackDocs([DOC]);
    await algorithm.applyServerChanges(
      DOC,
      [
        {
          id: 'seed',
          rev: 1,
          baseRev: 0,
          ops: [{ op: 'replace', path: '', value: { a: 0, s: 'x' } }],
          createdAt: 0,
          committedAt: 1,
        },
      ],
      undefined
    );
    return { store, algorithm };
  }

  /** Mint one pending change carrying `ops`, returning its stored change. */
  async function mint(algorithm: OTAlgorithm, ops: JSONPatchOp[]): Promise<Change> {
    const [change] = await algorithm.handleDocChange(DOC, ops, undefined, {});
    return change;
  }

  describe('verifyPendingChange', () => {
    it('returns true for a pending change that strict-applies in its own frame', async () => {
      const { algorithm } = await setup();
      const change = await mint(algorithm, [{ op: 'replace', path: '/a', value: 1 }]);
      // A clean, appliable change — this is the policy-rejection case (server said no, but the
      // op is well-formed), so PatchesSync must NOT auto-eject it.
      expect(await algorithm.verifyPendingChange(DOC, change.id)).toBe(true);
    });

    it('returns false for a pending change that fails strict-apply (descends through a primitive)', async () => {
      const { algorithm } = await setup();
      // Descends two levels through the string primitive /s — a property can't be attached to
      // 'x', so the op can't apply.
      const change = await mint(algorithm, [{ op: 'replace', path: '/s/a/b', value: 1 }]);
      expect(await algorithm.verifyPendingChange(DOC, change.id)).toBe(false);
    });

    it('probes a successor in its own frame (committed + predecessors), not committed-only', async () => {
      const { algorithm } = await setup();
      // p0 turns /a into an object; p1 writes inside it. p1 only applies AFTER p0 — against
      // committed-only state (/a is 0, a primitive) it would wrongly look broken.
      await mint(algorithm, [{ op: 'replace', path: '/a', value: {} }]);
      const p1 = await mint(algorithm, [{ op: 'add', path: '/a/b', value: 1 }]);
      expect(await algorithm.verifyPendingChange(DOC, p1.id)).toBe(true);
    });

    it('returns true when no pending change matches the id', async () => {
      const { algorithm } = await setup();
      expect(await algorithm.verifyPendingChange(DOC, 'no-such-id')).toBe(true);
    });

    it('returns true (cannot corroborate) when a predecessor is un-appliable, not a throw', async () => {
      const { store, algorithm } = await setup();
      // A corrupt predecessor (replaces through the string primitive /s) means the named
      // change's frame can't be reconstructed. The probe must fail toward true — never a false
      // that would let PatchesSync auto-eject a change it couldn't actually corroborate.
      const badPredecessor: Change = {
        id: 'bad',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'replace', path: '/s/a/b', value: 1 }],
        createdAt: 0,
        committedAt: 0,
      };
      const named: Change = {
        id: 'named',
        rev: 3,
        baseRev: 1,
        ops: [{ op: 'add', path: '/ok', value: 1 }],
        createdAt: 0,
        committedAt: 0,
      };
      await store.savePendingChanges(DOC, [badPredecessor, named]);
      await expect(algorithm.verifyPendingChange(DOC, 'named')).resolves.toBe(true);
    });
  });

  describe('ejectPendingChange', () => {
    it('quarantines the poison and leaves the rebased survivors pending', async () => {
      const { store, algorithm } = await setup();
      const poison = await mint(algorithm, [{ op: 'replace', path: '/a', value: 1 }]);
      const survivor = await mint(algorithm, [{ op: 'add', path: '/b', value: 2 }]);

      const entry = await algorithm.ejectPendingChange(DOC, poison.id, 'forbidden');
      expect(entry).not.toBeNull();
      expect(entry!.changeId).toBe(poison.id);
      expect(entry!.change.ops).toEqual(poison.ops);
      expect(entry!.reason).toBe('forbidden');

      const pending = await store.getPendingChanges(DOC);
      expect(pending.map(c => c.id)).toEqual([survivor.id]);
      // The survivor is disjoint from the poison, so its ops survive untouched.
      expect(pending[0].ops).toEqual(survivor.ops);

      // The live doc state (committed + pending) no longer contains the poison's edit (a stays
      // 0, not 1), while the survivor's edit remains (b === 2).
      const state = await liveState(store, DOC);
      expect(state.a).toBe(0);
      expect(state.b).toBe(2);
    });

    it('surfaces the quarantined change via listQuarantinedChanges and clears it on discard', async () => {
      const { algorithm } = await setup();
      const poison = await mint(algorithm, [{ op: 'replace', path: '/a', value: 9 }]);
      await algorithm.ejectPendingChange(DOC, poison.id, 'forbidden');

      const listed = await algorithm.listQuarantinedChanges(DOC);
      expect(listed.map(e => e.changeId)).toEqual([poison.id]);

      await algorithm.discardQuarantinedChange(DOC, poison.id);
      expect(await algorithm.listQuarantinedChanges(DOC)).toEqual([]);
    });

    it('is an idempotent no-op on a second eject of the same id', async () => {
      const { store, algorithm } = await setup();
      const poison = await mint(algorithm, [{ op: 'replace', path: '/a', value: 1 }]);
      await mint(algorithm, [{ op: 'add', path: '/b', value: 2 }]);

      expect(await algorithm.ejectPendingChange(DOC, poison.id, 'forbidden')).not.toBeNull();
      const pendingAfterFirst = await store.getPendingChanges(DOC);
      // A repeat call finds nothing pending under that id and mutates nothing.
      expect(await algorithm.ejectPendingChange(DOC, poison.id, 'forbidden')).toBeNull();
      expect(await store.getPendingChanges(DOC)).toEqual(pendingAfterFirst);
      // The quarantine still holds exactly one entry (no duplicate).
      expect((await algorithm.listQuarantinedChanges(DOC)).length).toBe(1);
    });

    it('returns null without mutating when the id is not pending', async () => {
      const { store, algorithm } = await setup();
      const survivor = await mint(algorithm, [{ op: 'add', path: '/b', value: 2 }]);
      expect(await algorithm.ejectPendingChange(DOC, 'ghost', 'forbidden')).toBeNull();
      expect((await store.getPendingChanges(DOC)).map(c => c.id)).toEqual([survivor.id]);
      expect(await algorithm.listQuarantinedChanges(DOC)).toEqual([]);
    });

    it('throws (leaving the queue latched, no mutation) when the poison cannot be inverted', async () => {
      const { store, algorithm } = await setup();
      // Craft a corrupt queue directly: the poison replaces /missing/deep, but /missing is
      // absent from the reconstructed pre-state, so it can't be inverted. A successor forces
      // the invert path to run. The throw (vs the benign no-match null) is the contract —
      // an app-consent caller must be able to tell "nothing to eject" from "still wedged".
      const poison: Change = {
        id: 'poison',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'replace', path: '/missing/deep', value: 1 }],
        createdAt: 0,
        committedAt: 0,
      };
      const after: Change = {
        id: 'after',
        rev: 3,
        baseRev: 1,
        ops: [{ op: 'add', path: '/z', value: 1 }],
        createdAt: 0,
        committedAt: 0,
      };
      await store.savePendingChanges(DOC, [poison, after]);

      // Depending on the shape, the throw comes from the strict-apply probe ("Cannot eject")
      // or from invertPatch itself ("Patch mismatch") — either way it must throw, not null.
      await expect(algorithm.ejectPendingChange(DOC, 'poison', 'forbidden')).rejects.toThrow(
        /Cannot eject|Patch mismatch/
      );
      // Nothing quarantined, pending queue untouched — the doc stays latched, not half-rebased.
      expect(await algorithm.listQuarantinedChanges(DOC)).toEqual([]);
      expect((await store.getPendingChanges(DOC)).map(c => c.id)).toEqual(['poison', 'after']);
    });

    it('throws rather than fabricating an inverse for a one-level mismatch with successors', async () => {
      const { store, algorithm } = await setup();
      // /s is the string 'x': `replace /s/a` misses by ONE level, which invertPatch would
      // read as undefined WITHOUT throwing and emit a phantom `remove /s/a` — walking that
      // fabricated inverse through the successor would corrupt it. The strict-apply probe in
      // computePendingEjection must catch this shape, not just the deep-miss one above.
      const poison: Change = {
        id: 'poison',
        rev: 2,
        baseRev: 1,
        ops: [{ op: 'replace', path: '/s/a', value: 1 }],
        createdAt: 0,
        committedAt: 0,
      };
      const after: Change = {
        id: 'after',
        rev: 3,
        baseRev: 1,
        ops: [{ op: 'add', path: '/z', value: 1 }],
        createdAt: 0,
        committedAt: 0,
      };
      await store.savePendingChanges(DOC, [poison, after]);

      await expect(algorithm.ejectPendingChange(DOC, 'poison', 'forbidden')).rejects.toThrow(/Cannot eject/);
      expect(await algorithm.listQuarantinedChanges(DOC)).toEqual([]);
      expect((await store.getPendingChanges(DOC)).map(c => c.id)).toEqual(['poison', 'after']);
    });

    describe('onlyIfUnappliable (atomic auto-eject re-probe)', () => {
      it('returns null without ejecting when the change now applies cleanly in its frame', async () => {
        const { store, algorithm } = await setup();
        // The auto-eject contract: PatchesSync's verify probe released its lock, and by the
        // time eject runs the change may have become valid (a broadcast rebased the queue).
        // A cleanly-applying change must NOT be ejected under the flag.
        const change = await mint(algorithm, [{ op: 'replace', path: '/a', value: 1 }]);
        const survivor = await mint(algorithm, [{ op: 'add', path: '/b', value: 2 }]);

        expect(
          await algorithm.ejectPendingChange(DOC, change.id, 'forbidden', undefined, { onlyIfUnappliable: true })
        ).toBeNull();
        expect((await store.getPendingChanges(DOC)).map(c => c.id)).toEqual([change.id, survivor.id]);
        expect(await algorithm.listQuarantinedChanges(DOC)).toEqual([]);
      });

      it('still ejects a change that fails its in-frame probe', async () => {
        const { store, algorithm } = await setup();
        // A genuinely un-appliable tail poison (no successors, so no invert is needed).
        const poison: Change = {
          id: 'poison',
          rev: 2,
          baseRev: 1,
          ops: [{ op: 'replace', path: '/s/a/b', value: 1 }],
          createdAt: 0,
          committedAt: 0,
        };
        await store.savePendingChanges(DOC, [poison]);

        const entry = await algorithm.ejectPendingChange(DOC, 'poison', 'forbidden', undefined, {
          onlyIfUnappliable: true,
        });
        expect(entry).not.toBeNull();
        expect(await store.getPendingChanges(DOC)).toEqual([]);
        expect((await algorithm.listQuarantinedChanges(DOC)).map(e => e.changeId)).toEqual(['poison']);
      });

      it('returns null (cannot corroborate) when a predecessor is un-appliable', async () => {
        const { store, algorithm } = await setup();
        // Same fail-toward-safety posture as verifyPendingChange: no frame, no corroboration,
        // no auto-eject.
        const badPredecessor: Change = {
          id: 'bad',
          rev: 2,
          baseRev: 1,
          ops: [{ op: 'replace', path: '/s/a/b', value: 1 }],
          createdAt: 0,
          committedAt: 0,
        };
        const named: Change = {
          id: 'named',
          rev: 3,
          baseRev: 1,
          ops: [{ op: 'add', path: '/ok', value: 1 }],
          createdAt: 0,
          committedAt: 0,
        };
        await store.savePendingChanges(DOC, [badPredecessor, named]);

        expect(
          await algorithm.ejectPendingChange(DOC, 'named', 'forbidden', undefined, { onlyIfUnappliable: true })
        ).toBeNull();
        expect((await store.getPendingChanges(DOC)).map(c => c.id)).toEqual(['bad', 'named']);
        expect(await algorithm.listQuarantinedChanges(DOC)).toEqual([]);
      });
    });
  });

  describe('quarantine lifecycle vs tracking', () => {
    it('preserves quarantine across untrack (cache eviction) but clears it on delete', async () => {
      const { store, algorithm } = await setup();
      const poison = await mint(algorithm, [{ op: 'replace', path: '/a', value: 1 }]);
      await algorithm.ejectPendingChange(DOC, poison.id, 'forbidden');

      await store.untrackDocs([DOC]);
      expect((await store.listQuarantinedChanges(DOC)).map(e => e.changeId)).toEqual([poison.id]);

      await store.deleteDoc(DOC);
      expect(await store.listQuarantinedChanges(DOC)).toEqual([]);
    });
  });
});

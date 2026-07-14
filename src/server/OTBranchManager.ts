import { findLatestMainVersion } from '../algorithms/ot/server/getSnapshotAtRevision.js';
import { getStateAtRevision } from '../algorithms/ot/server/getStateAtRevision.js';
import { breakChanges } from '../algorithms/ot/shared/changeBatching.js';
import { createChange } from '../data/change.js';
import { createVersionMetadata } from '../data/version.js';
import type { Branch, Change, CreateBranchMetadata, EditableBranchMetadata, ListBranchesOptions } from '../types.js';
import type { BranchManager } from './BranchManager.js';
import {
  advanceMergeWatermark,
  assertBranchMetadata,
  assertBranchExists,
  assertNotABranch,
  branchManagerApi,
  createBranchRecord,
  generateBranchId,
  stripMergeWatermark,
  wrapMergeCommit,
} from './branchUtils.js';
import type { PatchesServer } from './PatchesServer.js';
import type { BranchingStoreBackend, OTStoreBackend } from './types.js';

/**
 * Combined store backend type for OT branch management.
 * Requires both OT operations and branch metadata operations.
 */
type OTBranchStore = OTStoreBackend & BranchingStoreBackend;

/**
 * OT-specific branch manager implementation.
 *
 * Manages branches for documents using Operational Transformation semantics:
 * - Creates branches at specific revision points
 * - Uses fast-forward merge when possible (no concurrent changes on source)
 * - Transforms individual branch changes against concurrent source changes for divergent histories
 *
 * A branch is a document that originates from another document at a specific revision.
 * Its first version represents the source document's state at that revision.
 * Branches allow parallel development with the ability to merge changes back.
 */
export class OTBranchManager implements BranchManager {
  static api = branchManagerApi;

  constructor(
    private readonly store: OTBranchStore,
    private readonly patchesServer: PatchesServer,
    private readonly maxPayloadBytes?: number
  ) {}

  /**
   * Lists all open branches for a document.
   * @param docId - The ID of the document.
   * @param options - Optional filtering options (e.g. `since` for incremental sync).
   * @returns The branches.
   */
  async listBranches(docId: string, options?: ListBranchesOptions): Promise<Branch[]> {
    return await this.store.listBranches(docId, options);
  }

  /**
   * Creates a new branch for a document.
   * @param docId - The ID of the document to branch from.
   * @param rev - The revision of the document to branch from.
   * @returns The ID of the new branch document.
   */
  async createBranch(docId: string, rev: number, metadata?: CreateBranchMetadata): Promise<string> {
    const branchDocId = metadata?.id ?? (await generateBranchId(this.store, docId));

    // Idempotent: if a branch with this ID already exists, return it as a no-op.
    // This handles retry-on-bad-connection scenarios.
    if (metadata?.id) {
      const existing = await this.store.loadBranch(branchDocId);
      if (existing) {
        if (existing.docId !== docId) {
          throw new Error(`Branch ${branchDocId} already exists for a different document`);
        }
        return branchDocId;
      }
    }

    await assertNotABranch(this.store, docId);

    const now = Date.now();

    let contentStartRev: number;

    if (metadata?.contentStartRev) {
      // Client supplied initial content as pending changes through normal sync flow.
      // contentStartRev tells us where user content begins (init changes are below it).
      contentStartRev = metadata.contentStartRev;
    } else {
      // Generate init changes from the source state at the branch point.
      // Materializing the branch point replays settled, committed source history
      // (reconstruction, not live apply): an invalid committed op from a
      // lenient-era commit is skipped — matching what version builds and
      // pre-strict clients computed for the same log — rather than making the
      // source doc permanently un-branchable. Skips log via console.error.
      const { state: stateAtRev } = await getStateAtRevision(this.store, docId, rev, { reconstruction: {} });
      const rootReplace = createChange(0, 1, [{ op: 'replace' as const, path: '', value: stateAtRev }], {
        createdAt: now,
        committedAt: now,
      });
      const initChanges = this.maxPayloadBytes ? breakChanges([rootReplace], this.maxPayloadBytes) : [rootReplace];
      contentStartRev = initChanges[initChanges.length - 1].rev + 1;

      await this.store.saveChanges(branchDocId, initChanges);

      // Create an initial version representing the branch point (metadata + init changes, no state).
      // Stamped with branch-local revs: cold loads pick the latest 'main' version by endRev in the
      // branch's own rev-space (init changes start at rev 1), so stamping the source's rev here
      // would hide the first branch changes once the branch's rev count reaches branchedAtRev.
      const initialVersionMetadata = createVersionMetadata({
        origin: 'main',
        startedAt: now,
        endedAt: now,
        endRev: initChanges[initChanges.length - 1].rev,
        startRev: initChanges[0].rev,
        groupId: branchDocId,
        ...(metadata?.name !== undefined && { name: metadata.name }),
      });
      await this.store.createVersion(branchDocId, initialVersionMetadata, initChanges);
    }

    // Create the branch metadata record
    const branch = createBranchRecord(branchDocId, docId, rev, contentStartRev, metadata);
    await this.store.createBranch(branch);
    return branchDocId;
  }

  /**
   * Updates a branch's metadata.
   * @param branchId - The ID of the branch to update.
   * @param metadata - The metadata to update.
   */
  async updateBranch(branchId: string, metadata: EditableBranchMetadata): Promise<void> {
    assertBranchMetadata(metadata);
    await this.store.updateBranch(branchId, { ...stripMergeWatermark(metadata), modifiedAt: Date.now() });
  }

  /**
   * Deletes a branch, replacing the record with a tombstone.
   */
  async deleteBranch(branchId: string): Promise<void> {
    await this.store.deleteBranch(branchId);
  }

  /**
   * Merges changes from a branch back into its source document.
   *
   * Supports multiple merges — the branch stays open and `lastMergedRev` tracks
   * which branch revision was last merged. Subsequent merges only pick up new changes.
   *
   * All merge changes use `batchId: branchId` so that `commitChanges` never transforms
   * branch changes against each other (they share the same causal context).
   *
   * ## Retry and concurrency safety
   *
   * The commit and the `lastMergedRev` update are two writes, so a crash or timeout can land
   * between them, and nothing serializes two merges of the same branch. Safety comes from
   * three properties rather than a transaction:
   *
   * 1. **Idempotent commit** — merged changes keep their original branch change ids, and the
   *    merge base (the server's id-dedup window) is stable across attempts (see
   *    {@link resolveMergeBase}), so a retry or concurrent merge re-sending the same changes
   *    dedups to a no-op inside `commitChanges` instead of applying them twice.
   * 2. **Watermark from the merged batch** — `lastMergedRev` is set to the highest branch rev
   *    in the batch actually read and committed, never the branch tip, so an edit landing on
   *    the branch mid-merge stays uncovered and is picked up by the next merge.
   * 3. **Forward-only watermark** — the update is a compare-and-set when the store supports
   *    `updateBranchIf` (see {@link advanceMergeWatermark}), so interleaved merges cannot
   *    regress the watermark; without the capability, legacy max-wins semantics apply.
   *
   * @param branchId - The ID of the branch document to merge.
   * @returns The server commit change(s) applied to the source document.
   * @throws Error if branch not found, already closed/merged, or merge fails.
   */
  async mergeBranch(branchId: string): Promise<Change[]> {
    // Load and validate branch
    const branch = await this.store.loadBranch(branchId);
    assertBranchExists(branch, branchId);

    const sourceDocId = branch.docId;
    const branchStartRevOnSource = await this.resolveMergeBase(branch);

    // Get only unmerged changes: since lastMergedRev (if previously merged) or contentStartRev
    const startAfter = branch.lastMergedRev ?? (branch.contentStartRev ?? 2) - 1;
    const branchChanges = await this.store.listChanges(branchId, { startAfter });
    if (branchChanges.length === 0) {
      return [];
    }

    const lastBranchRev = branchChanges[branchChanges.length - 1].rev;

    // Get not-yet-merged versions from the branch doc, using the same cursor as the changes
    // query — repeat merges must not re-copy versions already on the source. This also skips
    // the branch's initial version (the branch point already exists in source history) and
    // offline-branch versions.
    const branchVersions = await this.store.listVersions(branchId, {
      origin: 'main',
      orderBy: 'endRev',
      startAfter,
    });

    // Map branch-local revs onto the claimed source revs of the commit below. Copied versions
    // must live in the source's rev-space: a branch-local endRev past the source tip would
    // become the source's version watermark and leave real source revs un-versioned.
    const toSourceRev = (rev: number) => branchStartRevOnSource + Math.max(0, rev - startAfter);

    // Copy versions with a deterministic identity: the source copy keeps the branch version's
    // id (version ids are namespaced per doc, so there is no collision on the source). A
    // retried merge — the crash window is between the commit below and the watermark update —
    // or a concurrent merge of the same branch finds the existing copy and skips it instead of
    // minting a duplicate. Orphaned copies from a merge whose commit then failed are harmless
    // and are adopted by the retry the same way.
    let lastVersionId: string | undefined;
    for (const v of branchVersions) {
      const alreadyCopied = await this.store.loadVersion(sourceDocId, v.id);
      if (alreadyCopied) {
        lastVersionId = v.id;
        continue;
      }
      const startRev = toSourceRev(v.startRev);
      // The first copy has no earlier copy to chain to, so it anchors to the source's own
      // timeline. Unanchored, building its state replays the source document from rev 1.
      const parentId = lastVersionId ?? (await findLatestMainVersion(this.store, sourceDocId, startRev - 1))?.id;
      const copy = {
        ...v,
        origin: 'branch' as const,
        startRev,
        endRev: toSourceRev(v.endRev),
        groupId: branchId,
        parentId,
      };
      if (copy.parentId === undefined) delete copy.parentId;
      const changes = await this.store.loadVersionChanges?.(branchId, v.id);
      await this.store.createVersion(sourceDocId, copy, changes);
      lastVersionId = copy.id;
    }

    // Re-stamp branch changes for source document context:
    // - baseRev: where the branch diverged from source (for transformation)
    // - batchId: prevents transformation against previously-merged branch changes
    // - Original change IDs preserved: they are the dedup identity that makes a retried or
    //   concurrent re-send of already-committed merge changes a no-op in commitChanges.
    const changesToCommit = branchChanges.map((c, i) => ({
      ...c,
      baseRev: branchStartRevOnSource,
      rev: branchStartRevOnSource + i + 1,
      batchId: branchId,
    }));

    // Commit changes to source doc with error handling
    const committedMergeChanges = await wrapMergeCommit(branchId, sourceDocId, async () => {
      return (await this.patchesServer.commitChanges(sourceDocId, changesToCommit)).changes;
    });

    // Merge succeeded. Advance lastMergedRev to the last branch rev in the batch we actually
    // merged (never the branch tip — a concurrent branch edit past our snapshot must remain
    // mergeable). CAS-guarded against concurrent merges when the store supports it.
    await advanceMergeWatermark(this.store, branchId, branch.lastMergedRev, lastBranchRev);
    return committedMergeChanges;
  }

  /**
   * Resolve the source revision to use as the merge base (`baseRev`) for a branch's merges.
   *
   * Healthy branches merge at `branchedAtRev`. A branch can carry a `branchedAtRev` that is
   * *ahead* of the source's committed tip — e.g. a migrated/re-synced document whose change
   * log was renumbered down under the branch record. Committing with a `baseRev` greater than
   * the source's current rev trips `commitChanges`' "baseRev ahead of server revision" guard,
   * so the base is clamped to the source tip: nothing exists between the tip and
   * `branchedAtRev`, so rebasing onto the real tip is correct.
   *
   * The clamped base is persisted as `mergeBaseRev` BEFORE anything is committed, and every
   * later attempt prefers it. This is what makes merge retries idempotent on clamped
   * branches: `commitChanges` dedups re-sent changes by id within
   * `listChanges(startAfter: baseRev)`, and the first attempt's own commits advance the
   * source tip past `branchedAtRev` — so a retry that recomputed `min(branchedAtRev, tip)`
   * would use a *higher* base, and the changes already committed below it would escape
   * deduplication and be applied twice. Pinning the base keeps the dedup window identical
   * across retries and server instances. First writer wins via CAS when the store supports it.
   *
   * The healthy path (`branchedAtRev <= tip`) must also respect a pin it cannot see in its
   * own snapshot: a concurrent merge's commits may be exactly what advanced the tip past
   * `branchedAtRev`, so a merge whose branch snapshot predates that merge's pin would
   * otherwise take the early return with the higher base and re-apply the committed changes.
   * Because the pin is written before anything is committed, on a strongly consistent store
   * any tip read that includes another merge's commits also observes its pin — so the healthy
   * path re-loads the branch record after the tip read and prefers a freshly pinned base.
   */
  private async resolveMergeBase(branch: Branch): Promise<number> {
    if (branch.mergeBaseRev != null) return branch.mergeBaseRev;

    const sourceCurrentRev = await this.store.getCurrentRev(branch.docId);
    if (branch.branchedAtRev <= sourceCurrentRev) {
      // The tip may have been advanced by a concurrent merge that pinned a clamped base
      // before committing; our snapshot predates the pin, so check for it fresh.
      const fresh = await this.store.loadBranch(branch.id);
      if (fresh?.mergeBaseRev != null) return fresh.mergeBaseRev;
      return branch.branchedAtRev;
    }

    const clamped = sourceCurrentRev;
    // The clamp only fires on a corrupted/renumbered source doc — exactly the
    // data-integrity case worth surfacing rather than merging silently.
    console.warn(
      `[OTBranchManager] branch ${branch.id} branchedAtRev (${branch.branchedAtRev}) is ahead of ` +
        `source ${branch.docId} currentRev (${sourceCurrentRev}); clamping merge base to ${clamped}`
    );

    if (this.store.updateBranchIf) {
      const applied = await this.store.updateBranchIf(
        branch.id,
        { mergeBaseRev: clamped, modifiedAt: Date.now() },
        { mergeBaseRev: undefined }
      );
      if (!applied) {
        // A concurrent merge pinned the base first (or the record changed) — theirs wins.
        const current = await this.store.loadBranch(branch.id);
        if (current?.mergeBaseRev != null) return current.mergeBaseRev;
      }
    } else {
      await this.store.updateBranch(branch.id, { mergeBaseRev: clamped, modifiedAt: Date.now() });
    }
    return clamped;
  }
}

// Re-export for backwards compatibility
export { assertBranchMetadata } from './branchUtils.js';

import { StatusError } from '../../../net/error.js';
import { DuplicateChangeIdsError } from '../../../server/DuplicateChangeIdsError.js';
import type { CommitResult } from '../../../server/PatchesServer.js';
import { RevConflictError } from '../../../server/RevConflictError.js';
import type { OTStoreBackend } from '../../../server/types.js';
import type { Change, ChangeInput, CommitChangesOptions } from '../../../types.js';
import { createVersionAtRev } from './createVersion.js';
import { handleOfflineSessionsAndBatches } from './handleOfflineSessionsAndBatches.js';
import { transformIncomingChanges } from './transformIncomingChanges.js';

// Re-export for backwards compatibility
export type { CommitChangesOptions } from '../../../types.js';
export type { CommitResult } from '../../../server/PatchesServer.js';

const MAX_CONFLICT_RETRIES = 5;

/**
 * Commits a set of changes to a document, applying operational transformation as needed.
 *
 * ## Stateless Design
 *
 * This function never loads or builds document state. It uses `getCurrentRev` to get the
 * current revision and transforms changes against committed changes only (no state parameter
 * passed to transformPatch). Bad ops become noops during transformation.
 *
 * ## Version Creation
 *
 * Versions are created (metadata + changes saved via `store.createVersion`) when session
 * timeouts are detected. Building and persisting version state is the store's concern,
 * inline or deferred (see `VersioningStoreBackend.createVersion`).
 *
 * ## Conflict Retry
 *
 * When a store's `saveChanges` throws `RevConflictError` (e.g. because another server
 * instance committed the same revision), the function retries: re-reads `currentRev`,
 * re-fetches committed changes, re-transforms, and re-saves. The retry naturally resolves
 * because the fresh `currentRev` includes the conflicting commit.
 *
 * ## Duplicate Id Guard (DAB-607)
 *
 * Incoming change ids are deduped against committed changes after `baseRev`, but that
 * read-side window cannot see a committed copy at or before `baseRev` (a retry the client
 * rebased onto a newer tip — e.g. after a snapshot catch-up that carries no change ids),
 * nor arbitrate two simultaneous sends of the same change. Stores enforcing write-time id
 * uniqueness throw `DuplicateChangeIdsError` from `saveChanges`; the retry here excludes
 * the named ids and resolves the request as a resend, so a duplicate never commits and
 * non-idempotent ops (array removes, text deltas) are never double-applied.
 *
 * @param store - The backend store for persistence.
 * @param docId - The ID of the document.
 * @param changes - The changes to commit.
 * @param sessionTimeoutMillis - Timeout for session-based versioning.
 * @param options - Optional commit settings.
 * @returns A CommitResult containing:
 *   - catchupChanges: Changes the client missed
 *   - newChanges: The client's changes after transformation
 */
export async function commitChanges(
  store: OTStoreBackend,
  docId: string,
  changes: ChangeInput[],
  sessionTimeoutMillis: number,
  options?: CommitChangesOptions
): Promise<CommitResult> {
  if (changes.length === 0) {
    return { catchupChanges: [], newChanges: [] };
  }

  const batchId = changes[0].batchId;

  // 1. Get current revision for baseRev setup
  const initialRev = await store.getCurrentRev(docId);
  let baseRev = changes[0].baseRev ?? initialRev;

  let docReloadRequired: true | undefined;
  if (initialRev > 0) {
    // Both exemptions below belong to the multi-batch upload that CREATED this doc: the root
    // creation op its first batch carries, and the baseRev 0 its later batches keep. Once that
    // first batch lands, its later batches are indistinguishable on the wire from a never-synced
    // client flushing baseRev 0 onto a doc someone else wrote, so ask the doc's own history
    // rather than the batch's revs. Resolved lazily: normal commits (baseRev > 0, no root op)
    // never pay the read; each continuation batch of a genuine multi-batch upload pays one.
    let ownUpload: Promise<boolean> | undefined;
    const isOwnUpload = () => (ownUpload ??= createdByBatch(store, docId, batchId));
    // A flush starts at rev 1, so rev > 1 at baseRev 0 means the head of this queue was already
    // resolved elsewhere — a continuation whether or not the flush split. Not keyed on batchId:
    // an unsplit tail carries none, and it must not slip into the rebase heal below. Historical
    // imports legitimately start chunks past rev 1 (they preserve their original revs).
    const continuation = changes[0].rev! > 1 && !options?.historicalImport;

    // Prevent stale clients from wiping existing data with a root creation op anywhere in the
    // batch. Not keyed on baseRev: a reload re-stamps pending onto the new tip without
    // transforming its ops (OTAlgorithm._withConsistentBaseRev), so a root op re-sent after one
    // arrives at baseRev = tip and overwrites the doc just the same.
    const rootOpChange = changes.find(c => c.ops.some(op => op.path === ''));
    if (rootOpChange && !options?.allowRootReplace && !(await isOwnUpload())) {
      throw new StatusError(
        400,
        `Document ${docId} already exists (rev ${initialRev}). ` +
          `Cannot apply root-level replace (path: '') - this would overwrite the existing document. ` +
          `Load the existing document first, or use nested paths instead of replacing at root.`,
        { changeId: rootOpChange.id, scope: 'change' }
      );
    }

    if (changes[0].baseRev === 0) {
      if (!continuation) {
        // Rebase explicit baseRev: 0 on existing docs to current revision.
        // The caller signals docReloadRequired so the client knows to call getDoc.
        docReloadRequired = true;
        baseRev = initialRev;
        for (const c of changes) {
          c.baseRev = baseRev;
        }
      } else if (!(await isOwnUpload())) {
        // The head of this flush was already resolved (its first batch was answered with
        // docReloadRequired), so these ops were minted against state the client has since
        // replaced. Neither treatment is sound: rebasing moves baseRev to the tip, leaving the
        // commit read nothing to transform against, so the ops stack verbatim onto a head they
        // never saw and overwrite whatever paths they touch; transforming them honestly means
        // reading the entire change log, which is unbounded and fails outright on a large doc.
        // Refuse instead. The client reloads on this refusal (409 scope: 'doc'), which rebases
        // what is left of the queue against the real history and re-sends it on the true head,
        // so the work survives. Never docReloadRequired here: the client drops a batch from
        // pending on that, and this batch was not committed.
        throw new StatusError(
          409,
          `Document ${docId} already exists (rev ${initialRev}) and was not created by this upload. ` +
            `Cannot continue a baseRev 0 upload onto it - these changes were made against state the client ` +
            `has since reloaded. Reload the document and re-send them on the current revision.`,
          { scope: 'doc' }
        );
      }
    }
  }

  // Ensure baseRev and rev are set, add committedAt, and clamp createdAt
  const serverNow = Date.now();
  let rev = baseRev + 1;
  changes.forEach(c => {
    if (c.baseRev == null) c.baseRev = baseRev;
    else if (c.baseRev !== baseRev && !options?.historicalImport) {
      throw new StatusError(400, `Client changes must have consistent baseRev in all changes for doc ${docId}.`, {
        scope: 'doc',
      });
    }
    if (c.rev == null) c.rev = rev++;
    else rev = c.rev + 1;
    // Set server commit time (preserve existing in historicalImport mode)
    if (!options?.historicalImport || !(c as Change).committedAt) {
      (c as Change).committedAt = serverNow;
    }
    // Clamp createdAt to not be after committedAt
    c.createdAt = c.createdAt ? Math.min(c.createdAt, serverNow) : serverNow;
  });

  // Basic validation
  if (baseRev > initialRev) {
    throw new StatusError(
      409,
      `Client baseRev (${baseRev}) is ahead of server revision (${initialRev}) for doc ${docId}. Client needs to reload the document.`,
      { scope: 'doc' }
    );
  }

  // 2. Versioning. Snapshot completed work so the change log doesn't grow without bound and
  //    cold loads stay cheap. Two triggers feed one bounded catch-up:
  //    (a) Session gap — the previous change is older than the session timeout: version the
  //        whole completed session up to the previous tip.
  //    (b) Change count — `maxChangesPerVersion` (or more) changes have accrued since the last
  //        version. A continuous high-rate burst never satisfies (a) (changes are seconds
  //        apart), so without (b) a document can accumulate tens of thousands of un-versioned
  //        changes and become too expensive — or impossible — to cold-load, since every load
  //        replays the entire log.
  //    Either way the version watermark is advanced in steps of at most `maxChangesPerVersion`
  //    changes (see `catchUpVersions`), so no single version build ever scans a large backlog
  //    and the un-versioned tail a cold load must replay stays bounded (< 2N in steady state).
  const maxChangesPerVersion = options?.maxChangesPerVersion ?? 0;
  const [lastChange] = await store.listChanges(docId, { reverse: true, limit: 1 });
  if (lastChange) {
    const compareTime = options?.historicalImport ? (changes[0].createdAt ?? serverNow) : serverNow;
    const sessionGap = compareTime - lastChange.createdAt > sessionTimeoutMillis;
    // Project the post-commit tip from the *server* rev, not the client-claimed revs: a commit
    // on a stale baseRev carries low claimed revs (it rebases forward on save), so gating on
    // them would under-fire and let the boundary slip past. Take the max of both as a safe
    // upper bound — over-firing only ever costs one extra listVersions read.
    const projectedTipRev = Math.max(initialRev + changes.length, changes[changes.length - 1].rev!);
    const crossesBoundary =
      maxChangesPerVersion > 0 &&
      Math.floor(initialRev / maxChangesPerVersion) < Math.floor(projectedTipRev / maxChangesPerVersion);

    // The boundary check is pure arithmetic over values already in hand, so non-boundary
    // commits never reach the store read inside catchUpVersions (~once per N commits).
    if (sessionGap || crossesBoundary) {
      await catchUpVersions(store, docId, lastChange.rev, maxChangesPerVersion, sessionGap);
    }
  }

  // 3. Retry loop: read current state, transform, and save. On RevConflictError
  //    (another instance committed the same rev), re-read and retry.
  let offlineSessionsHandled = false;

  // Ids the STORE reported as already committed (DuplicateChangeIdsError from
  // saveChanges). The read-side dedup below can only see committed copies after
  // `baseRev`; a retry the client rebased onto a newer tip carries a baseRev past
  // its original commit, and two simultaneous sends can both pass the read check —
  // the store's write-time id guard is the backstop for both (DAB-607). Ids land
  // here across attempts so the retry resolves the request as a resend.
  const storeCommittedIds = new Set<string>();

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    try {
      // Re-read currentRev on retry to pick up the conflicting commit
      const currentRev = attempt === 0 ? initialRev : await store.getCurrentRev(docId);

      // Load ALL committed changes *after* the client's baseRev. The idempotency check must see previously
      // committed changes from this same batch (a resend carries the same batchId), so filter the batch out of the
      // transform set in memory rather than at the store.
      const allCommittedChanges = await store.listChanges(docId, { startAfter: baseRev });

      // The sender's own echoes — committed copies of changes this request re-sent (matched
      // by id: a retry after a lost response on the plain path) and committed changes from
      // this same batch (a resend carries the same batchId) — are never TRANSFORMED against:
      // the tail of a resent queue was minted on top of the resent head, so its frames
      // already include the head's effects; transforming the tail against the head's
      // committed echo double-applies them (array/text ops land at double-shifted offsets).
      const changeIds = new Set(changes.map(c => c.id));
      // Origin awareness: id/batch matching alone can be fooled by a FOREIGN committed change
      // with a colliding id — excluding it from the transform set commits the rest of the batch
      // in the wrong frame, and echoing it back confirms a change the sender never made. When
      // both sides carry a connection identity (stamped by OTServer since DAB-601), an echo must
      // also match on it; either side missing falls back to id-only matching (pre-stamp rows).
      const senderClientId = changes.find(c => c.clientId)?.clientId;
      const sameOrigin = (c: Change) => !senderClientId || !c.clientId || c.clientId === senderClientId;
      const isOwnCommitted = (c: Change) =>
        sameOrigin(c) && ((batchId ? c.batchId === batchId : false) || changeIds.has(c.id));
      const committedChanges = allCommittedChanges.filter(c => !isOwnCommitted(c));

      // Filter changes already committed after baseRev AND duplicates within the incoming
      // batch itself — a client retry/flush race can repeat a change id in one array, and
      // committing it twice double-applies its ops (the second copy is never transformed
      // against the first). Only same-origin committed copies count: a foreign colliding id
      // must not swallow the sender's distinct change.
      const committedIds = new Set(allCommittedChanges.filter(sameOrigin).map(c => c.id));
      const seenIncomingIds = new Set<string>();
      const incomingChanges = changes.filter(c => {
        if (committedIds.has(c.id) || storeCommittedIds.has(c.id) || seenIncomingIds.has(c.id)) return false;
        seenIncomingIds.add(c.id);
        return true;
      }) as Change[];

      // Committed copies of changes this request re-sent (a retry after a lost ack) must be echoed back so the
      // client can confirm them, even though they are excluded from the transform set above.
      const resentCommitted = allCommittedChanges.filter(c => sameOrigin(c) && changeIds.has(c.id));
      const catchupChanges = resentCommitted.length
        ? [...committedChanges, ...resentCommitted].sort((a, b) => a.rev - b.rev)
        : committedChanges;

      // If all incoming changes were already committed, return the committed changes found
      if (incomingChanges.length === 0) {
        return { catchupChanges, newChanges: [], docReloadRequired };
      }

      // 4. Offline-session versioning applies when:
      // - batchId present (multi-batch uploads)
      // - or the first change is older than the session timeout (single-batch offline)
      const isOfflineTimestamp = serverNow - incomingChanges[0].createdAt > sessionTimeoutMillis;
      const isOfflineOrBatch = isOfflineTimestamp || !!batchId;

      // Fast-forward: nothing committed after baseRev, so the incoming changes save
      // without transformation. Their revs are renumbered from the authoritative tip —
      // the identity mapping for offline resumes and batch continuations, but required
      // for client-claimed revs that would collide with existing history (a repeat
      // branch merge, or a baseRev-0 heal onto an existing doc). Versions are created
      // from the saved revs (origin 'main').
      // Save before versioning: if `saveChanges` throws a RevConflictError (a
      // concurrent commit landed first), nothing was versioned and the retry falls
      // through to the transform branch cleanly — no version minted from the
      // pre-transform changes is left stranded ahead of the real log.
      if (isOfflineOrBatch && committedChanges.length === 0) {
        if (!options?.historicalImport) {
          let nextRev = currentRev + 1;
          incomingChanges.forEach(c => (c.rev = nextRev++));
        }
        await store.saveChanges(docId, incomingChanges);
        if (!offlineSessionsHandled) {
          await handleOfflineSessionsAndBatches(store, sessionTimeoutMillis, docId, incomingChanges, 'main');
          offlineSessionsHandled = true;
        }
        return { catchupChanges, newChanges: incomingChanges, docReloadRequired };
      }

      // 5. Transform the incoming changes against committed changes (stateless — no state
      //    loaded). The queue keeps resent ALREADY-COMMITTED changes (raw ops, deduped
      //    in-request) as advance-only frame entries: rebaseChanges advances each foreign
      //    committed change through the raw resent head before dropping the head at its
      //    echo's rev, so a foreign commit that interleaved BEFORE the lost echo must meet
      //    the tail in that same frame here too. transformIncomingChanges removes each echo
      //    entry when the walk reaches it and commits only non-echo survivors.
      // Store-reported duplicates (committed at rev <= baseRev) are excluded outright
      // rather than kept as advance-only frame entries: their effects are already part
      // of the base every later change was rebased onto, so the resent tail's frames
      // include them without any walk-through.
      const seenQueueIds = new Set<string>();
      const queueChanges = changes.filter(c => {
        if (storeCommittedIds.has(c.id) || seenQueueIds.has(c.id)) return false;
        seenQueueIds.add(c.id);
        return true;
      }) as Change[];
      const transformedChanges = transformIncomingChanges(
        queueChanges,
        allCommittedChanges,
        currentRev,
        options?.forceCommit,
        isOwnCommitted
      );

      if (transformedChanges.length > 0) {
        // Save before versioning (same ordering as the fast-forward branch) so a
        // RevConflictError on save never leaves a version behind to retry against.
        await store.saveChanges(docId, transformedChanges);
        // Version the offline/batch session from the changes that ACTUALLY persisted
        // (their post-transform revs), never the pre-transform claimed revs. When an
        // offline change rebases to a no-op it isn't saved — versioning the claimed
        // rev here would mint an orphan version pointing past the committed log, which
        // poisons getDoc's reported rev and never gets cleaned up.
        if (isOfflineOrBatch && !offlineSessionsHandled) {
          const origin = options?.historicalImport ? 'main' : 'offline-branch';
          await handleOfflineSessionsAndBatches(store, sessionTimeoutMillis, docId, transformedChanges, origin);
          offlineSessionsHandled = true;
        }
      }

      // Return catchup changes and newly transformed changes separately
      return { catchupChanges, newChanges: transformedChanges, docReloadRequired };
    } catch (error) {
      // The store's write-time id guard fired: one or more incoming changes were
      // already committed (a rebased retry past the read-side dedup window, or a
      // concurrent duplicate send racing this one). Record the ids and retry — the
      // next attempt excludes them, so the request resolves as a resend instead of
      // committing a duplicate. Ids strictly grow per iteration (guarded below), so
      // this cannot spin; it shares the attempt budget with rev conflicts.
      if (error instanceof DuplicateChangeIdsError && attempt < MAX_CONFLICT_RETRIES - 1) {
        const newIds = error.duplicateIds.filter(id => !storeCommittedIds.has(id));
        if (newIds.length === 0) throw error; // store keeps rejecting ids we already excluded — bail rather than spin
        newIds.forEach(id => storeCommittedIds.add(id));
        continue;
      }
      if (error instanceof RevConflictError && attempt < MAX_CONFLICT_RETRIES - 1) continue;
      throw error;
    }
  }

  // Unreachable — the last iteration always re-throws
  throw new Error(`commitChanges: exhausted ${MAX_CONFLICT_RETRIES} retries for doc ${docId}`);
}

/**
 * Whether `batchId` is the multi-batch upload that CREATED this doc, identified by the doc's
 * oldest change. One row, and no `startAfter`, so a log that starts above rev 1 (pruned,
 * migrated) reads as itself rather than as a gap.
 */
async function createdByBatch(store: OTStoreBackend, docId: string, batchId?: string): Promise<boolean> {
  if (!batchId) return false;
  const [oldest] = await store.listChanges(docId, { limit: 1 });
  return oldest?.batchId === batchId;
}

/**
 * Advance the version watermark up toward `targetRev` in steps of at most `stepSize` changes,
 * so neither the in-commit change scan nor the out-of-band state build inside
 * `createVersionAtRev` ever loads a large backlog at once.
 *
 * - Session gap (`drainFully`): version everything through `targetRev`, including a final
 *   partial step of fewer than `stepSize` changes — the session is complete.
 * - Count trigger (`!drainFully`): version only while at least `stepSize` changes remain
 *   un-versioned, leaving the in-progress tail (< `stepSize`) to a later boundary crossing or
 *   session gap.
 *
 * A document many steps behind — e.g. one that accrued a large backlog before count versioning
 * was enabled, or a single commit that lands more than `stepSize` changes at once — is caught up
 * here over consecutive bounded steps in the *same* commit. Each step is individually bounded,
 * so memory stays flat; the number of steps scales with the backlog. This is a one-time heal:
 * once a document is within `stepSize` of its tip it stays there, so steady-state commits run at
 * most one or two steps. Stores that build version state inline and want to cap per-commit
 * latency for an extreme legacy backlog can throttle inside their `createVersion` implementation.
 *
 * With `stepSize <= 0` (count versioning disabled) a single unbounded version is created through
 * `targetRev`, preserving the original session-gap behavior for opted-out callers.
 */
async function catchUpVersions(
  store: OTStoreBackend,
  docId: string,
  targetRev: number,
  stepSize: number,
  drainFully: boolean
): Promise<void> {
  if (stepSize <= 0) {
    await createVersionAtRev(store, docId, targetRev);
    return;
  }

  // Read the watermark once; thereafter track it from each created version so neither this loop
  // nor createVersionAtRev re-queries listVersions per step.
  const [lastVersion] = await store.listVersions(docId, { limit: 1, reverse: true, orderBy: 'endRev' });
  let endRev = lastVersion?.endRev ?? 0;
  let parentId = lastVersion?.id;

  const minBacklog = drainFully ? 1 : stepSize;
  while (targetRev - endRev >= minBacklog) {
    const versionEndRev = Math.min(targetRev, endRev + stepSize);
    const version = await createVersionAtRev(store, docId, versionEndRev, { startAfterRev: endRev, parentId });
    // No changes in the range (already versioned, or a concurrent writer got there first) →
    // stop rather than spin.
    if (!version || version.endRev <= endRev) break;
    endRev = version.endRev;
    parentId = version.id;
  }
}

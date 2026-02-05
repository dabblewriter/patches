# LWW Migration Status

## What This Is

This file tracks progress on implementing LWW (Last-Write-Wins) as an alternative sync strategy alongside the existing OT (Operational Transformation) system. The intial implementation didn't hit the mark and so we are going through each section of the implementation one at a time to review, discuss, report, refactor, and fix with a new plan for each section.

**How to use**: @reference this file at the start of any Claude session to resume work. Once a section is complete, the user may make additional plans and fixes before moving onto the next section.

## Why LWW?

OT is great for collaborative text editing where you need to merge concurrent character-level changes. But for simpler data (user preferences, settings, status, presence), LWW is:

- Simpler to reason about
- More predictable (last write wins, period)
- Lighter weight (no change history, just fields)

## Key Differences

| Aspect              | OT                            | LWW                                  |
| ------------------- | ----------------------------- | ------------------------------------ |
| Storage             | Changes (history)             | Fields (current values + timestamps) |
| Conflict resolution | Transform concurrent ops      | Timestamp comparison                 |
| Use case            | Collaborative text            | Settings, preferences, status        |
| Complexity          | Higher (rebasing, transforms) | Lower (field-level comparison)       |

## Migration Sections

This migration had an initial pass that did poorly. We are now going through a section at a time to discuss what is there, what it _should_ be, and how to go about fixing it. Do not assume the existing code is correct. You can assume the completed sections are correct.

### Server-Side

- [x] **Section 1: LWWServer** - [Plan](/Users/jacob/.claude/plans/breezy-honking-hellman.md)
  - Core server implementation, store interface, commitChanges logic
  - Status: **Complete** ✓
- [x] **Section 2: LWWMemoryStoreBackend**
  - In-memory store for testing
  - Status: **Complete** ✓
- [x] **Section 3: LWWBranchManager**
  - Branching support (optional)
  - Status: **Complete** ✓

### Client-Side

- [x] **Section 4: Store Interface Refactoring** - [DAB-339]
  - Created `OTClientStore` and `LWWClientStore` interfaces extending `PatchesStore`
  - Status: **Complete** ✓
- [x] **Section 5: LWWInMemoryStore**
  - Refactored to implement `LWWClientStore`
  - Status: **Complete** ✓
- [x] **Section 6: LWWIndexedDBStore**
  - Refactored to implement `LWWClientStore`
  - Status: **Complete** ✓

### Algorithms

- [x] **Section 7: LWW Client Algorithms**
  - Deleted unused `makeLWWChange.ts` and `applyLWWChange.ts`
  - Created `consolidateOps.ts` with pure algorithm functions
  - Status: **Complete** ✓

### Integration

- [x] **Section 8: Patches integration**
  - Strategy option in Patches.openDoc()
  - Status: **Complete** ✓
- [x] **Section 9: Review and improve** - [Plan](/Users/jacob/.claude/plans/shiny-kindling-volcano.md)
  - Review the entire LWW implementation for bugs, inefficiencies, possible improvements, and suggested refactors
  - Status: **Complete** ✓
- [x] **Section 10: Exports & Tests**
  - Package exports, integration tests
  - Status: **Complete** ✓
- [x] **Section 11: Docs**
  - Write, fix, and improve documentation for end users
  - Status: **Complete** ✓

## How to Resume Work

1. Check the section status above
2. Read the linked plan file for the current section, or create a new plan and link it if we are starting a new section and a plan file doesn't exist yet.
3. Implement based on the plan
4. Update status here when complete

## Current Focus

**LWW Migration Complete!** 🎉

All sections have been completed. The LWW implementation is fully documented and ready for use.

## Completed Sections

### Section 1: LWWServer ✓

Key design decisions made:

- LWW stores fields, not changes
- `Change` object is just an RPC container
- Timestamps use simple `ms since epoch` (no HLC needed with central server)
- `incoming.ts >= existing.ts` → incoming wins (last write wins)
- Ops without `ts` use `serverNow` → effectively always win
- Compaction: snapshot every 200 revs
- Hierarchy: parent overwrites children, self-healing for invalid child-on-primitive

Files modified:

- `src/server/LWWServer.ts` - Rewritten with field-based design
- `src/server/LWWServer-fix.ts` - Deleted (superseded)
- `tests/server/LWWServer.spec.ts` - Rewritten with mock store implementing new interface

All 45 tests pass.

### Section 2: LWWMemoryStoreBackend ✓

In-memory implementation of `LWWStoreBackend` for testing.

Interfaces implemented:

- `LWWStoreBackend` - Core field storage (getSnapshot, saveSnapshot, listFields, saveFields, deleteDoc)
- `LWWVersioningStoreBackend` - Version snapshots
- `TombstoneStoreBackend` - Soft delete support
- `BranchingStoreBackend` - Branch metadata storage

Bug fixed during review:

- Removed erroneous revision advancement in `saveSnapshot` - it now only captures a point in time, not modify the revision counter

Files:

- `src/server/LWWMemoryStoreBackend.ts` - Implementation
- `tests/server/LWWMemoryStoreBackend.spec.ts` - 59 tests

All 103 LWW tests pass (59 store + 44 server).

### Section 3: LWWBranchManager ✓

Simplified branch manager that uses standard interfaces instead of a custom over-engineered interface.

Key changes:

- Deleted `LWWBranchingStoreBackend` interface (was over-engineered with unnecessary methods)
- `LWWBranchManager` now uses `LWWStoreBackend & BranchingStoreBackend` (standard interfaces)
- Uses `LWWServer.getChangesSince()` instead of custom store method
- Uses `saveSnapshot()` and `saveFields()` instead of custom `saveDoc()` and `saveFieldMetas()`
- Removed version copying complexity (not needed for basic branching)

LWW branch workflow:

1. `createBranch`: Copy current state snapshot + field metadata to new document
2. Make changes on branch (timestamps preserved)
3. `mergeBranch`: Get field changes since branch point, commit to source with LWW resolution

Tests now use real `LWWMemoryStoreBackend` + `LWWServer` instead of mocks, providing true integration testing.

Files:

- `src/server/LWWBranchManager.ts` - Simplified implementation
- `src/server/LWWServer.ts` - Removed `LWWBranchingStoreBackend` interface
- `tests/server/LWWBranchManager.spec.ts` - Rewritten with real store + server

All 123 LWW tests pass (59 store + 44 server + 20 branch manager).

### Section 4: Store Interface Refactoring ✓

Refactored client store interfaces to cleanly separate algorithm-agnostic storage from algorithm-specific concerns.

**Interface hierarchy:**

```
PatchesStore (base - 9 methods)
├── OTClientStore (+3 methods)
└── LWWClientStore (+6 methods)
```

**OTClientStore** extends PatchesStore:

- `getPendingChanges(docId)` - get pending changes array
- `savePendingChanges(docId, changes)` - save pending changes
- `applyServerChanges(docId, serverChanges, rebasedPendingChanges)` - apply with rebasing

**LWWClientStore** extends PatchesStore:

- `getPendingOps(docId, pathPrefixes?)` - get pending ops, optionally filtered
- `savePendingOps(docId, ops, pathsToDelete?)` - save ops with optional path deletion
- `getSendingChange(docId)` - get in-flight change for retry
- `saveSendingChange(docId, change)` - atomically save change AND clear pending ops
- `confirmSendingChange(docId)` - clear sending change after server ack
- `applyServerChanges(docId, serverChanges)` - apply without rebasing

**Key design decisions:**

- Stores are "dumb storage" - strategies handle consolidation logic
- Idempotency: `sendingChange` stays until acked, no cancel operation
- LWW state reconstruction: `snapshot → committedFields → sendingChange.ops → pendingOps`
- Path filtering in `getPendingOps` for efficient queries
- Atomic `saveSendingChange` clears all pending ops

Files created:

- `src/client/OTClientStore.ts`
- `src/client/LWWClientStore.ts`

Files modified:

- `src/client/InMemoryStore.ts` - implements `OTClientStore`
- `src/client/OTIndexedDBStore.ts` - implements `OTClientStore`
- `src/client/LWWInMemoryStore.ts` - implements `LWWClientStore`
- `src/client/LWWIndexedDBStore.ts` - implements `LWWClientStore`
- `src/client/LWWStrategy.ts` - uses `LWWClientStore`, handles consolidation
- `src/client/OTStrategy.ts` - uses `OTClientStore`
- `src/client/IndexedDBStore.ts` - removed algorithm-specific abstract methods

All 1504 tests pass.

### Section 5: LWWInMemoryStore ✓

Refactored to implement `LWWClientStore` interface with new API.

See Section 4 for interface details.

### Section 6: LWWIndexedDBStore ✓

Refactored to implement `LWWClientStore` interface with IndexedDB persistence.

IndexedDB stores:

- `committedFields` - server-confirmed field values
- `pendingOps` - local changes waiting to be sent (keyed by path)
- `sendingChanges` - in-flight changes being sent to server

See Section 4 for interface details.

### Section 7: LWW Client Algorithms ✓

Refactored algorithm layer to be clean, testable pure functions.

**Deleted (unused):**

- `src/algorithms/lww/makeLWWChange.ts`
- `src/algorithms/lww/applyLWWChange.ts`
- `tests/algorithms/lww/applyLWWChange.spec.ts`

**Created:**

- `src/algorithms/lww/consolidateOps.ts` - pure functions for op consolidation

**Key functions:**

- `consolidateFieldOp(existing, incoming)` - consolidates two ops on same path
- `consolidatePendingOps(existingOps, newOps)` - consolidates pending ops, detects parent overwrites

**Combinable operations** (following pattern from json-patch/syncable.ts):

- `@inc` - sums values
- `@bit` - combines bitmasks using `combineBitmasks`
- `@max` - keeps maximum value
- `@min` - keeps minimum value
- `replace`/`remove` - incoming wins

**Other changes:**

- `LWWStrategy` now imports `consolidatePendingOps` from algorithm module
- `LWWStrategy` uses `createChange` from `src/data/change.ts` instead of manual ID generation
- Removed custom `setValueAtPath`/`getValueAtPath`/`applyOpToState` from stores - now use `applyPatch`
- Removed `generateChangeId` from stores - now use `createChange`

All 1500 tests pass.

### Section 9: Review and improve ✓

Thorough review of entire LWW implementation for bugs, inefficiencies, and improvements.

**Critical bug fixed:**

- `LWWServer.commitChanges()` was not setting `committedAt` on response changes
- This caused `doc.committedRev` to never update and `doc.hasPending` to always be true
- Fixed by adding `committedAt: serverNow` to all `createChange()` calls in LWWServer
- Also fixed `getChangesSince()` to include `committedAt`

**Performance optimization:**

- Added `getCurrentRev(docId)` method to `LWWStoreBackend` interface
- More efficient than `getDoc()` when only revision is needed (avoids reconstructing full state)
- Implemented in `LWWMemoryStoreBackend`
- Updated `LWWServer.commitChanges()` and `deleteDoc()` to use `getCurrentRev()`

**IndexedDB optimization:**

- Batched `committedOps.put()` calls in `LWWIndexedDBStore.confirmSendingChange()`
- Batched `committedOps.put()` calls in `LWWIndexedDBStore.applyServerChanges()`
- Using `Promise.all()` instead of sequential awaits for better performance

**Documentation:**

- Added clarifying comment in `LWWStrategy.handleDocChange()` explaining why original ops (not consolidated) are broadcast

**Files modified:**

- `src/server/LWWServer.ts` - committedAt fix, getCurrentRev usage
- `src/server/types.ts` - Added getCurrentRev to LWWStoreBackend interface
- `src/server/LWWMemoryStoreBackend.ts` - Implemented getCurrentRev
- `src/client/LWWIndexedDBStore.ts` - Batched operations
- `src/client/LWWStrategy.ts` - Documentation comment
- `tests/server/LWWServer.spec.ts` - Added committedAt tests, updated mock store

All 1517 tests pass.

### Section 10: Exports & Tests ✓

Verified all LWW exports and added comprehensive integration tests.

**Export verification:**

All LWW exports confirmed working from:

- `@dabble/patches` - LWWDoc, LWWStrategy, factory functions
- `@dabble/patches/client` - All client LWW classes + LWWClientStore type
- `@dabble/patches/server` - LWWServer, LWWBranchManager, LWWMemoryStoreBackend + types

LWW algorithms (`consolidateOps`, `mergeServerWithLocal`) kept internal - used by LWWStrategy.

**Integration tests created:**

New `tests/integration/` directory with:

- `exports.spec.ts` - Verifies all LWW exports compile and instantiate (14 tests)
- `lww-integration.spec.ts` - End-to-end tests using real components (17 tests)

**Integration test scenarios:**

1. Basic round-trip (change → server → confirmation)
2. Concurrent changes to different fields (both succeed)
3. Same-field conflict resolution (timestamp-higher wins)
4. Delta ops consolidation (@inc, @max, @min combining)
5. Offline simulation (queue changes, sync on reconnect)

**Key insight discovered:**

The LWW server returns **catchup ops** to the sending client (ops from other clients), not the ops the client just sent. The actual committed ops are broadcast via `onChangesCommitted` to other clients. The sending client already applied changes locally.

All 1548 tests pass.

### Section 11: Docs ✓

Comprehensive LWW documentation for end users.

**New files created:**

- `docs/last-write-wins.md` - Complete LWW guide covering:
  - Decision framework (when to use LWW vs OT)
  - Core concepts (timestamps, fields, parent hierarchy)
  - Architecture (client and server components)
  - Client-server flow (step-by-step sync cycle)
  - Algorithm functions (consolidateOps, delta ops)
  - Backend store interfaces
  - Using LWW and OT together

- `docs/LWWServer.md` - Server API reference covering:
  - All public methods (commitChanges, getDoc, getChangesSince, etc.)
  - Configuration options
  - Event signals
  - Backend store requirements
  - Example usage with Express

**Files updated:**

- `README.md` - Added:
  - "Two Sync Strategies" section explaining OT vs LWW
  - LWW Quick Start examples (client and server)
  - LWWServer in Core Components
  - Strategy option in Basic Workflow

- `docs/algorithms.md` - Fixed:
  - Removed references to deleted files (makeLWWChange.ts, applyLWWChange.ts)
  - Added documentation for consolidateOps.ts functions
  - Updated directory tree

- `docs/shared-worker.md` - Expanded:
  - LWW section now explains actual store structure
  - State reconstruction order documented
  - Same benefits as OT explained

Documentation follows Amy Hoy style: direct, blunt, concrete examples, conversational but assertive.

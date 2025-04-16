# Branching and Merging Model in Patches

## Overview

Patches supports real-time collaborative editing with branching and merging, inspired by version control systems but tailored for Operational Transformation (OT) and JSON documents. This document explains how branching works, how versions and changes are managed, and the rationale behind key design decisions.

---

## Branch Creation

- **When a branch is created:**
  - The branch is created from a specific revision (`branchedRev`) of a main document (`branchedFromId`).
  - The branch document starts with an initial version at the same revision as the main doc's branch point (e.g., if branching at rev 10, the branch starts at rev 10).
  - The initial state snapshot is stored as a version (to support large documents and external storage like S3).
  - All subsequent changes in the branch increment the revision number, continuing from the branch point (e.g., first change is rev 11, etc.).
  - **Branches off branches are not allowed.** Attempting to branch from a branch will throw an error.

---

## Version and Change Metadata

| Field        | In Branch Doc (pre-merge)  | In Main Doc (after merge) |
| ------------ | -------------------------- | ------------------------- |
| `origin`     | `main`                     | `branch`                  |
| `rev`        | N (starts at branch point) | N (same as branch doc)    |
| `baseRev`    | N-1                        | `branchedRev`             |
| `groupId`    | branch doc ID              | branch doc ID             |
| `branchName` | branch name                | branch name               |
| `parentId`   | previous in branch         | previous in main doc      |

- **origin:**
  - In the branch doc, versions are marked as `origin: 'main'` (they behave like regular versions).
  - When merged, versions are copied to the main doc with `origin: 'branch'`.
- **rev:**
  - The revision number continues from the branch point, so no translation is needed on merge.
- **baseRev:**
  - In the main doc after merge, all merged versions have `baseRev` set to the branch point (`branchedRev`).
- **groupId/branchName:**
  - Used to group and identify all versions/changes from a branch.

---

## Merging a Branch

- When merging:
  - All versions in the branch doc with `origin: 'main'` are copied to the main doc as `origin: 'branch'`.
  - Their `baseRev` is set to the branch point (`branchedRev`), and `groupId`/`branchName` are set appropriately.
  - `parentId` is set to the previous merged version in the main doc.
  - Offline versions in the branch (if any) are **not** merged; they remain in the branch doc.
  - All branch changes are flattened into a single change and committed to the main doc for efficiency.
  - The branch status is updated to `merged`.

---

## Rationale and Decisions

- **Branch doc starts at main doc's rev:**
  - Keeps revision numbers consistent and avoids translation on merge.
  - Supports large initial states via snapshots.
- **origin: 'main' pre-merge, 'branch' post-merge:**
  - Simplifies UI and logic; branch docs behave like regular docs until merged.
- **No branches off branches:**
  - Simplifies the model and avoids complex nested histories.
- **Flattened change on merge:**
  - Improves performance and reduces storage overhead in the main doc.
- **Offline versions not merged:**
  - Keeps main doc history clean; only committed branch work is merged.

---

## Example

1. **Create branch at rev 10:**
   - Branch doc starts at rev 10 with a snapshot.
2. **Make changes in branch:**
   - Changes at rev 11, 12, ...
3. **Merge branch:**
   - Versions at rev 11, 12, ... are copied to main doc as `origin: 'branch'`, `baseRev: 10`.
   - All changes are flattened and committed as a single change to the main doc.

---

## Summary

This branching model is designed for clarity, efficiency, and future flexibility. It supports large documents, efficient merges, and a clean, understandable version history for both users and developers.

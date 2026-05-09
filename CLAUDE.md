# CLAUDE.md

## Commands

- `npm install` — install dependencies
- `npm run dev` — development mode
- `npm run build` — typecheck and build
- `npm run test` — run all tests
- `npm run tdd` — watch mode
- `npm run lint` / `npm run lint:fix` — lint

## Overview

Patches is a TypeScript library for real-time collaborative apps. It implements two sync algorithms:

- **OT (Operational Transformation)**: centralized server, conflict rebasing, for collaborative editing
- **LWW (Last-Write-Wins)**: timestamp-based resolution, for settings and preferences

## Scope boundary

Patches is a **generic primitives library**. It is composed into other systems (Pup, app-specific clients) — it is not itself an application.

In scope:

- JSON documents, JSON Patch ops, snapshots
- OT and LWW algorithms
- Transport surface (WebSocket, SSE+REST, WebRTC)
- `StatusError` codes (401, 402, 403, 404, 410) propagated verbatim from the underlying transport

Out of scope — do **not** add these to Patches:

- Users, roles, invites, memberships, access-control models. Permission *enforcement* lives in the `AuthorizationProvider` interface (which the consuming server implements); Patches itself never decides what a user can do.
- App-specific vocabulary: projects, books, cover art, titles, libraries, anything that names a domain concept.
- Email sending, identity lookups (uid → name / email), notification fan-out — these are app-shaped concerns that belong in the consuming app's backend or in services like dabble-rest.
- UX policy for permission errors. Patches surfaces a `StatusError` with the HTTP code; the consuming app decides whether to close the doc, show a toast, redirect, or ignore. Do not embed automatic cleanup signals (`onRemoteDocAccessRevoked` etc.) — `docStates` already exposes the error and consumers can react.

If a contribution adds something that "really only makes sense for Dabble" (or for any specific app), it does not belong here. Land it in the app or in Pup's app-aware client SDK instead.

## Import Paths

```
@dabble/patches           — main/client
@dabble/patches/client    — client-specific
@dabble/patches/server    — server components
@dabble/patches/net       — networking
@dabble/patches/webrtc    — WebRTC
@dabble/patches/vue       — Vue 3 integration
@dabble/patches/solid     — Solid.js integration
@dabble/patches/micro     — Micro sync (standalone LWW + Delta text)
```

## Code Structure

```
src/
  client/       — client stores, algorithms, interfaces
  server/       — OTServer, LWWServer, branch managers
  algorithms/   — pure algorithm functions
    ot/client/  — OT client algorithms
    ot/server/  — OT server algorithms
    ot/shared/  — shared OT logic
    lww/        — LWW algorithms
  micro/        — standalone minimal LWW sync with special field types
  net/          — transport layer (WebSocket, SSE+REST, WebRTC)
  json-patch/   — JSON Patch operations
tests/          — mirrors src/ structure
docs/           — architecture and API documentation
```

## Documentation

Read these when working in a specific area:

| File                                 | Contents                                  |
| ------------------------------------ | ----------------------------------------- |
| `docs/operational-transformation.md` | OT algorithm, change flow, rebasing       |
| `docs/last-write-wins.md`            | LWW algorithm, conflict resolution        |
| `docs/algorithms.md`                 | Pure algorithm functions reference        |
| `docs/OTServer.md`                   | OTServer API and internals                |
| `docs/LWWServer.md`                  | LWWServer API and internals               |
| `docs/Patches.md`                    | Client Patches class API                  |
| `docs/PatchesDoc.md`                 | PatchesDoc API                            |
| `docs/PatchesSync.md`                | PatchesSync and networking                |
| `docs/PatchesBranchManager.md`       | Branching and merging                     |
| `docs/PatchesHistoryManager.md`      | History and versioning                    |
| `docs/branching.md`                  | Branching concepts and workflows          |
| `docs/net.md`                        | Transport layer                           |
| `docs/websocket.md`                  | WebSocket protocol                        |
| `docs/sse-rest.md`                   | SSE + REST transport                      |
| `docs/concurrency.md`                | Concurrency utilities for custom backends |
| `docs/json-patch.md`                 | JSON Patch format                         |
| `src/vue/README.md`                  | Vue 3 integration                         |
| `src/solid/README.md`                | Solid.js integration                      |
| `src/micro/README.md`                | Micro sync system                         |

## Testing

Tests mirror `src/` in `tests/`. Always run and fix tests when writing or refactoring.

- Single file: `npm run test -- tests/path/to/file.spec.ts`
- By pattern: `npm run test -- -t "pattern"`

## Before Committing

After making code changes, always verify that type, lint, and format checks pass before considering the task complete.

1. `npm run type:check`
2. `npm run lint`
3. `npm run format:check`
4. `npm run test`

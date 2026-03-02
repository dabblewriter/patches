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

## Import Paths

```
@dabble/patches           — main/client
@dabble/patches/client    — client-specific
@dabble/patches/server    — server components
@dabble/patches/net       — networking
@dabble/patches/webrtc    — WebRTC
@dabble/patches/vue       — Vue 3 integration
@dabble/patches/solid     — Solid.js integration
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
  net/          — transport layer (WebSocket, WebRTC)
  json-patch/   — JSON Patch operations
tests/          — mirrors src/ structure
docs/           — architecture and API documentation
```

## Documentation

Read these when working in a specific area:

| File | Contents |
|------|----------|
| `docs/operational-transformation.md` | OT algorithm, change flow, rebasing |
| `docs/last-write-wins.md` | LWW algorithm, conflict resolution |
| `docs/algorithms.md` | Pure algorithm functions reference |
| `docs/OTServer.md` | OTServer API and internals |
| `docs/LWWServer.md` | LWWServer API and internals |
| `docs/Patches.md` | Client Patches class API |
| `docs/PatchesDoc.md` | PatchesDoc API |
| `docs/PatchesSync.md` | PatchesSync and networking |
| `docs/PatchesBranchManager.md` | Branching and merging |
| `docs/PatchesHistoryManager.md` | History and versioning |
| `docs/branching.md` | Branching concepts and workflows |
| `docs/net.md` | Transport layer |
| `docs/websocket.md` | WebSocket protocol |
| `docs/json-patch.md` | JSON Patch format |
| `src/vue/README.md` | Vue 3 integration |
| `src/solid/README.md` | Solid.js integration |

## Testing

Tests mirror `src/` in `tests/`. Always run and fix tests when writing or refactoring.

- Single file: `npm run test -- tests/path/to/file.spec.ts`
- By pattern: `npm run test -- -t "pattern"`

## Before Committing

Run in order, fix any issues before committing:

1. `npm run lint:fix`
2. `npm run build`
3. `npm run test`

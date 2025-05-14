# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

- **Install dependencies**: `npm install`
- **Development mode**: `npm run dev` (runs Vite in development mode)
- **Build the library**: `npm run build` (uses svelte-package to build the library)
- **Run tests**: `npm run test` (runs all Vitest tests)
- **Test-driven development**: `npm run tdd` (runs Vitest in watch mode)

## Project Overview

Patches is a TypeScript library for building real-time collaborative applications. It leverages Operational Transformation (OT) with a centralized server model to ensure document consistency across multiple clients.

### Import Paths

The library uses subpath exports. Use these import paths:

- Client client: `@dabble/patches`
- Server components: `@dabble/patches/server`
- Networking: `@dabble/patches/net`

### Key Features

- **Centralized OT**: Uses a central server to definitively order operations
- **Immutable State**: Document state is immutable, with changes creating new objects
- **Linear History**: Server maintains a single, linear history of document revisions
- **Offline Support**: Includes versioning and snapshot functionality
- **Branching**: Supports branch creation and merging for concurrent work
- **Transport Options**: WebSocket and WebRTC support for networking

## Architecture

The codebase is divided into client-side and server-side components:

### Client-Side Components

1. **Patches**: Main client entry point for document management
2. **PatchesDoc**: Represents a single collaborative document
   - Handles local state management and optimistic updates
   - Implements client-side OT logic for rebasing changes

### Server-Side Components

1. **PatchesServer**: Core server-side logic
   - Processes incoming changes, performs transformations
   - Maintains document history
2. **PatchesHistoryManager**: Handles document history and versioning
3. **PatchesBranchManager**: Manages branching and merging workflows

### Networking & Persistence

1. **Transport Layer**:
   - **WebSocketTransport**: Server-mediated communication
   - **WebRTCTransport**: Peer-to-peer communication
2. **Persistence Layer**:
   - **PatchesStore**: Client-side storage interface
   - **PatchesStoreBackend**: Server-side storage interface
   - Implementations: InMemoryStore, IndexedDBStore

### OT Implementation

The system uses JSON Patch operations (RFC 6902) with custom OT transformations to handle concurrent edits.

## Code Structure

- `/src/client`: Client-side implementation
- `/src/server`: Server-side implementation
- `/src/json-patch`: JSON Patch operations and transformations
- `/src/net`: Networking and transport layer
- `/tests`: Test files matching the source structure

## Important Implementation Details

1. **Change Processing Flow**:

   - Client makes a change → optimistically applied locally
   - Change sent to server with baseRev (server revision it was based on)
   - Server transforms against concurrent changes, assigns new revision
   - Transformed change is broadcast to all clients

2. **Versioning**:

   - System creates snapshots after 30 minutes of inactivity
   - Each version may represent one or many changes
   - Allows efficient loading of large documents with many changes

3. **State Handling**:

   - Document state is immutable
   - Changes are made through proxy in `doc.change(state => state.prop = 'new value')`

4. **Usage Example**:

   ```typescript
   // Client-side
   import { Patches, InMemoryStore } from '@dabble/patches';
   import { PatchesSync } from '@dabble/patches/net';

   // Server-side
   import { PatchesServer } from '@dabble/patches/server';
   ```

## Testing Approach

Tests are written using Vitest and follow a structure mirroring the source code. Most tests use mocking to isolate components.

To run a single test file:

```bash
npm run test -- tests/path/to/file.spec.ts
```

To run tests with a specific pattern:

```bash
npm run test -- -t "test description pattern"
```

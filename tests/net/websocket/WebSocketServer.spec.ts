import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerTransport } from '../../../src/net/protocol/types.js';
import type { AuthorizationProvider } from '../../../src/net/websocket/AuthorizationProvider.js';
import { WebSocketServer } from '../../../src/net/websocket/WebSocketServer.js';
import type { PatchesBranchManager } from '../../../src/server/PatchesBranchManager.js';
import type { PatchesHistoryManager } from '../../../src/server/PatchesHistoryManager.js';
import type { PatchesServer } from '../../../src/server/PatchesServer.js';

// Ensure mocks are reset after the entire suite (Vitest already resets between tests via beforeEach).

describe('WebSocketServer – history, branching & auth integration', () => {
  let transport: ServerTransport;
  let patches: PatchesServer;
  let history: PatchesHistoryManager;
  let branches: PatchesBranchManager;
  let auth: AuthorizationProvider & { canAccess: ReturnType<typeof vi.fn> };
  let server: WebSocketServer;

  beforeEach(() => {
    // Mock transport – we do *not* exercise JSON-RPC parsing here
    transport = {
      getConnectionIds: vi.fn(() => ['conn1']),
      send: vi.fn(),
      onMessage: vi.fn(() => {
        return () => {};
      }),
    } as unknown as ServerTransport;

    // patches instance isn't exercised by the tests below
    patches = {} as PatchesServer;

    // Mock history manager
    history = {
      listVersions: vi.fn(async () => []),
      createVersion: vi.fn(async () => 'version-id'),
      updateVersion: vi.fn(async () => {}),
      getStateAtVersion: vi.fn(async () => ({ state: {}, rev: 0 })),
      getChangesForVersion: vi.fn(async () => []),
      listServerChanges: vi.fn(async () => []),
    } as unknown as PatchesHistoryManager;

    // Mock branch manager
    branches = {
      listBranches: vi.fn(async () => []),
      createBranch: vi.fn(async () => 'branch-id'),
      closeBranch: vi.fn(async () => {}),
      mergeBranch: vi.fn(async () => []),
    } as unknown as PatchesBranchManager;

    // Mock auth – default to allow all, individual tests will change return value if needed
    auth = {
      canAccess: vi.fn(() => true),
    } as AuthorizationProvider & { canAccess: ReturnType<typeof vi.fn> };

    server = new WebSocketServer({ transport, patches, history, branches, auth });
  });

  // -----------------------------------------------------------------
  // History manager wrappers
  // -----------------------------------------------------------------

  it('listVersions delegates to history manager & enforces READ access', async () => {
    const options = { limit: 10 };
    await server.listVersions('conn1', { docId: 'doc-1', options });

    expect(history.listVersions).toHaveBeenCalledWith('doc-1', options);
    expect(auth.canAccess).toHaveBeenCalledWith('conn1', 'doc-1', 'read', 'listVersions', {
      docId: 'doc-1',
      options,
    });
  });

  it('createVersion delegates to history manager & enforces WRITE access', async () => {
    const versionId = await server.createVersion('conn1', { docId: 'doc-1', name: 'My Version' });

    expect(versionId).toBe('version-id');
    expect(history.createVersion).toHaveBeenCalledWith('doc-1', 'My Version');
    expect(auth.canAccess).toHaveBeenCalledWith('conn1', 'doc-1', 'write', 'createVersion', {
      docId: 'doc-1',
      name: 'My Version',
    });
  });

  // -----------------------------------------------------------------
  // Branch manager wrappers
  // -----------------------------------------------------------------

  it('listBranches delegates to branch manager & enforces READ access', async () => {
    await server.listBranches('conn1', { docId: 'doc-1' });

    expect(branches.listBranches).toHaveBeenCalledWith('doc-1');
    expect(auth.canAccess).toHaveBeenCalledWith('conn1', 'doc-1', 'read', 'listBranches', {
      docId: 'doc-1',
    });
  });

  it('createBranch delegates to branch manager & enforces WRITE access', async () => {
    const metadata = { purpose: 'testing' };
    await server.createBranch('conn1', {
      docId: 'doc-1',
      rev: 5,
      branchName: 'feature-x',
      metadata,
    });

    expect(branches.createBranch).toHaveBeenCalledWith('doc-1', 5, 'feature-x', metadata);
    expect(auth.canAccess).toHaveBeenCalledWith('conn1', 'doc-1', 'write', 'createBranch', {
      docId: 'doc-1',
      rev: 5,
      branchName: 'feature-x',
      metadata,
    });
  });

  // -----------------------------------------------------------------
  // Authorisation failures
  // -----------------------------------------------------------------

  it('throws READ_FORBIDDEN when auth denies read', async () => {
    (auth.canAccess as any).mockReturnValue(false);
    await expect(server.listVersions('conn1', { docId: 'doc-1', options: {} })).rejects.toThrow('READ_FORBIDDEN:doc-1');
  });

  it('throws WRITE_FORBIDDEN when auth denies write', async () => {
    (auth.canAccess as any).mockReturnValue(false);
    await expect(server.createBranch('conn1', { docId: 'doc-1', rev: 1, branchName: 'b' })).rejects.toThrow(
      'WRITE_FORBIDDEN:doc-1'
    );
  });
});

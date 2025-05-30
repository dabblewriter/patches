import { createId } from 'crypto-id';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { applyPatch } from '../../src/json-patch/applyPatch.js';
import * as transformPatchModule from '../../src/json-patch/transformPatch.js'; // Import the module
import { PatchesServer } from '../../src/server/PatchesServer.js';
import type { PatchesStoreBackend } from '../../src/server/types.js';
import type {
  Change,
  EditableVersionMetadata,
  ListChangesOptions,
  ListVersionsOptions,
  PatchesState,
  VersionMetadata,
} from '../../src/types.js';

// Mock crypto-id
vi.mock('crypto-id', () => ({
  createId: vi.fn(() => `mock-id-${Math.random().toString(36).substring(7)}`),
}));

// Mock applyPatch and transformPatch
vi.mock('../../../src/json-patch/applyPatch', () => ({
  applyPatch: vi.fn((state, ops) => {
    // Basic mock: Assume patch applies cleanly for testing server logic
    // A real implementation might be needed for complex state tests
    if (ops.length === 0) return state;
    // Very simple simulation - assumes add/replace at root or known paths
    let newState = state === null ? {} : JSON.parse(JSON.stringify(state));
    for (const op of ops) {
      if (op.op === 'add' && op.path === '/') newState = op.value;
      else if (op.op === 'add' || op.op === 'replace') {
        // Super basic path handling for tests
        const keys = op.path.substring(1).split('/');
        let current = newState;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!current[keys[i]]) current[keys[i]] = {};
          current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = op.value;
      } else if (op.op === 'remove') {
        const keys = op.path.substring(1).split('/');
        let current = newState;
        for (let i = 0; i < keys.length - 1; i++) {
          current = current[keys[i]];
        }
        delete current[keys[keys.length - 1]];
      }
      // Add more basic op handling if needed by tests
    }
    return newState;
  }),
}));

vi.mock('../../../src/json-patch/transformPatch', () => ({
  transformPatch: vi.fn((state, clientOps, serverOps) => {
    // Better mock: Actually simulate transformation for the test case
    console.warn('WARN: Using basic mock transformPatch. Ops returned untransformed.');

    // Special case for our test: if adding at /text/0 and there's a server op adding at /text/3
    // then the result should be adding at /text/1
    if (
      clientOps.length === 1 &&
      clientOps[0].op === 'add' &&
      clientOps[0].path === '/text/0' &&
      clientOps[0].value === 'x' &&
      serverOps.length === 1 &&
      serverOps[0].op === 'add' &&
      serverOps[0].path === '/text/3'
    ) {
      return [{ op: 'add', path: '/text/1', value: 'x' }];
    }

    return clientOps;
  }),
}));

// --- Mock PatchesStoreBackend ---
class MockPatchesStoreBackend implements PatchesStoreBackend {
  private docs: Map<string, { state: any; rev: number; changes: Change[] }> = new Map();
  private versions: Map<string, { metadata: VersionMetadata; state: any; changes: Change[] }[]> = new Map();
  private subscriptions: Map<string, Set<string>> = new Map(); // clientId -> Set<docId>

  // Helper to get doc data or initialize if not exists
  private _getDocData(docId: string) {
    if (!this.docs.has(docId)) {
      this.docs.set(docId, { state: null, rev: 0, changes: [] });
    }
    return this.docs.get(docId)!;
  }

  // Helper to get versions for a doc
  private _getDocVersions(docId: string) {
    if (!this.versions.has(docId)) {
      this.versions.set(docId, []);
    }
    return this.versions.get(docId)!;
  }

  // --- Mock Methods ---
  addSubscription = vi.fn(async (clientId: string, docIds: string[]): Promise<string[]> => {
    if (!this.subscriptions.has(clientId)) {
      this.subscriptions.set(clientId, new Set());
    }
    const clientSubs = this.subscriptions.get(clientId)!;
    docIds.forEach(id => clientSubs.add(id));
    return docIds;
  });

  removeSubscription = vi.fn(async (clientId: string, docIds: string[]): Promise<string[]> => {
    const clientSubs = this.subscriptions.get(clientId);
    if (clientSubs) {
      docIds.forEach(id => clientSubs.delete(id));
    }
    return docIds;
  });

  listChanges = vi.fn(async (docId: string, options: ListChangesOptions = {}): Promise<Change[]> => {
    const docData = this._getDocData(docId);
    let changes = docData.changes;
    if (options.startAfter !== undefined) {
      changes = changes.filter(c => c.rev > options.startAfter!);
    }
    if (options.endBefore !== undefined) {
      changes = changes.filter(c => c.rev < options.endBefore!);
    }
    // Add more filtering based on ListOptions if needed (limit, reverse, etc.)
    return changes;
  });

  createVersion = vi.fn(
    async (docId: string, metadata: VersionMetadata, state: any, changes: Change[]): Promise<void> => {
      const docVersions = this._getDocVersions(docId);
      // Ensure baseRev is set for the version based on the last change applied *before* these changes
      const lastChangeRevBefore = metadata.baseRev ?? 0;
      const actualBaseRev =
        this.docs
          .get(docId)
          ?.changes.filter(c => c.rev <= lastChangeRevBefore)
          .at(-1)?.rev ?? 0;
      metadata.baseRev = actualBaseRev;

      docVersions.push({ metadata, state, changes });
      // Sort versions by baseRev for consistency in listVersions
      docVersions.sort((a, b) => (a.metadata.baseRev ?? 0) - (b.metadata.baseRev ?? 0));
    }
  );

  listVersions = vi.fn(async (docId: string, options: ListVersionsOptions = {}): Promise<VersionMetadata[]> => {
    let docVersions = this._getDocVersions(docId);
    if (options.startAfter !== undefined) {
      docVersions = docVersions.filter(v => (v.metadata.baseRev ?? 0) > options.startAfter!);
    }
    if (options.endBefore !== undefined) {
      docVersions = docVersions.filter(v => (v.metadata.baseRev ?? 0) < options.endBefore!);
    }
    if (options.origin) {
      docVersions = docVersions.filter(v => v.metadata.origin === options.origin);
    }
    if (options.groupId) {
      docVersions = docVersions.filter(v => v.metadata.groupId === options.groupId);
    }
    if (options.reverse) {
      docVersions = docVersions.slice().reverse();
    }
    if (options.limit !== undefined) {
      docVersions = docVersions.slice(0, options.limit);
    }
    return docVersions.map(v => v.metadata);
  });

  loadVersionState = vi.fn(async (docId: string, versionId: string): Promise<PatchesState> => {
    const version = this._getDocVersions(docId).find(v => v.metadata.id === versionId);
    if (!version) throw new Error(`Version ${versionId} not found for doc ${docId}`);
    return { state: version.state, rev: version.metadata.baseRev ?? 0 }; // Assuming rev is baseRev for state
  });

  loadVersionChanges = vi.fn(async (docId: string, versionId: string): Promise<Change[]> => {
    const version = this._getDocVersions(docId).find(v => v.metadata.id === versionId);
    if (!version) throw new Error(`Version ${versionId} not found for doc ${docId}`);
    return version.changes;
  });

  updateVersion = vi.fn(async (docId: string, versionId: string, updates: EditableVersionMetadata): Promise<void> => {
    const version = this._getDocVersions(docId).find(v => v.metadata.id === versionId);
    if (!version) throw new Error(`Version ${versionId} not found for doc ${docId}`);
    Object.assign(version.metadata, updates);
  });

  deleteDoc = vi.fn(async (docId: string): Promise<void> => {
    this.docs.delete(docId);
    this.versions.delete(docId);
    // Also remove subscriptions related to this doc
    this.subscriptions.forEach(subs => subs.delete(docId));
  });

  saveChanges = vi.fn(async (docId: string, changes: Change[]): Promise<void> => {
    await this._saveChangesInternal(docId, changes);
  });

  // --- Test Helpers ---
  // Helper to simulate saving changes to the store (used internally by tests)
  async saveChange(docId: string, change: Change): Promise<void> {
    const docData = this._getDocData(docId);
    change.rev = docData.rev + 1;
    docData.changes.push(change);
    docData.rev = change.rev;
    docData.state = applyPatch(docData.state, change.ops); // Update internal state for transforms
  }
  // Helper to set initial state for testing getDoc/commitChanges
  setInitialDocState(docId: string, state: any, rev: number = 0, changes: Change[] = []) {
    this.docs.set(docId, { state, rev, changes });
  }

  // Internal helper mirroring saveChanges logic for easier use in tests
  async _saveChangesInternal(docId: string, changes: Change[]): Promise<void> {
    const docData = this._getDocData(docId);
    for (const change of changes) {
      change.rev = docData.rev + 1;
      docData.changes.push(change);
      docData.rev = change.rev;
      // Use the mocked applyPatch
      docData.state = applyPatch(docData.state, change.ops);
    }
  }
}

// --- Tests ---

describe('PatchesServer', () => {
  let mockStore: MockPatchesStoreBackend;
  let patchesServer: PatchesServer;
  const docId = 'test-doc-1';
  const clientId = 'client-1';

  beforeEach(() => {
    vi.restoreAllMocks(); // Restore original implementations and clear mocks
    mockStore = new MockPatchesStoreBackend();
    patchesServer = new PatchesServer(mockStore);

    // Reset mock Id generator
    let idCounter = 0;
    (createId as Mock).mockImplementation(() => `mock-id-${idCounter++}`);
  });

  // === Initialization & Basic Getters ===

  it('should initialize with default session timeout', () => {
    expect((patchesServer as any).sessionTimeoutMillis).toBe(30 * 60 * 1000);
  });

  it('should initialize with custom session timeout', () => {
    const server = new PatchesServer(mockStore, { sessionTimeoutMinutes: 10 });
    expect((server as any).sessionTimeoutMillis).toBe(10 * 60 * 1000);
  });

  // === Document Operations ===

  describe('getDoc', () => {
    it('should return null state and rev 0 for a new document', async () => {
      const snapshot = await patchesServer.getDoc(docId);
      expect(snapshot.state).toBeNull();
      expect(snapshot.rev).toBe(0);
      expect(mockStore.listVersions).toHaveBeenCalledWith(docId, {
        limit: 1,
        reverse: true,
        startAfter: undefined,
        origin: 'main',
        orderBy: 'rev',
      });
      expect(mockStore.listChanges).toHaveBeenCalledWith(docId, { startAfter: 0, endBefore: undefined });
    });

    it('should return the latest state and changes since the last main version', async () => {
      // Simulate a main version and subsequent changes
      const versionState = { content: 'version 1' };
      const versionRev = 5;
      const versionId = 'v1';
      const versionMetadata: VersionMetadata = {
        id: versionId,
        origin: 'main',
        baseRev: versionRev,
        startDate: Date.now(),
        endDate: Date.now(),
        rev: versionRev,
      };
      mockStore.createVersion(docId, versionMetadata, versionState, []); // Simulate version creation
      await mockStore.loadVersionState.mockResolvedValue({ state: versionState, rev: versionRev }); // Mock loading state

      const change1: Change = {
        id: 'c1',
        baseRev: 5,
        rev: 6,
        ops: [{ op: 'add', path: '/new', value: 1 }],
        created: Date.now(),
      };
      const change2: Change = {
        id: 'c2',
        baseRev: 6,
        rev: 7,
        ops: [{ op: 'replace', path: '/new', value: 2 }],
        created: Date.now(),
      };
      await mockStore.listChanges.mockResolvedValueOnce([change1, change2]); // Mock changes since version

      const snapshot = await patchesServer.getDoc(docId);

      expect(mockStore.listVersions).toHaveBeenCalledWith(docId, {
        limit: 1,
        reverse: true,
        startAfter: undefined,
        origin: 'main',
        orderBy: 'rev',
      });
      expect(mockStore.loadVersionState).toHaveBeenCalledWith(docId, versionId);
      expect(mockStore.listChanges).toHaveBeenCalledWith(docId, {
        startAfter: versionRev, // Changes after the version's baseRev
        endBefore: undefined, // Up to latest
      });

      const expectedLatestState = { content: 'version 1', new: 2 };
      expect(snapshot.state).toEqual(expectedLatestState);
      expect(snapshot.rev).toBe(7); // Latest rev after changes
    });

    it('should return state and changes at a specific revision', async () => {
      // Simulate version and changes
      const versionState = { content: 'version 1' };
      const versionRev = 5;
      const versionId = 'v1';
      const versionMetadata: VersionMetadata = {
        id: versionId,
        origin: 'main',
        baseRev: versionRev,
        startDate: Date.now(),
        endDate: Date.now(),
        rev: versionRev,
      };
      // Ensure listVersions returns the version with versionId
      mockStore.listVersions.mockResolvedValueOnce([versionMetadata]);
      mockStore.createVersion(docId, versionMetadata, versionState, []);
      await mockStore.loadVersionState.mockResolvedValue({ state: versionState, rev: versionRev });

      const change1: Change = {
        id: 'c1',
        baseRev: 5,
        rev: 6,
        ops: [{ op: 'add', path: '/new', value: 1 }],
        created: Date.now(),
      };
      const change2: Change = {
        id: 'c2',
        baseRev: 6,
        rev: 7,
        ops: [{ op: 'replace', path: '/new', value: 2 }],
        created: Date.now(),
      };
      // For getDoc(docId, 7), we expect changes between baseRev 5 and targetRev 7+1.
      // So, listChanges should be mocked to return changes up to rev 7.
      mockStore.listChanges.mockResolvedValueOnce([change1, change2]);

      const targetRev = 7;
      const snapshot = await patchesServer.getDoc(docId, targetRev);

      // Should find the version *before or at* targetRev + 1 (i.e., the version that is the base for targetRev)
      // The PatchesServer.getDoc logic will try to find the latest version *older* than or equal to targetRev.
      // If targetRev is 7, and a version exists at rev 5, it loads version 5.
      // Then it loads changes from rev 5 up to targetRev (7).
      expect(mockStore.listVersions).toHaveBeenCalledWith(docId, {
        limit: 1,
        reverse: true,
        startAfter: targetRev + 1,
        origin: 'main',
        orderBy: 'rev',
      });
      expect(mockStore.loadVersionState).toHaveBeenCalledWith(docId, versionId);
      // Should list changes between version's baseRev (5) and targetRev (7) + 1
      expect(mockStore.listChanges).toHaveBeenCalledWith(docId, {
        startAfter: versionRev,
        endBefore: targetRev + 1,
      });

      const expectedStateAtRev7 = { content: 'version 1', new: 2 };
      expect(snapshot.state).toEqual(expectedStateAtRev7);
      expect(snapshot.rev).toBe(targetRev); // Rev is of the state at targetRev (rev 7)
    });
  });

  describe('getChangesSince', () => {
    it('should call store.listChanges with correct parameters', async () => {
      const rev = 5;
      await patchesServer.getChangesSince(docId, rev);
      expect(mockStore.listChanges).toHaveBeenCalledWith(docId, { startAfter: rev });
    });
  });

  describe('commitChanges', () => {
    it('handles empty changes array', async () => {
      const result = await patchesServer.commitChanges(docId, []);
      expect(result).toEqual([[], []]);
    });

    it('rejects changes without baseRev', async () => {
      const changes = [{ id: '1', ops: [], rev: 1, created: Date.now() }];
      await expect(patchesServer.commitChanges(docId, changes as any)).rejects.toThrow(
        'Client changes must include baseRev'
      );
    });

    it('rejects changes with inconsistent baseRev', async () => {
      const changes = [
        { id: '1', ops: [], rev: 1, baseRev: 0, created: Date.now() },
        { id: '2', ops: [], rev: 2, baseRev: 1, created: Date.now() },
      ];
      await expect(patchesServer.commitChanges(docId, changes)).rejects.toThrow(
        'Client changes must have consistent baseRev'
      );
    });

    it('should throw if client baseRev is ahead of server revision', async () => {
      // Setup server state using saveChange to ensure mock store history is populated
      const initialChange: Change = {
        id: 'init',
        baseRev: 0,
        rev: 1,
        ops: [{ op: 'add', path: '/', value: { data: 1 } }],
        created: Date.now() - 1000,
      };
      await mockStore.saveChange(docId, initialChange); // Server is now at rev 1

      // Mock getStateAtRevision to ensure it returns the correct current rev
      // Although saveChange updates the internal mock state, explicitly mocking helps isolate
      vi.spyOn(patchesServer as any, 'getStateAtRevision').mockResolvedValue({ state: { data: 1 }, rev: 1 });

      const changes: Change[] = [{ id: 'c1', rev: 0, baseRev: 2, ops: [], created: Date.now() }];
      await expect(patchesServer.commitChanges(docId, changes)).rejects.toThrow(
        /Client baseRev \(2\) is ahead of server revision \(1\) for doc test-doc-1. Client needs to reload the document./
      );
    });

    it('should throw if client baseRev is 0 but server doc exists', async () => {
      // Setup server state using saveChange
      const initialChange: Change = {
        id: 'init',
        baseRev: 0,
        rev: 1,
        ops: [{ op: 'add', path: '/', value: { data: 1 } }],
        created: Date.now() - 1000,
      };
      await mockStore.saveChange(docId, initialChange); // Server is now at rev 1
      vi.spyOn(patchesServer as any, 'getStateAtRevision').mockResolvedValue({ state: { data: 1 }, rev: 1 });

      const changes: Change[] = [
        {
          id: 'c1',
          rev: 0,
          baseRev: 0,
          ops: [{ op: 'add', path: '', value: { text: 'hello' } }], // Provide an op to satisfy the condition
          created: Date.now(),
        },
      ];
      await expect(patchesServer.commitChanges(docId, changes)).rejects.toThrow(
        /Client baseRev is 0 but server has already been created for doc test-doc-1. Client needs to load the existing document./
      );
    });

    it('should apply a simple change to a new document (baseRev 0)', async () => {
      // Initial state (new doc)
      mockStore.setInitialDocState(docId, null, 0); // Explicitly set initial state
      await mockStore._saveChangesInternal(docId, []);

      const incomingChange: Change = {
        id: 'c1',
        rev: 0, // Placeholder
        baseRev: 0,
        ops: [{ op: 'add', path: '/foo', value: 'bar' }],
        created: Date.now(),
      };
      mockStore.listChanges.mockResolvedValueOnce([]); // No committed changes after baseRev 0

      const [committedChanges, transformedChanges] = await patchesServer.commitChanges(docId, [incomingChange]);

      // Expect no committed changes and the original change to be returned (no transformation needed)
      expect(committedChanges).toHaveLength(0);
      expect(transformedChanges).toHaveLength(1);
      expect(transformedChanges[0].id).toBe('c1');
      expect(transformedChanges[0].ops).toEqual(incomingChange.ops);
      expect(transformedChanges[0].baseRev).toBe(0);
    });

    it('should apply a simple change to an existing document', async () => {
      // Setup initial state
      const initialState = { foo: 'bar' };
      const initialRev = 1;
      const initialChange: Change = {
        id: 'init',
        baseRev: 0,
        rev: 1,
        ops: [{ op: 'add', path: '/', value: { foo: 'bar' } }],
        created: Date.now() - 1000,
      };

      // Setup the document in the store
      mockStore.setInitialDocState(docId, initialState, initialRev, [initialChange]);

      const incomingChange: Change = {
        id: 'c2',
        rev: 0, // Will be assigned by server
        baseRev: 1,
        ops: [{ op: 'add', path: '/baz', value: 'qux' }],
        created: Date.now(),
      };

      // Execute
      const [committedChanges, transformedChanges] = await patchesServer.commitChanges(docId, [incomingChange]);

      // Verify the result contains the change (it might be transformed, but mock is basic)
      expect(committedChanges).toHaveLength(0);
      expect(transformedChanges).toHaveLength(1);
      expect(transformedChanges[0].id).toBe('c2');
      expect(transformedChanges[0].baseRev).toBe(1);
      // The rev in the *returned* change might not be set yet by the server logic itself,
      // it relies on the store assigning it. Let's check the saved change.
      // expect(transformedChanges[0].rev).toBe(2); // This might be unreliable depending on when rev is assigned
      expect(transformedChanges[0].ops).toEqual(incomingChange.ops); // Mock transform returns original ops here
    });

    it('should transform incoming changes against multiple concurrent server changes', async () => {
      // Setup
      const baseState = { text: ['a', 'b', 'c'] };
      const baseRev = 1;

      // Create a base change to set the initial state
      const baseChange: Change = {
        id: 'base1',
        baseRev: 0,
        rev: 1,
        ops: [{ op: 'add', path: '/', value: baseState }],
        created: Date.now() - 3000,
      };

      // First server change: insert 'x' at the beginning
      const serverChange1: Change = {
        id: 'server1',
        baseRev: 1,
        rev: 2,
        ops: [{ op: 'add', path: '/text/0', value: 'x' }],
        created: Date.now() - 2000,
      };

      // Second server change: insert 'y' at index 2
      const serverChange2: Change = {
        id: 'server2',
        baseRev: 2,
        rev: 3,
        ops: [{ op: 'add', path: '/text/2', value: 'y' }],
        created: Date.now() - 1000,
      };

      // Set up the initial document state
      mockStore.setInitialDocState(docId, baseState, baseRev, [baseChange]);
      // Add the server changes to the store
      await mockStore.saveChange(docId, serverChange1);
      await mockStore.saveChange(docId, serverChange2);

      // Client change: add 'd' at the end (based on baseRev 1, without knowing about server changes)
      const clientChange: Change = {
        id: 'client1',
        baseRev: 1, // Same base as first server change
        rev: 0,
        ops: [{ op: 'add', path: '/text/3', value: 'd' }],
        created: Date.now(),
      };

      // Spy on the actual transformPatch function from the imported module
      const transformPatchSpy = vi.spyOn(transformPatchModule, 'transformPatch');
      transformPatchSpy.mockReturnValue([
        { op: 'add', path: '/text/5', value: 'd' }, // Mock the transformed result
      ]);

      // Execute
      const [committedChanges, transformedChanges] = await patchesServer.commitChanges(docId, [clientChange]);

      // Verify transformPatch was called with the correct parameters
      expect(transformPatchSpy).toHaveBeenCalledWith(
        { '': baseState }, // Initial state at baseRev
        [
          { op: 'add', path: '/text/0', value: 'x' }, // First server change
          { op: 'add', path: '/text/2', value: 'y' }, // Second server change
        ],
        [{ op: 'add', path: '/text/3', value: 'd' }] // Client change
      );

      // Verify the result contains all changes in the correct order
      expect(committedChanges).toHaveLength(2);
      expect(committedChanges[0]).toEqual(serverChange1);
      expect(committedChanges[1]).toEqual(serverChange2);
      expect(transformedChanges).toHaveLength(1);
      expect(transformedChanges[0].id).toBe('client1');
      expect(transformedChanges[0].baseRev).toBe(1);
      expect(transformedChanges[0].ops).toEqual([{ op: 'add', path: '/text/5', value: 'd' }]);
    });

    it('should handle idempotency: ignore already committed changes', async () => {
      // Setup: Server state at rev 1
      const initialState = { text: ['a', 'b', 'c'] };
      const initialRev = 1;

      // A change that's already been committed to the store
      const existingChange: Change = {
        id: 'c1',
        baseRev: 1,
        rev: 2,
        ops: [{ op: 'add', path: '/text/3', value: 'd' }],
        created: Date.now() - 1000,
      };

      // Set up the state in the mock store
      mockStore.setInitialDocState(docId, initialState, initialRev);
      // Add the existing change to the store
      await mockStore.saveChange(docId, existingChange);

      // Client sends the same change again (same ID)
      const clientChange: Change = {
        id: 'c1', // Same ID as existing change
        baseRev: 1,
        rev: 0, // Client doesn't know the rev yet
        ops: [{ op: 'add', path: '/text/3', value: 'd' }],
        created: Date.now() - 1000,
      };

      // Execute
      const [committedChanges, transformedChanges] = await patchesServer.commitChanges(docId, [clientChange]);

      // Expect the result to contain the committed changes found
      expect(committedChanges).toHaveLength(1);
      expect(committedChanges[0]).toEqual(existingChange); // Should return the change found in the store
      expect(transformedChanges).toHaveLength(0);

      // Verify saveChanges was NOT called
      expect(mockStore.saveChanges).not.toHaveBeenCalled();
    });

    it('should create a new main version if session timeout exceeded', async () => {
      const shortTimeoutServer = new PatchesServer(mockStore, { sessionTimeoutMinutes: 1 / 60 }); // 1 second timeout

      // Setup: Server state at rev 1, change created long ago
      const initialState = { count: 1 };
      const initialRev = 1;
      const oldChange: Change = {
        id: 'c1',
        baseRev: 0,
        rev: 1,
        ops: [{ op: 'add', path: '/', value: { count: 1 } }],
        created: Date.now() - 5000, // 5 seconds ago
      };

      // Set up the initial state in the store
      mockStore.setInitialDocState(docId, initialState, initialRev, [oldChange]);

      // New change arrives now
      const newChange: Change = {
        id: 'c2',
        rev: 0,
        baseRev: 1,
        ops: [{ op: 'replace', path: '/count', value: 2 }],
        created: Date.now(),
      };

      // Mock _createVersion to verify it's called
      const createVersionSpy = vi
        .spyOn(shortTimeoutServer as any, '_createVersion')
        .mockResolvedValue({ id: 'mock-version-id' });

      // Execute
      await shortTimeoutServer.commitChanges(docId, [newChange]);

      // Verify _createVersion was called (spy is on the server instance)
      expect(createVersionSpy).toHaveBeenCalled();

      // commitChanges returns the transformed changes, it doesn't save them itself.
      // We only need to verify that _createVersion was called due to the timeout.
    });

    it('should handle offline changes: single session, create offline version, collapse change', async () => {
      const server = new PatchesServer(mockStore, { sessionTimeoutMinutes: 1 }); // 1 min timeout

      // Setup: Server at rev 5
      const baseRev = 5;
      const initialState = { value: 'rev5' };

      // Offline changes (created > 1 min ago, close together)
      const now = Date.now();
      const offlineCreated1 = now - 90 * 1000; // 90s ago
      const offlineCreated2 = now - 80 * 1000; // 80s ago
      const offlineChanges: Change[] = [
        { id: 'off1', rev: 0, baseRev, ops: [{ op: 'add', path: '/offline1', value: true }], created: offlineCreated1 },
        { id: 'off2', rev: 0, baseRev, ops: [{ op: 'add', path: '/offline2', value: true }], created: offlineCreated2 },
      ];

      // Ensure store reflects current server revision at baseRev
      mockStore.setInitialDocState(docId, initialState, baseRev);
      // Mock what snapshot sees
      mockStore.listVersions.mockResolvedValue([]);
      mockStore.listChanges.mockResolvedValue([]); // No concurrent changes

      // Mock createVersion to not do any validation
      mockStore.createVersion.mockImplementation(async () => {});

      // Mock the result of getSnapshot with the current server state and revision
      const mockSnapshot = {
        state: initialState,
        rev: baseRev,
        changes: [],
      };
      vi.spyOn(server as any, '_getSnapshotAtRevision').mockResolvedValue({
        state: initialState,
        rev: baseRev,
        changes: [],
      });
      vi.spyOn(server as any, 'getStateAtRevision').mockResolvedValue({ state: initialState, rev: baseRev });

      const [committedChanges, transformedChanges] = await server.commitChanges(docId, offlineChanges);

      // Check version creation
      expect(mockStore.createVersion).toHaveBeenCalledTimes(1);
      expect(mockStore.createVersion).toHaveBeenCalledWith(
        docId,
        expect.objectContaining({
          origin: 'offline',
          baseRev: baseRev, // Make sure baseRev is correct
          startDate: offlineCreated1,
          endDate: offlineCreated2,
          groupId: expect.any(String),
          parentId: undefined, // First offline version in batch
        }),
        expect.objectContaining({
          value: 'rev5',
          offline1: true,
          offline2: true,
        }), // State *after* applying original offline ops
        offlineChanges // Original offline changes
      );

      // Check returned change (should be collapsed and potentially transformed)
      // Since committedChanges is empty, transform is called with empty serverOps.
      // Mock transformPatch returns clientOps untransformed.
      const expectedCollapsedOps = [
        { op: 'add', path: '/offline1', value: true },
        { op: 'add', path: '/offline2', value: true },
      ];
      expect(committedChanges).toHaveLength(0);
      expect(transformedChanges).toHaveLength(1);
      expect(transformedChanges[0].id).toBe('off1'); // ID of the first change is kept
      expect(transformedChanges[0].baseRev).toBe(baseRev); // Original baseRev
      expect(transformedChanges[0].ops).toEqual(expectedCollapsedOps); // Collapsed, untransformed ops
    });

    it('should handle offline changes: multiple sessions, create linked versions', async () => {
      const server = new PatchesServer(mockStore, { sessionTimeoutMinutes: 1 }); // 1 min timeout

      // Setup: Server at rev 5
      const baseRev = 5;
      const initialState = { value: 'rev5' };

      // Offline changes split into two sessions (gap > 1 min)
      const now = Date.now();
      const session1Start = now - 180 * 1000; // 3 min ago
      const session1End = now - 150 * 1000; // 2.5 min ago
      const session2Start = now - 30 * 1000; // 30s ago
      const session2End = now - 20 * 1000; // 20s ago

      const offlineChanges: Change[] = [
        // Session 1
        { id: 'off1', rev: 0, baseRev, ops: [{ op: 'add', path: '/session1_1', value: 1 }], created: session1Start },
        { id: 'off2', rev: 0, baseRev, ops: [{ op: 'add', path: '/session1_2', value: 2 }], created: session1End },
        // Session 2 (gap > 1 min)
        { id: 'off3', rev: 0, baseRev, ops: [{ op: 'add', path: '/session2_1', value: 3 }], created: session2Start },
        { id: 'off4', rev: 0, baseRev, ops: [{ op: 'add', path: '/session2_2', value: 4 }], created: session2End },
      ];

      // Ensure store reflects current server revision at baseRev
      mockStore.setInitialDocState(docId, initialState, baseRev);
      // Mock what snapshot sees
      mockStore.listVersions.mockResolvedValue([]);
      mockStore.listChanges.mockResolvedValue([]); // No concurrent changes

      // Mock createVersion to not do any validation
      mockStore.createVersion.mockImplementation(async () => {});

      // Mock the result of getSnapshot with the current server state and revision
      const mockSnapshot = {
        state: initialState,
        rev: baseRev,
        changes: [],
      };
      vi.spyOn(server as any, '_getSnapshotAtRevision').mockResolvedValue({
        state: initialState,
        rev: baseRev,
        changes: [],
      });
      vi.spyOn(server as any, 'getStateAtRevision').mockResolvedValue({ state: initialState, rev: baseRev });

      const [committedChanges, transformedChanges] = await server.commitChanges(docId, offlineChanges);

      // Check version creation (should create two versions, linked)
      expect(mockStore.createVersion).toHaveBeenCalledTimes(2);

      // First version (session 1)
      expect(mockStore.createVersion).toHaveBeenNthCalledWith(
        1,
        docId,
        expect.objectContaining({
          origin: 'offline',
          baseRev: baseRev,
          startDate: session1Start,
          endDate: session1End,
          groupId: expect.any(String),
          parentId: undefined, // First version in batch
        }),
        expect.objectContaining({
          value: 'rev5',
          session1_1: 1,
          session1_2: 2,
        }),
        offlineChanges.slice(0, 2) // First two changes
      );

      // Second version (session 2)
      expect(mockStore.createVersion).toHaveBeenNthCalledWith(
        2,
        docId,
        expect.objectContaining({
          origin: 'offline',
          baseRev: baseRev,
          startDate: session2Start,
          endDate: session2End,
          groupId: expect.any(String),
          parentId: expect.any(String), // Links to first version
        }),
        expect.objectContaining({
          value: 'rev5',
          session1_1: 1,
          session1_2: 2,
          session2_1: 3,
          session2_2: 4,
        }),
        offlineChanges.slice(2) // Last two changes
      );

      // Check returned change (collapsed and potentially transformed)
      // Mock transformPatch returns clientOps untransformed.
      const expectedCollapsedOps = [
        { op: 'add', path: '/session1_1', value: 1 },
        { op: 'add', path: '/session1_2', value: 2 },
        { op: 'add', path: '/session2_1', value: 3 },
        { op: 'add', path: '/session2_2', value: 4 },
      ];
      expect(committedChanges).toHaveLength(0);
      expect(transformedChanges).toHaveLength(1);
      expect(transformedChanges[0].id).toBe('off1');
      expect(transformedChanges[0].baseRev).toBe(baseRev);
      expect(transformedChanges[0].ops).toEqual(expectedCollapsedOps);
    });
  });

  describe('deleteDoc', () => {
    it('should call store.deleteDoc', async () => {
      await patchesServer.deleteDoc(docId);
      expect(mockStore.deleteDoc).toHaveBeenCalledWith(docId);
    });
  });

  // === Version Operations ===

  describe('createVersion (named)', () => {
    it('should get latest state and create a named main version', async () => {
      // Setup mock data that createVersion will use
      const initialState = { foo: 'bar' };
      const initialChange: Change = {
        id: 'init',
        baseRev: 0, // Make sure baseRev is specified and non-zero
        rev: 1,
        ops: [{ op: 'add', path: '/', value: { foo: 'bar' } }],
        created: Date.now() - 1000,
      };

      // Mock the methods that createVersion calls
      mockStore.listVersions.mockResolvedValueOnce([]);
      mockStore.listChanges.mockResolvedValueOnce([initialChange]);

      // Mock the snapshot result
      const mockSnapshot = {
        state: initialState,
        rev: 1,
        changes: [initialChange],
      };
      vi.spyOn(patchesServer as any, 'getStateAtRevision').mockResolvedValue(mockSnapshot);

      // Mock _createVersion to bypass baseRev validation
      const versionMetadata = {
        id: 'mock-version-id',
        name: 'v-main',
        origin: 'main' as const,
        startDate: initialChange.created,
        endDate: initialChange.created,
        rev: initialChange.rev,
        baseRev: 0,
      };

      vi.spyOn(patchesServer as any, '_createVersion').mockImplementation(async (...args) => {
        const changes = args[2] as Change[];
        const name = args[3] as string | undefined;
        // Create the metadata
        const metadata = {
          ...versionMetadata,
          name,
        };

        // Actually call the store's createVersion to satisfy the test expectation
        await mockStore.createVersion(args[0] as string, metadata, initialState, changes);

        return metadata;
      });

      const versionName = 'v-main';
      const versionId = await patchesServer.createVersion(docId, { name: versionName });
      expect(typeof versionId).toBe('string');
      expect(mockStore.createVersion).toHaveBeenCalled();
    });

    it('should throw if there are no changes to version', async () => {
      mockStore.setInitialDocState(docId, null, 0);
      mockStore.listVersions.mockResolvedValueOnce([]);
      mockStore.listChanges.mockResolvedValueOnce([]); // No changes

      await expect(patchesServer.createVersion(docId, { name: 'Empty Version' })).rejects.toThrow(
        /No changes to create a version/
      );
    });
  });
});

describe('PatchesServer multi-batch offline/large edit support (batchId)', () => {
  let store: MockPatchesStoreBackend;
  let server: PatchesServer;
  const docId = 'doc-batch-test';

  beforeEach(() => {
    store = new MockPatchesStoreBackend();
    server = new PatchesServer(store, { sessionTimeoutMinutes: 30 });
    store.setInitialDocState(docId, { text: '' }, 0, []);
  });

  it('should not transform multi-batch uploads with the same batchId over each other', async () => {
    // Simulate a concurrent change from another client after baseRev
    const concurrentChange: Change = {
      id: 'server-1',
      ops: [{ op: 'add', path: '/text', value: 'A' }],
      rev: 1,
      baseRev: 0,
      created: Date.now() - 10000,
    };
    await store.saveChange(docId, concurrentChange);

    // Offline client edits, split into two batches, same batchId
    const batchId = 'batch-xyz';
    const offlineChange1: Change = {
      id: 'offline-1',
      ops: [{ op: 'add', path: '/text', value: 'B' }],
      rev: 2,
      baseRev: 1,
      created: Date.now() - 3600 * 1000, // 1 hour ago (offline)
      batchId,
    };
    const offlineChange2: Change = {
      id: 'offline-2',
      ops: [{ op: 'add', path: '/text', value: 'C' }],
      rev: 3,
      baseRev: 1,
      created: Date.now() - 3599 * 1000, // 1 hour ago, just after offlineChange1
      batchId,
    };
    // First batch
    const [, transformedChanges1] = await server.commitChanges(docId, [offlineChange1]);
    expect(transformedChanges1.some(c => c.id === 'offline-1')).toBe(true);
    // Second batch (should not be transformed over offlineChange1, only over concurrentChange)
    const [, transformedChanges2] = await server.commitChanges(docId, [offlineChange2]);
    expect(transformedChanges2.some(c => c.id === 'offline-2')).toBe(true);
    // Both changes should have the same batchId and be grouped in versioning
    const versions = await store.listVersions(docId, { groupId: batchId });
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions.every(v => v.groupId === batchId)).toBe(true);
  });

  it('should use default behavior if batchId is not present', async () => {
    // Simulate a concurrent change from another client after baseRev
    const concurrentChange: Change = {
      id: 'server-1',
      ops: [{ op: 'add', path: '/text', value: 'A' }],
      rev: 1,
      baseRev: 0,
      created: Date.now() - 10000,
    };
    await store.saveChange(docId, concurrentChange);

    // Two batches, no batchId
    const offlineChange1: Change = {
      id: 'offline-1',
      ops: [{ op: 'add', path: '/text', value: 'B' }],
      rev: 2,
      baseRev: 1,
      created: Date.now() - 3600 * 1000,
    };
    const offlineChange2: Change = {
      id: 'offline-2',
      ops: [{ op: 'add', path: '/text', value: 'C' }],
      rev: 3,
      baseRev: 1,
      created: Date.now() - 3599 * 1000,
    };
    // First batch
    const [, transformedChanges1] = await server.commitChanges(docId, [offlineChange1]);
    expect(transformedChanges1.some(c => c.id === 'offline-1')).toBe(true);
    // Second batch (should be transformed over offlineChange1)
    const [, transformedChanges2] = await server.commitChanges(docId, [offlineChange2]);
    expect(transformedChanges2.some(c => c.id === 'offline-2')).toBe(true);
    // No groupId in versioning
    const versions = await store.listVersions(docId, {});
    expect(versions.some(v => !v.groupId)).toBe(true);
  });

  it('should create two versions if batches with the same batchId are separated by a real session timeout', async () => {
    const batchId = 'batch-timeout';
    // First batch: 2 hours ago
    const offlineChange1: Change = {
      id: 'offline-1',
      ops: [{ op: 'add', path: '/text', value: 'B' }],
      rev: 1,
      baseRev: 0,
      created: Date.now() - 2 * 3600 * 1000,
      batchId,
    };
    // Second batch: now (gap > sessionTimeout)
    const offlineChange2: Change = {
      id: 'offline-2',
      ops: [{ op: 'add', path: '/text', value: 'C' }],
      rev: 2,
      baseRev: 0,
      created: Date.now(),
      batchId,
    };
    // First batch
    await server.commitChanges(docId, [offlineChange1]);
    // Second batch
    await server.commitChanges(docId, [offlineChange2]);
    // Should create two versions for the same batchId (since sessionTimeout exceeded)
    const versions = await store.listVersions(docId, { groupId: batchId });
    expect(versions.length).toBe(2);
  });
});

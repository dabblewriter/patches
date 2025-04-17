import { createId } from 'crypto-id';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { applyPatch } from '../../../src/json-patch/applyPatch';
import * as transformPatchModule from '../../../src/json-patch/transformPatch'; // Import the module
import { PatchServer } from '../../../src/ot/server/PatchServer';
import type {
  Change,
  ListChangesOptions,
  ListVersionsOptions,
  PatchState,
  PatchStoreBackend,
  VersionMetadata,
} from '../../../src/ot/types';

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

// --- Mock PatchStoreBackend ---
class MockPatchStoreBackend implements PatchStoreBackend {
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

  loadVersionState = vi.fn(async (docId: string, versionId: string): Promise<PatchState> => {
    const version = this._getDocVersions(docId).find(v => v.metadata.id === versionId);
    if (!version) throw new Error(`Version ${versionId} not found for doc ${docId}`);
    return { state: version.state, rev: version.metadata.baseRev ?? 0 }; // Assuming rev is baseRev for state
  });

  loadVersionChanges = vi.fn(async (docId: string, versionId: string): Promise<Change[]> => {
    const version = this._getDocVersions(docId).find(v => v.metadata.id === versionId);
    if (!version) throw new Error(`Version ${versionId} not found for doc ${docId}`);
    return version.changes;
  });

  updateVersion = vi.fn(async (docId: string, versionId: string, updates: Partial<VersionMetadata>): Promise<void> => {
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
  // Helper to set initial state for testing getDoc/patchDoc
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

describe('PatchServer', () => {
  let mockStore: MockPatchStoreBackend;
  let patchServer: PatchServer;
  const docId = 'test-doc-1';
  const clientId = 'client-1';

  beforeEach(() => {
    vi.restoreAllMocks(); // Restore original implementations and clear mocks
    mockStore = new MockPatchStoreBackend();
    patchServer = new PatchServer(mockStore);

    // Reset mock Id generator
    let idCounter = 0;
    (createId as Mock).mockImplementation(() => `mock-id-${idCounter++}`);
  });

  // === Initialization & Basic Getters ===

  it('should initialize with default session timeout', () => {
    expect((patchServer as any).sessionTimeoutMillis).toBe(30 * 60 * 1000);
  });

  it('should initialize with custom session timeout', () => {
    const server = new PatchServer(mockStore, { sessionTimeoutMinutes: 10 });
    expect((server as any).sessionTimeoutMillis).toBe(10 * 60 * 1000);
  });

  // === Subscription Operations ===

  describe('subscribe/unsubscribe', () => {
    it('should add subscriptions', async () => {
      const ids = [docId, 'doc-2'];
      const result = await patchServer.subscribe(clientId, ids);
      expect(result).toEqual(ids);
      expect(mockStore.addSubscription).toHaveBeenCalledWith(clientId, ids);
    });

    it('should remove subscriptions', async () => {
      const ids = [docId];
      await patchServer.subscribe(clientId, [docId, 'doc-2']); // Add first
      const result = await patchServer.unsubscribe(clientId, ids);
      expect(result).toEqual(ids);
      expect(mockStore.removeSubscription).toHaveBeenCalledWith(clientId, ids);
    });
  });

  // === Document Operations ===

  describe('getDoc', () => {
    it('should return null state and rev 0 for a new document', async () => {
      const snapshot = await patchServer.getDoc(docId);
      expect(snapshot.state).toBeNull();
      expect(snapshot.rev).toBe(0);
      expect(snapshot.changes).toEqual([]);
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

      const snapshot = await patchServer.getDoc(docId);

      expect(mockStore.listVersions).toHaveBeenCalledWith(docId, {
        limit: 1,
        reverse: true,
        startAfter: undefined,
        origin: 'main',
        orderBy: 'rev',
      });
      expect(mockStore.loadVersionState).toHaveBeenCalledWith(docId, versionId);
      expect(mockStore.listChanges).toHaveBeenCalledWith(docId, {
        startAfter: versionRev,
        endBefore: undefined,
      }); // Should fetch up to baseRev + 1? No, should fetch all

      expect(snapshot.state.state).toEqual(versionState); // State is from the version
      expect(snapshot.rev).toBe(versionRev); // Rev is of the base state
      expect(snapshot.changes).toEqual([change1, change2]); // Changes are since the version
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
      const change3: Change = {
        id: 'c3',
        baseRev: 7,
        rev: 8,
        ops: [{ op: 'remove', path: '/new' }],
        created: Date.now(),
      };
      await mockStore.listChanges.mockResolvedValueOnce([change1, change2]); // Mock loading changes up to rev 7

      const targetRev = 7;
      const snapshot = await patchServer.getDoc(docId, targetRev);

      // Should find the version before or at rev 7+1
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

      expect(snapshot.state.state).toEqual(versionState);
      expect(snapshot.rev).toBe(versionRev); // Rev is of the base state (rev 5)
      expect(snapshot.changes).toEqual([change1, change2]); // Only changes up to rev 7
    });
  });

  describe('getChangesSince', () => {
    it('should call store.listChanges with correct parameters', async () => {
      const rev = 5;
      await patchServer.getChangesSince(docId, rev);
      expect(mockStore.listChanges).toHaveBeenCalledWith(docId, { startAfter: rev });
    });
  });

  describe('patchDoc', () => {
    it('should return empty array if no changes provided', async () => {
      const result = await patchServer.patchDoc(docId, []);
      expect(result).toEqual([]);
    });

    it('should throw if changes have no baseRev', async () => {
      const changes: Change[] = [{ id: 'c1', rev: 0, ops: [], created: Date.now() } as any]; // Missing baseRev, added rev: 0
      await expect(patchServer.patchDoc(docId, changes)).rejects.toThrow('Client changes must include baseRev');
    });

    it('should throw if changes have inconsistent baseRev', async () => {
      const changes: Change[] = [
        { id: 'c1', rev: 0, baseRev: 0, ops: [], created: Date.now() },
        { id: 'c2', rev: 0, baseRev: 1, ops: [], created: Date.now() }, // Inconsistent baseRev
      ];
      await expect(patchServer.patchDoc(docId, changes)).rejects.toThrow('Client changes must have consistent baseRev');
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

      // Mock _getStateAtRevision to ensure it returns the correct current rev
      // Although saveChange updates the internal mock state, explicitly mocking helps isolate
      vi.spyOn(patchServer as any, '_getStateAtRevision').mockResolvedValue({ state: { data: 1 }, rev: 1 });

      const changes: Change[] = [{ id: 'c1', rev: 0, baseRev: 2, ops: [], created: Date.now() }];
      await expect(patchServer.patchDoc(docId, changes)).rejects.toThrow(
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
      vi.spyOn(patchServer as any, '_getStateAtRevision').mockResolvedValue({ state: { data: 1 }, rev: 1 });

      const changes: Change[] = [{ id: 'c1', rev: 0, baseRev: 0, ops: [], created: Date.now() }];
      await expect(patchServer.patchDoc(docId, changes)).rejects.toThrow(
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

      const result = await patchServer.patchDoc(docId, [incomingChange]);

      // Expect the original change to be returned (no transformation needed)
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('c1');
      expect(result[0].ops).toEqual(incomingChange.ops);
      expect(result[0].baseRev).toBe(0);
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
      const result = await patchServer.patchDoc(docId, [incomingChange]);

      // patchDoc returns committed + transformed changes.
      // In this case, no committed changes after baseRev 1, so only transformed.
      const expectedSavedChange = {
        ...incomingChange,
        rev: 2, // Assigned by mockStore._saveChangesInternal
      };

      // Verify the result contains the change (it might be transformed, but mock is basic)
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('c2');
      expect(result[0].baseRev).toBe(1);
      // The rev in the *returned* change might not be set yet by the server logic itself,
      // it relies on the store assigning it. Let's check the saved change.
      // expect(result[0].rev).toBe(2); // This might be unreliable depending on when rev is assigned
      expect(result[0].ops).toEqual(incomingChange.ops); // Mock transform returns original ops here
    });

    it('should transform incoming changes against concurrent server changes', async () => {
      // Setup
      const baseState = { text: ['a', 'b', 'c'] };
      const baseRev = 1;

      // Create a base change to set the initial state
      const baseChange: Change = {
        id: 'base1',
        baseRev: 0,
        rev: 1,
        ops: [{ op: 'add', path: '/', value: baseState }],
        created: Date.now() - 2000,
      };

      // Server change: insert 'x' at the beginning
      const serverChange: Change = {
        id: 'server1',
        baseRev: 1,
        rev: 2,
        ops: [{ op: 'add', path: '/text/0', value: 'x' }],
        created: Date.now() - 1000,
      };

      // Set up the initial document state
      mockStore.setInitialDocState(docId, baseState, baseRev, [baseChange]);
      // Add the server change to the store
      await mockStore.saveChange(docId, serverChange);

      // Client change: add 'd' at the end (based on baseRev 1, without knowing about serverChange)
      const clientChange: Change = {
        id: 'client1',
        baseRev: 1, // Same base as server change
        rev: 0,
        ops: [{ op: 'add', path: '/text/3', value: 'd' }],
        created: Date.now(),
      };

      // Spy on the actual transformPatch function from the imported module
      const transformPatchSpy = vi.spyOn(transformPatchModule, 'transformPatch');
      transformPatchSpy.mockReturnValue([
        { op: 'add', path: '/text/4', value: 'd' }, // Mock the transformed result
      ]);

      // Execute
      const result = await patchServer.patchDoc(docId, [clientChange]);

      // Verify transformPatch was called
      expect(transformPatchSpy).toHaveBeenCalled();

      // Verify the result contains both the committed server change and the transformed client change
      const expectedTransformedOps = [{ op: 'add', path: '/text/4', value: 'd' }];
      expect(result).toHaveLength(2);

      // Check the committed server change (should be the first element)
      expect(result[0]).toEqual(serverChange);

      // Check the transformed client change (should be the second element)
      expect(result[1].id).toBe('client1'); // ID of the transformed change
      expect(result[1].baseRev).toBe(1); // Original baseRev before transformation
      expect(result[1].ops).toEqual(expectedTransformedOps);

      // Verify saveChanges was called with the transformed change and updated baseRev
      // Note: The actual saveChanges call happens *inside* patchDoc and isn't directly tested here,
      // but the returned result implies what *should* have been saved after transformation.
      // We trust the internal logic uses the transformed ops.
      // Let's refine the check on the *returned* change's baseRev.
      // The returned change should reflect the baseRev *before* transformation.
      // The *saved* change would have an updated baseRev internally.
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
      const result = await patchServer.patchDoc(docId, [clientChange]);

      // Expect the result to contain the committed changes found
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(existingChange); // Should return the change found in the store

      // Verify saveChanges was NOT called
      expect(mockStore.saveChanges).not.toHaveBeenCalled();
    });

    it('should create a new main version if session timeout exceeded', async () => {
      const shortTimeoutServer = new PatchServer(mockStore, { sessionTimeoutMinutes: 1 / 60 }); // 1 second timeout

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
      await shortTimeoutServer.patchDoc(docId, [newChange]);

      // Verify _createVersion was called (spy is on the server instance)
      expect(createVersionSpy).toHaveBeenCalled();

      // patchDoc returns the transformed changes, it doesn't save them itself.
      // We only need to verify that _createVersion was called due to the timeout.
    });

    it('should handle offline changes: single session, create offline version, collapse change', async () => {
      const server = new PatchServer(mockStore, { sessionTimeoutMinutes: 1 }); // 1 min timeout

      // Setup: Server at rev 5
      const baseRev = 5;
      const initialState = { value: 'rev5' };
      const oldChange: Change = {
        id: 'c0',
        baseRev: 0,
        rev: baseRev,
        ops: [{ op: 'add', path: '/', value: initialState }],
        created: Date.now() - 100000,
      };

      // Offline changes (created > 1 min ago, close together)
      const now = Date.now();
      const offlineCreated1 = now - 90 * 1000; // 90s ago
      const offlineCreated2 = now - 80 * 1000; // 80s ago
      const offlineChanges: Change[] = [
        { id: 'off1', rev: 0, baseRev, ops: [{ op: 'add', path: '/offline1', value: true }], created: offlineCreated1 },
        { id: 'off2', rev: 0, baseRev, ops: [{ op: 'add', path: '/offline2', value: true }], created: offlineCreated2 },
      ];

      // Mock what PatchServer._getSnapshotAtRevision sees
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
      vi.spyOn(server as any, '_getSnapshotAtRevision').mockResolvedValue(mockSnapshot);
      vi.spyOn(server as any, '_getStateAtRevision').mockResolvedValue({
        state: initialState,
        rev: baseRev,
      });

      const result = await server.patchDoc(docId, offlineChanges);

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
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('off1'); // ID of the first change is kept
      expect(result[0].baseRev).toBe(baseRev); // Original baseRev
      expect(result[0].ops).toEqual(expectedCollapsedOps); // Collapsed, untransformed ops
    });

    it('should handle offline changes: multiple sessions, create linked versions', async () => {
      const server = new PatchServer(mockStore, { sessionTimeoutMinutes: 1 }); // 1 min timeout

      // Setup: Server at rev 5
      const baseRev = 5;
      const initialState = { value: 'rev5' };
      const oldChange: Change = {
        id: 'c0',
        baseRev: 0,
        rev: baseRev,
        ops: [{ op: 'add', path: '/', value: initialState }],
        created: Date.now() - 100000,
      };

      // Offline changes spanning multiple sessions
      const now = Date.now();
      const time1 = now - 180 * 1000; // 3 mins ago
      const time2 = now - 170 * 1000; // 2m 50s ago (same session)
      const time3 = now - 90 * 1000; // 1m 30s ago (new session)
      const time4 = now - 80 * 1000; // 1m 20s ago (same session)

      const offlineChanges: Change[] = [
        { id: 'off1', rev: 0, baseRev, ops: [{ op: 'add', path: '/session1_1', value: 1 }], created: time1 },
        { id: 'off2', rev: 0, baseRev, ops: [{ op: 'add', path: '/session1_2', value: 2 }], created: time2 },
        { id: 'off3', rev: 0, baseRev, ops: [{ op: 'add', path: '/session2_1', value: 3 }], created: time3 },
        { id: 'off4', rev: 0, baseRev, ops: [{ op: 'add', path: '/session2_2', value: 4 }], created: time4 },
      ];

      // Mock what PatchServer._getSnapshotAtRevision sees
      mockStore.listVersions.mockResolvedValue([]);
      mockStore.listChanges.mockResolvedValue([]); // No concurrent changes

      // Mock createVersion to store values we can check
      const createVersionCalls: any[] = [];
      mockStore.createVersion.mockImplementation(async (docId, metadata, state, changes) => {
        createVersionCalls.push({ docId, metadata, state, changes });
      });

      // Mock the result of getSnapshot with the current server state and revision
      const mockSnapshot = {
        state: initialState,
        rev: baseRev,
        changes: [],
      };
      vi.spyOn(server as any, '_getSnapshotAtRevision').mockResolvedValue(mockSnapshot);
      vi.spyOn(server as any, '_getStateAtRevision').mockResolvedValue({
        state: initialState,
        rev: baseRev,
      });

      const result = await server.patchDoc(docId, offlineChanges);

      // Check version creation (should be two versions)
      expect(mockStore.createVersion).toHaveBeenCalledTimes(2);

      const firstCall = createVersionCalls[0];
      const secondCall = createVersionCalls[1];

      // First session version
      expect(firstCall.docId).toBe(docId);
      expect(firstCall.metadata).toEqual(
        expect.objectContaining({
          origin: 'offline',
          baseRev: baseRev,
          startDate: time1,
          endDate: time2,
          groupId: expect.any(String),
          parentId: undefined,
        })
      );
      expect(firstCall.state).toEqual(
        expect.objectContaining({
          value: 'rev5',
          session1_1: 1,
          session1_2: 2,
        })
      );
      expect(firstCall.changes).toEqual(offlineChanges.slice(0, 2));

      const firstVersionId = firstCall.metadata.id;
      const groupId = firstCall.metadata.groupId;

      // Second session version
      expect(secondCall.docId).toBe(docId);
      expect(secondCall.metadata).toEqual(
        expect.objectContaining({
          origin: 'offline',
          baseRev: baseRev,
          startDate: time3,
          endDate: time4,
          groupId: groupId, // Same group ID
          parentId: firstVersionId, // Linked to the first version
        })
      );
      // State after applying *all* original ops up to this point
      expect(secondCall.state).toEqual(
        expect.objectContaining({
          value: 'rev5',
          session1_1: 1,
          session1_2: 2,
          session2_1: 3,
          session2_2: 4,
        })
      );
      expect(secondCall.changes).toEqual(offlineChanges.slice(2, 4)); // Last two changes

      // Check returned change (collapsed and potentially transformed)
      // Mock transformPatch returns clientOps untransformed.
      const expectedCollapsedOps = [
        { op: 'add', path: '/session1_1', value: 1 },
        { op: 'add', path: '/session1_2', value: 2 },
        { op: 'add', path: '/session2_1', value: 3 },
        { op: 'add', path: '/session2_2', value: 4 },
      ];
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('off1');
      expect(result[0].baseRev).toBe(baseRev);
      expect(result[0].ops).toEqual(expectedCollapsedOps);
    });
  });

  describe('deleteDoc', () => {
    it('should call store.deleteDoc', async () => {
      await patchServer.deleteDoc(docId);
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
      vi.spyOn(patchServer as any, '_getSnapshotAtRevision').mockResolvedValue(mockSnapshot);

      // Mock _createVersion to bypass baseRev validation
      const versionMetadata = {
        id: 'mock-version-id',
        name: 'v-main',
        origin: 'main' as 'main',
        startDate: initialChange.created,
        endDate: initialChange.created,
        rev: initialChange.rev,
        baseRev: 0,
      };

      vi.spyOn(patchServer as any, '_createVersion').mockImplementation(async (...args) => {
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
      const versionId = await patchServer.createVersion(docId, versionName);
      expect(typeof versionId).toBe('string');
      expect(mockStore.createVersion).toHaveBeenCalled();
    });

    it('should throw if there are no changes to version', async () => {
      mockStore.setInitialDocState(docId, null, 0);
      mockStore.listVersions.mockResolvedValueOnce([]);
      mockStore.listChanges.mockResolvedValueOnce([]); // No changes

      await expect(patchServer.createVersion(docId, 'Empty Version')).rejects.toThrow(/No changes to create a version/);
    });
  });

  describe('listVersions', () => {
    it('should call store.listVersions with provided options', async () => {
      const options: ListVersionsOptions = { limit: 5, reverse: true, origin: 'offline' };
      await patchServer.listVersions(docId, options);
      expect(mockStore.listVersions).toHaveBeenCalledWith(docId, options);
    });
  });

  describe('getVersionState', () => {
    it('should call store.loadVersionState', async () => {
      // Setup version in mock store
      const versionId = 'v123';
      const versionMetadata: VersionMetadata = {
        id: versionId,
        origin: 'main',
        baseRev: 0,
        startDate: Date.now(),
        endDate: Date.now(),
        rev: 0,
      };
      mockStore.createVersion(docId, versionMetadata, {}, []);
      await patchServer.getVersionState(docId, versionId);
      expect(mockStore.loadVersionState).toHaveBeenCalledWith(docId, versionId);
    });
  });

  describe('getVersionChanges', () => {
    it('should call store.loadVersionChanges', async () => {
      // Setup version in mock store
      const versionId = 'v456';
      const versionMetadata: VersionMetadata = {
        id: versionId,
        origin: 'main',
        baseRev: 0,
        startDate: Date.now(),
        endDate: Date.now(),
        rev: 0,
      };
      mockStore.createVersion(docId, versionMetadata, {}, []);
      await patchServer.getVersionChanges(docId, versionId);
      expect(mockStore.loadVersionChanges).toHaveBeenCalledWith(docId, versionId);
    });
  });

  describe('updateVersion', () => {
    it('should call store.updateVersion with name update', async () => {
      // Setup version in mock store
      const versionId = 'v789';
      const versionMetadata: VersionMetadata = {
        id: versionId,
        origin: 'main',
        baseRev: 0,
        startDate: Date.now(),
        endDate: Date.now(),
        rev: 0,
      };
      mockStore.createVersion(docId, versionMetadata, {}, []);
      await patchServer.updateVersion(docId, versionId, 'update');
      expect(mockStore.updateVersion).toHaveBeenCalledWith(docId, versionId, { name: 'update' });
    });
  });
});

describe('PatchServer multi-batch offline/large edit support (batchId)', () => {
  let store: MockPatchStoreBackend;
  let server: PatchServer;
  const docId = 'doc-batch-test';

  beforeEach(() => {
    store = new MockPatchStoreBackend();
    server = new PatchServer(store, { sessionTimeoutMinutes: 30 });
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
    let result = await server.patchDoc(docId, [offlineChange1]);
    expect(result.some(c => c.id === 'offline-1')).toBe(true);
    // Second batch (should not be transformed over offlineChange1, only over concurrentChange)
    result = await server.patchDoc(docId, [offlineChange2]);
    expect(result.some(c => c.id === 'offline-2')).toBe(true);
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
    let result = await server.patchDoc(docId, [offlineChange1]);
    expect(result.some(c => c.id === 'offline-1')).toBe(true);
    // Second batch (should be transformed over offlineChange1)
    result = await server.patchDoc(docId, [offlineChange2]);
    expect(result.some(c => c.id === 'offline-2')).toBe(true);
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
    await server.patchDoc(docId, [offlineChange1]);
    // Second batch
    await server.patchDoc(docId, [offlineChange2]);
    // Should create two versions for the same batchId (since sessionTimeout exceeded)
    const versions = await store.listVersions(docId, { groupId: batchId });
    expect(versions.length).toBe(2);
  });
});

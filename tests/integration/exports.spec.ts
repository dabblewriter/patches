/**
 * Export verification tests for LWW components.
 *
 * These tests verify that all LWW types and classes are properly exported
 * from the package entry points. If an export is missing, this file will
 * fail to compile.
 */
import { describe, it, expect } from 'vitest';

// Client exports
import {
  LWWDoc,
  LWWAlgorithm,
  LWWInMemoryStore,
  LWWIndexedDBStore,
  createLWWPatches,
  createLWWIndexedDBPatches,
  type LWWClientStore,
} from '../../src/client/index.js';

// Server exports
import {
  LWWServer,
  LWWBranchManager,
  LWWMemoryStoreBackend,
  type LWWServerOptions,
  type LWWStoreBackend,
  type VersioningStoreBackend,
} from '../../src/server/index.js';

// Main entry point re-exports client
import { LWWDoc as MainLWWDoc, LWWAlgorithm as MainLWWAlgorithm } from '../../src/index.js';

describe('LWW exports', () => {
  describe('client exports (@dabble/patches/client)', () => {
    it('exports LWWDoc class', () => {
      expect(LWWDoc).toBeDefined();
      expect(typeof LWWDoc).toBe('function');

      const doc = new LWWDoc('test-doc');
      expect(doc.id).toBe('test-doc');
      expect(doc.state).toEqual({});
    });

    it('exports LWWAlgorithm class', () => {
      expect(LWWAlgorithm).toBeDefined();
      expect(typeof LWWAlgorithm).toBe('function');

      const store = new LWWInMemoryStore();
      const algorithm = new LWWAlgorithm(store);
      expect(algorithm.name).toBe('lww');
      expect(algorithm.store).toBe(store);
    });

    it('exports LWWInMemoryStore class', () => {
      expect(LWWInMemoryStore).toBeDefined();
      expect(typeof LWWInMemoryStore).toBe('function');

      const store = new LWWInMemoryStore();
      expect(store).toBeInstanceOf(LWWInMemoryStore);
    });

    it('exports LWWIndexedDBStore class', () => {
      expect(LWWIndexedDBStore).toBeDefined();
      expect(typeof LWWIndexedDBStore).toBe('function');
      // Don't instantiate - requires IndexedDB environment
    });

    it('exports createLWWPatches factory', () => {
      expect(createLWWPatches).toBeDefined();
      expect(typeof createLWWPatches).toBe('function');

      const patches = createLWWPatches();
      expect(patches).toBeDefined();
    });

    it('exports createLWWIndexedDBPatches factory', () => {
      expect(createLWWIndexedDBPatches).toBeDefined();
      expect(typeof createLWWIndexedDBPatches).toBe('function');
      // Don't call - requires IndexedDB environment
    });

    it('exports LWWClientStore type', () => {
      // Type-only export - verify it compiles
      const _typeCheck: LWWClientStore = new LWWInMemoryStore();
      expect(_typeCheck).toBeDefined();
    });
  });

  describe('server exports (@dabble/patches/server)', () => {
    it('exports LWWServer class', () => {
      expect(LWWServer).toBeDefined();
      expect(typeof LWWServer).toBe('function');

      const store = new LWWMemoryStoreBackend();
      const server = new LWWServer(store);
      expect(server).toBeInstanceOf(LWWServer);
    });

    it('exports LWWBranchManager class', () => {
      expect(LWWBranchManager).toBeDefined();
      expect(typeof LWWBranchManager).toBe('function');

      const store = new LWWMemoryStoreBackend();
      const server = new LWWServer(store);
      const branchManager = new LWWBranchManager(store, server);
      expect(branchManager).toBeInstanceOf(LWWBranchManager);
    });

    it('exports LWWMemoryStoreBackend class', () => {
      expect(LWWMemoryStoreBackend).toBeDefined();
      expect(typeof LWWMemoryStoreBackend).toBe('function');

      const store = new LWWMemoryStoreBackend();
      expect(store).toBeInstanceOf(LWWMemoryStoreBackend);
    });

    it('exports LWWServerOptions type', () => {
      // Type-only export - verify it compiles
      const _options: LWWServerOptions = { snapshotInterval: 200 };
      expect(_options.snapshotInterval).toBe(200);
    });

    it('exports LWWStoreBackend type', () => {
      // Type-only export - verify it compiles
      const _typeCheck: LWWStoreBackend = new LWWMemoryStoreBackend();
      expect(_typeCheck).toBeDefined();
    });

    it('exports VersioningStoreBackend type', () => {
      // Type-only export - verify it compiles (LWWMemoryStoreBackend implements this)
      const _typeCheck: VersioningStoreBackend = new LWWMemoryStoreBackend();
      expect(_typeCheck).toBeDefined();
    });
  });

  describe('main entry point (@dabble/patches)', () => {
    it('re-exports client LWW classes', () => {
      // Main entry re-exports everything from client
      expect(MainLWWDoc).toBe(LWWDoc);
      expect(MainLWWAlgorithm).toBe(LWWAlgorithm);
    });
  });
});

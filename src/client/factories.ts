import type { AlgorithmName } from './PatchesStore.js';
import { OTInMemoryStore } from './OTInMemoryStore.js';
import { LWWInMemoryStore } from './LWWInMemoryStore.js';
import { IndexedDBStore } from './IndexedDBStore.js';
import { LWWIndexedDBStore } from './LWWIndexedDBStore.js';
import { LWWAlgorithm } from './LWWAlgorithm.js';
import { OTIndexedDBStore } from './OTIndexedDBStore.js';
import { OTAlgorithm } from './OTAlgorithm.js';
import { Patches } from './Patches.js';
import type { PatchesDocOptions } from './PatchesDoc.js';

/**
 * Options for factory functions that create Patches instances.
 */
export interface PatchesFactoryOptions {
  /** Initial metadata to attach to changes from this client. */
  metadata?: Record<string, any>;
  /** Document-level options to pass to each PatchesDoc instance. */
  docOptions?: PatchesDocOptions;
}

/**
 * Options for factory functions with multiple algorithms.
 */
export interface MultiAlgorithmFactoryOptions extends PatchesFactoryOptions {
  /** Default algorithm to use when opening docs. */
  defaultAlgorithm?: AlgorithmName;
}

/**
 * Options for IndexedDB-based factory functions.
 */
export interface IndexedDBFactoryOptions extends PatchesFactoryOptions {
  /** Database name for IndexedDB storage. */
  dbName: string;
}

/**
 * Options for IndexedDB-based factory functions with multiple algorithms.
 */
export interface MultiAlgorithmIndexedDBFactoryOptions extends MultiAlgorithmFactoryOptions {
  /** Database name for IndexedDB storage. */
  dbName: string;
}

// --- OT-only factories ---

/**
 * Creates a Patches instance with OT algorithm and in-memory store.
 * Useful for testing or when persistence isn't needed.
 */
export function createOTPatches(options: PatchesFactoryOptions = {}): Patches {
  const store = new OTInMemoryStore();
  const otAlgorithm = new OTAlgorithm(store, options.docOptions);

  return new Patches({
    algorithms: { ot: otAlgorithm },
    defaultAlgorithm: 'ot',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

/**
 * Creates a Patches instance with OT algorithm and IndexedDB store.
 * For persistent storage in browser environments.
 */
export function createOTIndexedDBPatches(options: IndexedDBFactoryOptions): Patches {
  const store = new OTIndexedDBStore(options.dbName);
  const otAlgorithm = new OTAlgorithm(store, options.docOptions);

  return new Patches({
    algorithms: { ot: otAlgorithm },
    defaultAlgorithm: 'ot',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

// --- LWW-only factories ---

/**
 * Creates a Patches instance with LWW algorithm and in-memory store.
 * Useful for testing or when persistence isn't needed.
 */
export function createLWWPatches(options: PatchesFactoryOptions = {}): Patches {
  const store = new LWWInMemoryStore();
  const lwwAlgorithm = new LWWAlgorithm(store);

  return new Patches({
    algorithms: { lww: lwwAlgorithm },
    defaultAlgorithm: 'lww',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

/**
 * Creates a Patches instance with LWW algorithm and IndexedDB store.
 * For persistent storage in browser environments.
 */
export function createLWWIndexedDBPatches(options: IndexedDBFactoryOptions): Patches {
  const store = new LWWIndexedDBStore(options.dbName);
  const lwwAlgorithm = new LWWAlgorithm(store);

  return new Patches({
    algorithms: { lww: lwwAlgorithm },
    defaultAlgorithm: 'lww',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

// --- Multi-algorithm factories ---

/**
 * Creates a Patches instance with both OT and LWW algorithms using in-memory stores.
 * Useful for testing or applications that need both algorithms without persistence.
 */
export function createMultiAlgorithmPatches(options: MultiAlgorithmFactoryOptions = {}): Patches {
  const otStore = new OTInMemoryStore();
  const lwwStore = new LWWInMemoryStore();
  const otAlgorithm = new OTAlgorithm(otStore, options.docOptions);
  const lwwAlgorithm = new LWWAlgorithm(lwwStore);

  return new Patches({
    algorithms: { ot: otAlgorithm, lww: lwwAlgorithm },
    defaultAlgorithm: options.defaultAlgorithm ?? 'ot',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

/**
 * Creates a Patches instance with both OT and LWW algorithms using IndexedDB stores.
 * For persistent storage in browser environments with support for both algorithms.
 * Both algorithms share the same IndexedDB database with unified stores.
 */
export function createMultiAlgorithmIndexedDBPatches(options: MultiAlgorithmIndexedDBFactoryOptions): Patches {
  // Create a shared IndexedDB store that both OT and LWW will use
  const baseStore = new IndexedDBStore(options.dbName);
  const otStore = new OTIndexedDBStore(baseStore);
  const lwwStore = new LWWIndexedDBStore(baseStore);

  const otAlgorithm = new OTAlgorithm(otStore, options.docOptions);
  const lwwAlgorithm = new LWWAlgorithm(lwwStore);

  return new Patches({
    algorithms: { ot: otAlgorithm, lww: lwwAlgorithm },
    defaultAlgorithm: options.defaultAlgorithm ?? 'ot',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

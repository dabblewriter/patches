import type { StrategyName } from './ClientStrategy.js';
import { InMemoryStore } from './InMemoryStore.js';
import { LWWInMemoryStore } from './LWWInMemoryStore.js';
import { LWWIndexedDBStore } from './LWWIndexedDBStore.js';
import { LWWStrategy } from './LWWStrategy.js';
import { OTIndexedDBStore } from './OTIndexedDBStore.js';
import { OTStrategy } from './OTStrategy.js';
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
 * Options for factory functions with multiple strategies.
 */
export interface MultiStrategyFactoryOptions extends PatchesFactoryOptions {
  /** Default strategy to use when opening docs. */
  defaultStrategy?: StrategyName;
}

/**
 * Options for IndexedDB-based factory functions.
 */
export interface IndexedDBFactoryOptions extends PatchesFactoryOptions {
  /** Database name for IndexedDB storage. */
  dbName: string;
}

/**
 * Options for IndexedDB-based factory functions with multiple strategies.
 */
export interface MultiStrategyIndexedDBFactoryOptions extends MultiStrategyFactoryOptions {
  /** Database name for IndexedDB storage. */
  dbName: string;
}

// --- OT-only factories ---

/**
 * Creates a Patches instance with OT strategy and in-memory store.
 * Useful for testing or when persistence isn't needed.
 */
export function createOTPatches(options: PatchesFactoryOptions = {}): Patches {
  const store = new InMemoryStore();
  const otStrategy = new OTStrategy(store, options.docOptions);

  return new Patches({
    strategies: { ot: otStrategy },
    defaultStrategy: 'ot',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

/**
 * Creates a Patches instance with OT strategy and IndexedDB store.
 * For persistent storage in browser environments.
 */
export function createOTIndexedDBPatches(options: IndexedDBFactoryOptions): Patches {
  const store = new OTIndexedDBStore(options.dbName);
  const otStrategy = new OTStrategy(store, options.docOptions);

  return new Patches({
    strategies: { ot: otStrategy },
    defaultStrategy: 'ot',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

// --- LWW-only factories ---

/**
 * Creates a Patches instance with LWW strategy and in-memory store.
 * Useful for testing or when persistence isn't needed.
 */
export function createLWWPatches(options: PatchesFactoryOptions = {}): Patches {
  const store = new LWWInMemoryStore();
  const lwwStrategy = new LWWStrategy(store);

  return new Patches({
    strategies: { lww: lwwStrategy },
    defaultStrategy: 'lww',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

/**
 * Creates a Patches instance with LWW strategy and IndexedDB store.
 * For persistent storage in browser environments.
 */
export function createLWWIndexedDBPatches(options: IndexedDBFactoryOptions): Patches {
  const store = new LWWIndexedDBStore(options.dbName);
  const lwwStrategy = new LWWStrategy(store);

  return new Patches({
    strategies: { lww: lwwStrategy },
    defaultStrategy: 'lww',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

// --- Multi-strategy factories ---

/**
 * Creates a Patches instance with both OT and LWW strategies using in-memory stores.
 * Useful for testing or applications that need both strategies without persistence.
 */
export function createAllPatches(options: MultiStrategyFactoryOptions = {}): Patches {
  const otStore = new InMemoryStore();
  const lwwStore = new LWWInMemoryStore();
  const otStrategy = new OTStrategy(otStore, options.docOptions);
  const lwwStrategy = new LWWStrategy(lwwStore);

  return new Patches({
    strategies: { ot: otStrategy, lww: lwwStrategy },
    defaultStrategy: options.defaultStrategy ?? 'ot',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

/**
 * Creates a Patches instance with both OT and LWW strategies using IndexedDB stores.
 * For persistent storage in browser environments with support for both strategies.
 */
export function createAllIndexedDBPatches(options: MultiStrategyIndexedDBFactoryOptions): Patches {
  const otStore = new OTIndexedDBStore(options.dbName);
  const lwwStore = new LWWIndexedDBStore(`${options.dbName}-lww`);
  const otStrategy = new OTStrategy(otStore, options.docOptions);
  const lwwStrategy = new LWWStrategy(lwwStore);

  return new Patches({
    strategies: { ot: otStrategy, lww: lwwStrategy },
    defaultStrategy: options.defaultStrategy ?? 'ot',
    metadata: options.metadata,
    docOptions: options.docOptions,
  });
}

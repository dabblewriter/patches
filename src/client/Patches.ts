import { type Unsubscriber, signal } from '../event-signal.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change } from '../types.js';
import { singleInvocation } from '../utils/concurrency.js';
import type { ClientStrategy, StrategyName } from './ClientStrategy.js';
import type { PatchesDoc, PatchesDocOptions } from './PatchesDoc.js';

/**
 * Options for creating a Patches instance.
 * Provides strategies map and optional default strategy.
 */
export interface PatchesOptions {
  /** Map of strategy name to strategy instance. Each strategy owns its store. */
  strategies: Partial<Record<StrategyName, ClientStrategy>>;
  /** Default strategy to use when opening docs. Must be a key in strategies map. */
  defaultStrategy?: StrategyName;
  /** Initial metadata to attach to changes from this client (merged with per-doc metadata). */
  metadata?: Record<string, any>;
  /** Document-level options to pass to each PatchesDoc instance */
  docOptions?: PatchesDocOptions;
}

// Internal doc management structure
interface ManagedDoc<T extends object> {
  doc: PatchesDoc<T>;
  strategy: ClientStrategy;
  unsubscribe: Unsubscriber;
}

/**
 * Main client-side entry point for the Patches library.
 * Manages document instances (`PatchesDoc`) and coordinates with strategies.
 * Can be used standalone or with PatchesSync for network synchronization.
 *
 * Patches owns docs. Strategies own their stores and algorithms.
 */
export class Patches {
  protected options: PatchesOptions;
  protected docs: Map<string, ManagedDoc<any>> = new Map();

  readonly docOptions: PatchesDocOptions;
  readonly strategies: Partial<Record<StrategyName, ClientStrategy>>;
  readonly defaultStrategy: StrategyName;
  readonly trackedDocs = new Set<string>();

  // Public signals
  readonly onError = signal<(error: Error, context?: { docId?: string }) => void>();
  readonly onServerCommit = signal<(docId: string, changes: Change[]) => void>();
  readonly onTrackDocs = signal<(docIds: string[]) => void>();
  readonly onUntrackDocs = signal<(docIds: string[]) => void>();
  readonly onDeleteDoc = signal<(docId: string) => void>();
  /** Emitted when a doc has pending changes ready to send */
  readonly onChange = signal<(docId: string) => void>();

  constructor(opts: PatchesOptions) {
    this.options = opts;
    this.strategies = opts.strategies;

    // Determine default strategy
    const strategyNames = Object.keys(opts.strategies) as StrategyName[];
    if (strategyNames.length === 0) {
      throw new Error('At least one strategy must be provided');
    }
    this.defaultStrategy = opts.defaultStrategy ?? strategyNames[0];
    if (!opts.strategies[this.defaultStrategy]) {
      throw new Error(`Default strategy '${this.defaultStrategy}' not found in strategies map`);
    }

    this.docOptions = opts.docOptions ?? {};

    // Load tracked docs from the default strategy's store
    this._getStrategy(this.defaultStrategy)
      .listDocs()
      .then(docs => {
        this.trackDocs(docs.map(({ docId }) => docId));
      });
  }

  /**
   * Gets a strategy by name, throwing if not found.
   */
  protected _getStrategy(name: StrategyName): ClientStrategy {
    const strategy = this.strategies[name];
    if (!strategy) {
      throw new Error(`Strategy '${name}' not found`);
    }
    return strategy;
  }

  /**
   * Gets the strategy for an open document.
   */
  getDocStrategy(docId: string): ClientStrategy | undefined {
    return this.docs.get(docId)?.strategy;
  }

  // --- Public API Methods ---

  /**
   * Tracks the given document IDs, adding them to the set of tracked documents and notifying listeners.
   * Tracked docs are kept in sync with the server, even when not open locally.
   * This allows for background syncing and updates of unopened documents.
   * @param docIds - Array of document IDs to track.
   * @param strategyName - Strategy to use for tracking (defaults to defaultStrategy).
   */
  async trackDocs(docIds: string[], strategyName?: StrategyName): Promise<void> {
    docIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!docIds.length) return;
    docIds.forEach(this.trackedDocs.add, this.trackedDocs);
    this.onTrackDocs.emit(docIds);
    const strategy = this._getStrategy(strategyName ?? this.defaultStrategy);
    await strategy.trackDocs(docIds);
  }

  /**
   * Untracks the given document IDs, removing them from the set of tracked documents and notifying listeners.
   * Untracked docs will no longer be kept in sync with the server.
   * Closes any open docs and removes them from the store.
   * @param docIds - Array of document IDs to untrack.
   */
  async untrackDocs(docIds: string[]): Promise<void> {
    docIds = docIds.filter(id => this.trackedDocs.has(id));
    if (!docIds.length) return;
    docIds.forEach(this.trackedDocs.delete, this.trackedDocs);
    this.onUntrackDocs.emit(docIds);

    // Close any open PatchesDoc instances first
    const closedPromises = docIds.filter(id => this.docs.has(id)).map(id => this.closeDoc(id)); // closeDoc removes from this.docs map
    await Promise.all(closedPromises);

    // Untrack from each doc's strategy
    // Group by strategy and untrack
    const byStrategy = new Map<ClientStrategy, string[]>();
    for (const docId of docIds) {
      const managed = this.docs.get(docId);
      const strategy = managed?.strategy ?? this._getStrategy(this.defaultStrategy);
      const list = byStrategy.get(strategy) ?? [];
      list.push(docId);
      byStrategy.set(strategy, list);
    }
    await Promise.all([...byStrategy.entries()].map(([strategy, ids]) => strategy.untrackDocs(ids)));
  }

  /**
   * Opens a document by ID, loading its state from the store and setting up change listeners.
   * If the doc is already open, returns the existing instance.
   * @param docId - The document ID to open.
   * @param opts - Optional metadata and strategy override.
   * @returns The opened PatchesDoc instance.
   */
  @singleInvocation(true) // ensure a second call to openDoc with the same docId returns the same promise while opening
  async openDoc<T extends object>(
    docId: string,
    opts: { metadata?: Record<string, any>; strategy?: StrategyName } = {}
  ): Promise<PatchesDoc<T>> {
    const existing = this.docs.get(docId);
    if (existing) return existing.doc as PatchesDoc<T>;

    // Get the strategy for this doc
    const strategyName = opts.strategy ?? this.defaultStrategy;
    const strategy = this._getStrategy(strategyName);

    // Ensure the doc is tracked before proceeding
    await this.trackDocs([docId], strategyName);

    // Load initial state from store via strategy
    const snapshot = await strategy.loadDoc(docId);
    const mergedMetadata = { ...this.options.metadata, ...opts.metadata };

    // Create the appropriate doc type via strategy (now takes docId and snapshot)
    const doc = strategy.createDoc<T>(docId, snapshot);

    // Set up local listener -> strategy handles packaging ops
    const unsubscribe = doc.onChange(ops => this._handleDocChange(docId, ops, doc, strategy, mergedMetadata));
    this.docs.set(docId, { doc: doc as PatchesDoc<any>, strategy, unsubscribe });

    return doc;
  }

  /**
   * Closes an open document by ID, removing listeners and optionally untracking it.
   * @param docId - The document ID to close.
   * @param options - Optional: set untrack to true to also untrack the doc.
   */
  async closeDoc(docId: string, { untrack = false }: { untrack?: boolean } = {}): Promise<void> {
    const managed = this.docs.get(docId);
    if (managed) {
      managed.unsubscribe();
      this.docs.delete(docId);
      if (untrack) {
        await this.untrackDocs([docId]);
      }
    }
  }

  /**
   * Deletes a document by ID, closing it if open, untracking it, and removing it from the store.
   * Emits the onDeleteDoc signal.
   * @param docId - The document ID to delete.
   */
  async deleteDoc(docId: string): Promise<void> {
    // Get the strategy for this doc (or default)
    const managed = this.docs.get(docId);
    const strategy = managed?.strategy ?? this._getStrategy(this.defaultStrategy);

    // Close if open locally
    if (this.docs.has(docId)) {
      await this.closeDoc(docId);
    }
    // Unsubscribe from server if tracked (deletes the doc from the store before the next step adds a tombstone)
    if (this.trackedDocs.has(docId)) {
      await this.untrackDocs([docId]);
    }
    // Mark document as deleted in store (adds a tombstone until sync commits it)
    await strategy.deleteDoc(docId);
    await this.onDeleteDoc.emit(docId);
  }

  /**
   * Gets an open document instance by ID, if it exists.
   * Used by PatchesSync for applying server changes to open docs.
   * @param docId - The document ID to get.
   * @returns The PatchesDoc instance or undefined if not open.
   */
  getOpenDoc<T extends object>(docId: string): PatchesDoc<T> | undefined {
    return this.docs.get(docId)?.doc as PatchesDoc<T> | undefined;
  }

  /**
   * Closes all open documents and cleans up listeners and store connections.
   * Should be called when shutting down the client.
   */
  async close(): Promise<void> {
    // Clean up local PatchesDoc listeners
    this.docs.forEach(managed => managed.unsubscribe());
    this.docs.clear();

    // Close all strategies (each closes its store)
    await Promise.all(Object.values(this.strategies).map(s => s?.close()));

    this.onChange.clear();
    this.onDeleteDoc.clear();
    this.onUntrackDocs.clear();
    this.onTrackDocs.clear();
    this.onServerCommit.clear();
    this.onError.clear();
  }

  /**
   * Internal handler for doc changes. Called when doc.onChange emits ops.
   * Delegates to strategy for packaging and persisting.
   */
  protected async _handleDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T>,
    strategy: ClientStrategy,
    metadata: Record<string, any>
  ): Promise<void> {
    try {
      // Strategy packages ops, saves to store, and updates doc state
      await strategy.handleDocChange(docId, ops, doc, metadata);
      // Notify listeners that this doc has pending changes
      this.onChange.emit(docId);
    } catch (err) {
      console.error(`Error handling doc change for ${docId}:`, err);
      this.onError.emit(err as Error, { docId });
    }
  }
}

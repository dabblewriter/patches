import { type Unsubscriber, signal } from '../event-signal.js';
import type { JSONPatchOp } from '../json-patch/types.js';
import type { Change } from '../types.js';
import { singleInvocation } from '../utils/concurrency.js';
import type { ClientAlgorithm } from './ClientAlgorithm.js';
import type { PatchesDoc, PatchesDocOptions } from './PatchesDoc.js';
import type { AlgorithmName } from './PatchesStore.js';

/**
 * Options for opening a document, passed through to `patches.openDoc()`.
 */
export interface OpenDocOptions {
  /** Optional metadata to attach to the document. */
  metadata?: Record<string, any>;
  /** Override the algorithm for this document (defaults to the Patches instance default). */
  algorithm?: AlgorithmName;
}

/**
 * Options for creating a Patches instance.
 * Provides algorithms map and optional default algorithm.
 */
export interface PatchesOptions {
  /** Map of algorithm name to algorithm instance. Each algorithm owns its store. */
  algorithms: Partial<Record<AlgorithmName, ClientAlgorithm>>;
  /** Default algorithm to use when opening docs. Must be a key in algorithms map. */
  defaultAlgorithm?: AlgorithmName;
  /** Initial metadata to attach to changes from this client (merged with per-doc metadata). */
  metadata?: Record<string, any>;
  /** Document-level options to pass to each PatchesDoc instance */
  docOptions?: PatchesDocOptions;
}

// Internal doc management structure
interface ManagedDoc<T extends object> {
  doc: PatchesDoc<T>;
  algorithm: ClientAlgorithm;
  unsubscribe: Unsubscriber;
}

/**
 * Main client-side entry point for the Patches library.
 * Manages document instances (`PatchesDoc`) and coordinates with algorithms.
 * Can be used standalone or with PatchesSync for network synchronization.
 *
 * Patches owns docs. Algorithms own their stores.
 */
export class Patches {
  protected options: PatchesOptions;
  protected docs: Map<string, ManagedDoc<any>> = new Map();

  readonly docOptions: PatchesDocOptions;
  readonly algorithms: Partial<Record<AlgorithmName, ClientAlgorithm>>;
  readonly defaultAlgorithm: AlgorithmName;
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
    this.algorithms = opts.algorithms;

    // Determine default algorithm
    const algorithmNames = Object.keys(opts.algorithms) as AlgorithmName[];
    if (algorithmNames.length === 0) {
      throw new Error('At least one algorithm must be provided');
    }
    this.defaultAlgorithm = opts.defaultAlgorithm ?? algorithmNames[0];
    if (!opts.algorithms[this.defaultAlgorithm]) {
      throw new Error(`Default algorithm '${this.defaultAlgorithm}' not found in algorithms map`);
    }

    this.docOptions = opts.docOptions ?? {};

    // Load tracked docs from all algorithm stores
    this.init();
  }

  /**
   * Loads tracked docs from all registered algorithm stores.
   * Extracted as a protected method so subclasses can override initialization behavior.
   */
  protected init(): void {
    const algorithms = Object.values(this.algorithms).filter(Boolean) as ClientAlgorithm[];
    Promise.all(
      algorithms.map(algorithm =>
        algorithm.listDocs().then(docs => {
          this.trackDocs(docs.map(({ docId }) => docId));
        })
      )
    ).catch(err => {
      console.error('Failed to load tracked docs during initialization:', err);
    });
  }

  /**
   * Gets an algorithm by name, throwing if not found.
   */
  protected _getAlgorithm(name: AlgorithmName): ClientAlgorithm {
    const algorithm = this.algorithms[name];
    if (!algorithm) {
      throw new Error(`Algorithm '${name}' not found`);
    }
    return algorithm;
  }

  /**
   * Gets the algorithm for an open document.
   */
  getDocAlgorithm(docId: string): ClientAlgorithm | undefined {
    return this.docs.get(docId)?.algorithm;
  }

  // --- Public API Methods ---

  /**
   * Tracks the given document IDs, adding them to the set of tracked documents and notifying listeners.
   * Tracked docs are kept in sync with the server, even when not open locally.
   * This allows for background syncing and updates of unopened documents.
   * @param docIds - Array of document IDs to track.
   * @param algorithmName - Algorithm to use for tracking (defaults to defaultAlgorithm).
   */
  async trackDocs(docIds: string[], algorithmName?: AlgorithmName): Promise<void> {
    docIds = docIds.filter(id => !this.trackedDocs.has(id));
    if (!docIds.length) return;
    docIds.forEach(this.trackedDocs.add, this.trackedDocs);
    this.onTrackDocs.emit(docIds);
    const algorithm = this._getAlgorithm(algorithmName ?? this.defaultAlgorithm);
    await algorithm.trackDocs(docIds);
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

    // Untrack from each doc's algorithm
    // Group by algorithm and untrack
    const byAlgorithm = new Map<ClientAlgorithm, string[]>();
    for (const docId of docIds) {
      const managed = this.docs.get(docId);
      const algorithm = managed?.algorithm ?? this._getAlgorithm(this.defaultAlgorithm);
      const list = byAlgorithm.get(algorithm) ?? [];
      list.push(docId);
      byAlgorithm.set(algorithm, list);
    }
    await Promise.all([...byAlgorithm.entries()].map(([algorithm, ids]) => algorithm.untrackDocs(ids)));
  }

  /**
   * Opens a document by ID, loading its state from the store and setting up change listeners.
   * If the doc is already open, returns the existing instance.
   * @param docId - The document ID to open.
   * @param opts - Optional metadata and algorithm override.
   * @returns The opened PatchesDoc instance.
   */
  @singleInvocation(true) // ensure a second call to openDoc with the same docId returns the same promise while opening
  async openDoc<T extends object>(docId: string, opts: OpenDocOptions = {}): Promise<PatchesDoc<T>> {
    const existing = this.docs.get(docId);
    if (existing) return existing.doc as PatchesDoc<T>;

    // Determine the algorithm for this doc:
    // 1. Use opts.algorithm if explicitly provided
    // 2. Otherwise, check if already tracked and read persisted algorithm
    // 3. Fall back to defaultAlgorithm
    let algorithmName = opts.algorithm;

    if (!algorithmName) {
      // Check all algorithm stores to see if this doc is already tracked
      for (const algo of Object.values(this.algorithms) as ClientAlgorithm[]) {
        const docs = await algo.listDocs(false);
        const tracked = docs.find(d => d.docId === docId);
        if (tracked?.algorithm) {
          algorithmName = tracked.algorithm;
          break;
        }
      }
      algorithmName = algorithmName ?? this.defaultAlgorithm;
    }

    const algorithm = this._getAlgorithm(algorithmName);

    // Ensure the doc is tracked before proceeding
    await this.trackDocs([docId], algorithmName);

    // Load initial state from store via algorithm
    const snapshot = await algorithm.loadDoc(docId);
    const mergedMetadata = { ...this.options.metadata, ...opts.metadata };

    // Create the appropriate doc type via algorithm (now takes docId and snapshot)
    const doc = algorithm.createDoc<T>(docId, snapshot);

    // Set up local listener -> algorithm handles packaging ops
    const unsubscribe = doc.onChange(ops => this._handleDocChange(docId, ops, doc, algorithm, mergedMetadata));
    this.docs.set(docId, { doc: doc as PatchesDoc<any>, algorithm, unsubscribe });

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
    // Get the algorithm for this doc (or default)
    const managed = this.docs.get(docId);
    const algorithm = managed?.algorithm ?? this._getAlgorithm(this.defaultAlgorithm);

    // Close if open locally
    if (this.docs.has(docId)) {
      await this.closeDoc(docId);
    }
    // Unsubscribe from server if tracked (deletes the doc from the store before the next step adds a tombstone)
    if (this.trackedDocs.has(docId)) {
      await this.untrackDocs([docId]);
    }
    // Mark document as deleted in store (adds a tombstone until sync commits it)
    await algorithm.deleteDoc(docId);
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

    // Close all algorithms (each closes its store)
    await Promise.all(Object.values(this.algorithms).map(s => s?.close()));

    this.onChange.clear();
    this.onDeleteDoc.clear();
    this.onUntrackDocs.clear();
    this.onTrackDocs.clear();
    this.onServerCommit.clear();
    this.onError.clear();
  }

  /**
   * Internal handler for doc changes. Called when doc.onChange emits ops.
   * Delegates to algorithm for packaging and persisting.
   */
  protected async _handleDocChange<T extends object>(
    docId: string,
    ops: JSONPatchOp[],
    doc: PatchesDoc<T>,
    algorithm: ClientAlgorithm,
    metadata: Record<string, any>
  ): Promise<void> {
    try {
      // Algorithm packages ops, saves to store, and updates doc state
      await algorithm.handleDocChange(docId, ops, doc, metadata);
      // Notify listeners that this doc has pending changes
      this.onChange.emit(docId);
    } catch (err) {
      console.error(`Error handling doc change for ${docId}:`, err);
      this.onError.emit(err as Error, { docId });
    }
  }
}

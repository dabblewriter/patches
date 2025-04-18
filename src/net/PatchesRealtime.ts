import { PatchDoc } from '../client/PatchDoc.js';
import { type Signal } from '../event-signal.js';
import type { ConnectionState } from './protocol/types.js';
import { PatchesWebSocket } from './websocket/PatchesWebSocket.js';

export interface PatchesRealtimeOptions {
  /** Initial metadata to attach to changes from this client */
  metadata?: Record<string, any>;
  /** Custom WebSocket configuration (e.g. headers, protocols) */
  wsOptions?: any; // TODO: type this properly based on WebSocket options
}

/**
 * High-level client for real-time collaborative editing.
 * Manages WebSocket connection and document synchronization.
 */
export class PatchesRealtime {
  private ws: PatchesWebSocket;
  private docs: Map<string, PatchDoc<any>> = new Map();
  private options: PatchesRealtimeOptions;

  /** Emitted when connection state changes */
  readonly onStateChange: Signal<(state: ConnectionState) => void>;

  constructor(url: string, opts: PatchesRealtimeOptions = {}) {
    this.ws = new PatchesWebSocket(url);
    this.options = opts;
    this.onStateChange = this.ws.onStateChange;
  }

  /**
   * Establishes connection to the server
   */
  async connect(): Promise<void> {
    await this.ws.connect();
  }

  /**
   * Opens a document and sets up real-time synchronization
   */
  async openDoc<T extends object>(docId: string, opts: { metadata?: Record<string, any> } = {}): Promise<PatchDoc<T>> {
    // If we already have this doc open, return it
    const existing = this.docs.get(docId) as PatchDoc<T> | undefined;
    if (existing) return existing;

    // Subscribe first to ensure we don't miss any updates
    await this.ws.subscribe(docId);

    // Get initial state
    const snapshot = await this.ws.getDoc(docId);

    // Create PatchDoc with initial state
    const doc = new PatchDoc<T>(snapshot.state as T, { ...this.options.metadata, ...opts.metadata });

    // Set up sync
    this._setupDocSync(docId, doc);

    // Store for reuse
    this.docs.set(docId, doc);

    return doc;
  }

  /**
   * Closes all connections and cleans up resources
   */
  close(): void {
    // Unsubscribe from all docs
    const docIds = Array.from(this.docs.keys());
    if (docIds.length) {
      this.ws.unsubscribe(docIds).catch(err => {
        console.warn('Error unsubscribing during close:', err);
      });
    }

    // Clear doc references
    this.docs.clear();

    // Close websocket
    this.ws.disconnect();
  }

  private _setupDocSync(docId: string, doc: PatchDoc<any>): void {
    // Listen for remote changes
    this.ws.onChangesCommitted(({ docId: updateDocId, changes }) => {
      if (updateDocId === docId) {
        doc.applyExternalServerUpdate(changes);
      }
    });

    // Send local changes to server
    doc.onChange(async () => {
      if (!doc.isSending && doc.hasPending) {
        try {
          const changes = doc.getUpdatesForServer();
          const serverCommit = await this.ws.commitChanges(docId, changes);
          doc.applyServerConfirmation(serverCommit);
        } catch (err) {
          console.error('Error sending changes to server:', err);
          // TODO: Consider retry logic or error handling strategy
          // For now, changes remain in pending state and will be retried
          // on next local change
        }
      }
    });
  }
}

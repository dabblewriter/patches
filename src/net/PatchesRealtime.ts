import { PatchDoc } from '../client/PatchDoc.js';
import { type Signal, type Unsubscriber } from '../event-signal.js';
import type { ConnectionState } from './protocol/types.js';
import { PatchesWebSocket } from './websocket/PatchesWebSocket.js';
import type { WebSocketOptions } from './websocket/WebSocketTransport.js';

export interface PatchesRealtimeOptions {
  /** Initial metadata to attach to changes from this client */
  metadata?: Record<string, any>;
  /** Custom WebSocket configuration (e.g. headers, protocols) */
  wsOptions?: WebSocketOptions;
}

interface ManagedDoc<T extends object> {
  doc: PatchDoc<T>;
  onChangeUnsubscriber: Unsubscriber;
}

/**
 * High-level client for real-time collaborative editing.
 * Manages WebSocket connection and document synchronization.
 */
export class PatchesRealtime {
  private ws: PatchesWebSocket;
  private docs: Map<string, ManagedDoc<any>> = new Map();
  private options: PatchesRealtimeOptions;
  private wsChangesUnsubscriber: Unsubscriber | null = null;

  /** Emitted when connection state changes */
  readonly onStateChange: Signal<(state: ConnectionState) => void>;

  constructor(url: string, opts: PatchesRealtimeOptions = {}) {
    this.ws = new PatchesWebSocket(url, opts.wsOptions);
    this.options = opts;
    this.onStateChange = this.ws.onStateChange;

    // Register a single listener for all incoming changes (Fix #2)
    this.wsChangesUnsubscriber = this.ws.onChangesCommitted(({ docId, changes }) => {
      const managedDoc = this.docs.get(docId);
      if (managedDoc) {
        try {
          managedDoc.doc.applyExternalServerUpdate(changes);
          // Attempt to send any new pending changes after applying external update (Fix #3)
          this._sendPendingIfNecessary(docId, managedDoc.doc);
        } catch (err) {
          console.error(`Error applying external server update for doc ${docId}:`, err);
          // Consider adding more robust error handling, e.g., closing the doc or attempting resync
        }
      }
      // If doc isn't open locally, we ignore the change (already unsubscribed or never opened)
    });
  }

  /**
   * Establishes connection to the server
   */
  async connect(): Promise<void> {
    // The underlying transport handles state checks, just call connect.
    await this.ws.connect();
  }

  /**
   * Opens a document and sets up real-time synchronization
   */
  async openDoc<T extends object>(docId: string, opts: { metadata?: Record<string, any> } = {}): Promise<PatchDoc<T>> {
    // Auto-connect if needed
    await this.connect();

    // If we already have this doc open, return it
    const existing = this.docs.get(docId)?.doc as PatchDoc<T> | undefined;
    if (existing) return existing;

    // Subscribe first to ensure we don't miss any updates
    // Note: Potential edge case if subscribe succeeds but getDoc fails.
    // Consider adding rollback/cleanup logic if needed.
    await this.ws.subscribe(docId);

    // Get initial state
    let snapshot;
    try {
      snapshot = await this.ws.getDoc(docId);
    } catch (err) {
      // If fetching fails, unsubscribe to avoid leaving dangling subscription
      this.ws.unsubscribe(docId).catch(unsubErr => {
        console.warn(`Failed to unsubscribe ${docId} after getDoc error:`, unsubErr);
      });
      throw err; // Re-throw original error
    }

    // Create PatchDoc and apply initial state
    const doc = new PatchDoc<T>(snapshot.state as T, { ...this.options.metadata, ...opts.metadata });
    doc.import(snapshot); // Ensures initial rev is set correctly

    // Set up sync and store unsubscriber
    const onChangeUnsubscriber = this._setupDocSync(docId, doc);

    // Store for reuse
    this.docs.set(docId, { doc, onChangeUnsubscriber });

    return doc;
  }

  /**
   * Closes a specific document, unsubscribes, and cleans up listeners.
   * @param docId The ID of the document to close.
   */
  async closeDoc(docId: string): Promise<void> {
    // (Fix #6b)
    const managedDoc = this.docs.get(docId);
    if (managedDoc) {
      // Clean up doc-specific listener (Fix #4)
      managedDoc.onChangeUnsubscriber();
      this.docs.delete(docId);

      // Unsubscribe from server updates for this doc
      try {
        await this.ws.unsubscribe(docId);
      } catch (err) {
        console.warn(`Error unsubscribing from doc ${docId}:`, err);
      }
    } else {
      // If doc not found, maybe unsubscribe anyway just in case?
      // Or just warn/log?
      console.warn(`closeDoc called for non-existent or already closed doc: ${docId}`);
    }
  }

  /**
   * Closes all documents and the WebSocket connection, cleaning up resources.
   */
  close(): void {
    // Unsubscribe from all docs on the server
    const docIds = Array.from(this.docs.keys());
    if (docIds.length) {
      this.ws.unsubscribe(docIds).catch(err => {
        console.warn('Error unsubscribing from documents during close:', err);
      });
    }

    // Clean up all local doc listeners (Fix #4)
    this.docs.forEach(managedDoc => managedDoc.onChangeUnsubscriber());
    this.docs.clear();

    // Clean up the global WebSocket listener (Fix #4)
    if (this.wsChangesUnsubscriber) {
      this.wsChangesUnsubscriber();
      this.wsChangesUnsubscriber = null;
    }

    // Close websocket connection
    this.ws.disconnect();
  }

  /** Sets up synchronization listeners for a single document and returns the onChange unsubscriber */
  private _setupDocSync(docId: string, doc: PatchDoc<any>): Unsubscriber {
    // Send local changes to server
    // Returns the unsubscriber function (Fix #4)
    return doc.onChange(async () => {
      // Attempt to send immediately after a local change
      await this._sendPendingIfNecessary(docId, doc);
    });
  }

  /** Checks if a doc has pending changes and attempts to send them */
  private async _sendPendingIfNecessary(docId: string, doc: PatchDoc<any>): Promise<void> {
    // (Fix #3)
    if (!doc.isSending && doc.hasPending) {
      try {
        const changes = doc.getUpdatesForServer();
        if (changes.length === 0) return; // Should not happen if hasPending is true, but check anyway

        const serverCommit = await this.ws.commitChanges(docId, changes);
        doc.applyServerConfirmation(serverCommit);

        // IMPORTANT: After confirmation, check AGAIN if more pending changes
        // were added while the request was in flight.
        await this._sendPendingIfNecessary(docId, doc);
      } catch (err) {
        console.error(`Error sending changes to server for doc ${docId}:`, err);
        // TODO: Consider retry logic or error handling strategy
        // For now, changes remain in pending state. The next local change
        // or external update might trigger another send attempt.
      }
    }
  }
}

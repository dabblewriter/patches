import { PatchDoc } from '../client/PatchDoc.js';
import { signal, type Unsubscriber } from '../event-signal.js';
import type { PatchesState } from './types.js';
import { onlineState } from './websocket/onlineState.js';
import { PatchesWebSocket } from './websocket/PatchesWebSocket.js';
import type { WebSocketOptions } from './websocket/WebSocketTransport.js';

export interface PatchesRealtimeOptions {
  /** Initial metadata to attach to changes from this client */
  metadata?: Record<string, any>;
  /** Custom WebSocket configuration (e.g. headers, protocols) */
  wsOptions?: WebSocketOptions;
}

/** @internal Internal structure to manage document instances and their listeners. */
interface ManagedDoc<T extends object> {
  doc: PatchDoc<T>;
  /** Function to unsubscribe from the document's local onChange events. */
  onChangeUnsubscriber: Unsubscriber;
}

/**
 * High-level client for real-time collaborative editing.
 * Manages WebSocket connection and document synchronization.
 */
export class PatchesRealtime {
  private _state: PatchesState = {
    online: false,
    connected: false,
    syncing: null,
  };
  private ws: PatchesWebSocket;
  private docs: Map<string, ManagedDoc<any>> = new Map();
  private options: PatchesRealtimeOptions;
  private wsChangesUnsubscriber: Unsubscriber | null = null;

  /** Emitted when an error occurs during synchronization or connection. */
  readonly onError =
    signal<
      (details: {
        type: 'sendFailed' | 'applyFailed' | 'syncError' | 'connectionError';
        docId?: string;
        error: Error;
        recoveryAttempted?: boolean;
        recoveryError?: Error;
      }) => void
    >();

  /** Emitted when the WebSocket connection state changes. */
  readonly onStateChange = signal<(state: PatchesState) => void>();

  /**
   * Creates an instance of PatchesRealtime.
   * @param url The WebSocket URL of the Patches server.
   * @param opts Configuration options.
   */
  constructor(url: string, opts: PatchesRealtimeOptions = {}) {
    this.ws = new PatchesWebSocket(url, opts.wsOptions);
    this.options = opts;

    // Re-emit the state change signal and track internally
    this.ws.onStateChange(state => (this.state = { connected: state === 'connected' }));
    onlineState.onOnlineChange(isOnline => (this.state = { online: isOnline }));

    // Register a single listener for all incoming changes from the WebSocket.
    this.wsChangesUnsubscriber = this.ws.onChangesCommitted(({ docId, changes }) => {
      const managedDoc = this.docs.get(docId);
      if (managedDoc) {
        try {
          // Apply changes received from the server to the local document copy.
          managedDoc.doc.applyExternalServerUpdate(changes);
          // After applying, immediately check if there are new local changes to send.
          this._sendPendingIfNecessary(docId, managedDoc.doc);
        } catch (error) {
          console.error(`Error applying external server update for doc ${docId}:`, error);
          const err = error instanceof Error ? error : new Error(String(error));
          // Emit error and attempt recovery by resyncing
          this.onError.emit({ type: 'applyFailed', docId, error: err, recoveryAttempted: true });
          // Use void to explicitly ignore the promise returned by _resyncDoc
          void this._resyncDoc(docId);
        }
      }
      // If the document isn't open locally (e.g., already closed), ignore the incoming change.
    });
  }

  get state(): PatchesState {
    return this._state;
  }

  protected set state(value: Partial<PatchesState>) {
    this._state = { ...this._state, ...value };
    this.onStateChange.emit(this._state);
  }

  /**
   * Establishes the WebSocket connection to the server.
   * Automatically called by `openDoc` if not already connected.
   */
  async connect(): Promise<void> {
    // The underlying PatchesWebSocket handles connection state and idempotency.
    await this.ws.connect();
  }

  /**
   * Establishes the WebSocket connection to the server.
   * Automatically called by `openDoc` if not already connected.
   */
  disconnect(): void {
    this.ws.disconnect();
  }

  /**
   * Opens a document by its ID, fetches its initial state, and sets up
   * real-time synchronization. If the document is already open, returns
   * the existing instance.
   * @param docId The unique identifier for the document.
   * @param opts Options, including optional metadata specific to this client's interaction with the document.
   * @returns A Promise resolving to the synchronized PatchDoc instance.
   * @throws If the connection fails, subscription fails, or fetching the initial document state fails.
   */
  async openDoc<T extends object>(docId: string, opts: { metadata?: Record<string, any> } = {}): Promise<PatchDoc<T>> {
    // Ensure connection is established before proceeding.
    await this.connect();

    // Return existing instance if already managed.
    const existingManagedDoc = this.docs.get(docId);
    if (existingManagedDoc) {
      return existingManagedDoc.doc as PatchDoc<T>;
    }

    // Subscribe to server updates for this document ID *before* fetching state
    // to avoid missing updates that might occur between getDoc and subscription completion.
    await this.ws.subscribe(docId);

    let snapshot;
    try {
      // Fetch the initial state (snapshot) of the document from the server.
      snapshot = await this.ws.getDoc(docId);
    } catch (err) {
      // If fetching the document fails, attempt to clean up by unsubscribing.
      console.error(`Failed to get initial state for doc ${docId}, attempting to unsubscribe:`, err);
      this.ws.unsubscribe(docId).catch(unsubErr => {
        // Log secondary error if unsubscribe also fails, but prioritize original error.
        console.warn(`Failed to unsubscribe ${docId} after getDoc error:`, unsubErr);
      });
      // Re-throw the original error to signal failure to the caller.
      throw err;
    }

    // Create the local PatchDoc instance with the fetched state and merged metadata.
    const doc = new PatchDoc<T>(snapshot.state as T, { ...this.options.metadata, ...opts.metadata });
    // Import the snapshot details (like revision number) into the PatchDoc.
    doc.import(snapshot);
    // Set up the listener to send local changes to the server.
    const onChangeUnsubscriber = this._setupDocSync(docId, doc);

    // Store the document instance and its change listener unsubscriber.
    this.docs.set(docId, { doc, onChangeUnsubscriber });

    return doc;
  }

  /**
   * Closes a specific document locally, stops listening for its changes,
   * and unsubscribes from server updates for that document.
   * @param docId The ID of the document to close.
   */
  async closeDoc(docId: string): Promise<void> {
    const managedDoc = this.docs.get(docId);
    if (managedDoc) {
      // Stop listening to local changes for this document.
      managedDoc.onChangeUnsubscriber();
      // Remove the document from local management.
      this.docs.delete(docId);

      // Unsubscribe from server updates for this document.
      try {
        await this.ws.unsubscribe(docId);
      } catch (err) {
        // Log error but continue, as the primary goal (local cleanup) is done.
        console.warn(`Error unsubscribing from doc ${docId} during closeDoc:`, err);
      }
    } else {
      // Log if closeDoc is called for a document not currently managed.
      // This might indicate a logic error elsewhere or harmless redundant calls.
      console.warn(`closeDoc called for non-existent or already closed doc: ${docId}`);
      // No need to attempt unsubscribe if we don't think we were subscribed.
    }
  }

  /**
   * Closes all open documents, unsubscribes from all server updates,
   * cleans up all local listeners, and disconnects the WebSocket.
   */
  close(): void {
    // Attempt to unsubscribe from all currently managed documents on the server.
    const docIds = Array.from(this.docs.keys());
    if (docIds.length > 0) {
      this.ws.unsubscribe(docIds).catch(err => {
        console.warn('Error unsubscribing from documents during close:', err);
      });
    }

    // Clean up local change listeners for all managed documents.
    this.docs.forEach(managedDoc => managedDoc.onChangeUnsubscriber());
    this.docs.clear(); // Remove all documents from local management.

    // Clean up the global listener for incoming changes from the WebSocket.
    if (this.wsChangesUnsubscriber) {
      this.wsChangesUnsubscriber();
      this.wsChangesUnsubscriber = null;
    }

    // Disconnect the WebSocket connection.
    this.ws.disconnect();
  }

  /**
   * Sets up the synchronization logic for a single document. Listens for local
   * changes on the `PatchDoc` and triggers sending them to the server.
   * @param docId The document ID.
   * @param doc The `PatchDoc` instance.
   * @returns An unsubscriber function to remove the listener.
   * @internal
   */
  private _setupDocSync(docId: string, doc: PatchDoc<any>): Unsubscriber {
    // Listen for local changes and attempt to send them.
    return doc.onChange(async () => {
      // Attempt to send immediately after a local change
      await this._sendPendingIfNecessary(docId, doc);
    });
  }

  /**
   * Checks if a document has pending local changes that haven't been sent
   * to the server and attempts to send them if the document is not already
   * in the process of sending. Handles server confirmation and potential
   * new changes that occurred during the send operation.
   * @param docId The document ID.
   * @param doc The `PatchDoc` instance.
   * @internal
   */
  private async _sendPendingIfNecessary(docId: string, doc: PatchDoc<any>): Promise<void> {
    // Only proceed if there are pending changes and we are not already sending.
    if (!doc.isSending && doc.hasPending) {
      let changes;
      try {
        // Get the changes formatted for the server.
        changes = doc.getUpdatesForServer();
        // Basic sanity check - should not happen if hasPending is true.
        if (changes.length === 0) {
          console.warn(
            `_sendPendingIfNecessary called for ${docId} with hasPending=true but getUpdatesForServer returned empty.`
          );
          return;
        }

        // Send the changes to the server via WebSocket.
        const serverCommit = await this.ws.commitChanges(docId, changes);
        // Apply the server's confirmation (e.g., updated revision number) to the local doc.
        doc.applyServerConfirmation(serverCommit);
        // IMPORTANT: After successful confirmation, immediately check again.
        // New local changes might have occurred while the commit request was in flight.
        // This recursive call ensures those are sent promptly.
        await this._sendPendingIfNecessary(docId, doc);
      } catch (error) {
        console.error(`Error sending changes to server for doc ${docId}:`, error);
        const err = error instanceof Error ? error : new Error(String(error));

        // Notify PatchDoc to move sending changes back to pending
        doc.handleSendFailure();

        // Emit error and attempt recovery if online
        this.onError.emit({ type: 'sendFailed', docId, error: err, recoveryAttempted: true });

        // Use the internally tracked state
        if (this._state.connected) {
          console.warn(`Attempting recovery via resync for doc ${docId} after send failure.`);
          // Use void to explicitly ignore the promise returned by _resyncDoc
          void this._resyncDoc(docId);
        } else {
          console.warn(`Send failure for doc ${docId} while offline. Recovery deferred until reconnection.`);
          // No immediate recovery action needed, handleSendFailure already reset state.
          // The standard reconnection logic should trigger a send attempt later.
        }
      }
    }
  }

  /**
   * Attempts to resynchronize a document by fetching its latest state from the server.
   * @param docId The ID of the document to resynchronize.
   * @internal
   */
  private async _resyncDoc(docId: string): Promise<void> {
    const managedDoc = this.docs.get(docId);
    if (!managedDoc) {
      console.warn(`_resyncDoc called for non-managed doc: ${docId}`);
      return;
    }

    try {
      const snapshot = await this.ws.getDoc(docId);
      // Import will trigger recalculateLocalState and onUpdate
      managedDoc.doc.import(snapshot);
      // Do NOT immediately trigger send after resync, let next user action or connection event handle it.
      // This prevents potential loops during error recovery scenarios.
      // await this._sendPendingIfNecessary(docId, managedDoc.doc);
    } catch (recoveryError) {
      console.error(`Failed to resync doc ${docId}:`, recoveryError);
      const recErr = recoveryError instanceof Error ? recoveryError : new Error(String(recoveryError));
      // Emit a specific syncError to indicate recovery failure
      this.onError.emit({
        type: 'syncError',
        docId,
        // TODO: Should we include the original error that triggered the resync attempt?
        // For now, just include the recovery error itself.
        error: recErr, // Error during the recovery attempt
        recoveryAttempted: true,
        recoveryError: recErr,
      });
      // If resync fails, the document might be in an inconsistent state.
      // Further actions might be needed (e.g., closing the doc, user notification).
    }
  }
}

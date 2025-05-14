import type { Unsubscriber } from '../../event-signal.js';
import type { Change, ListVersionsOptions, PatchesSnapshot, PatchesState, VersionMetadata } from '../../types';

/**
 * Represents the possible states of a network transport connection.
 * - 'connecting': Connection is being established
 * - 'connected': Connection is active and ready for communication
 * - 'disconnected': Connection is not active
 * - 'error': Connection encountered an error
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Minimal contract that the JSON-RPC layer (and therefore Patches core) relies on.
 * A transport only needs the ability to **send** raw strings and **deliver** raw
 * strings it receives from the other side.
 *
 * Anything beyond that (connect/disconnect lifecycle, connection state, etc.) is
 * not needed or handled by Patches and so is not defined here.
 */
export interface ClientTransport {
  /**
   * Sends a raw, already-encoded message over the wire.
   */
  send(raw: string): void | Promise<void>;

  /**
   * Subscribes to incoming raw messages. Returns an {@link Unsubscriber} so the
   * caller can remove the handler if it no longer cares about incoming data.
   */
  onMessage(cb: (raw: string) => void): Unsubscriber;
}

/**
 * Minimal contract for server-side transports that can have **multiple** logical peers.
 * Each message must indicate the **from / to** connection. Any additional lifecycle
 * management (upgrade, close, etc.) stays inside the concrete adapter.
 */
export interface ServerTransport {
  /** Get a list of all active connection IDs */
  getConnectionIds(): string[];

  /** Send a raw JSON-RPC string to a specific connection */
  send(toConnectionId: string, raw: string): void | Promise<void>;

  /** Subscribe to incoming raw frames from any client */
  onMessage(cb: (fromConnectionId: string, raw: string) => void): Unsubscriber;
}

/**
 * Represents a JSON-RPC 2.0 request object.
 */
export interface Request {
  /** JSON-RPC protocol version, always "2.0" */
  jsonrpc: '2.0';
  /** Request identifier, used to match responses to requests */
  id?: number;
  /** Name of the remote procedure to call */
  method: string;
  /** Parameters to pass to the remote procedure */
  params?: any;
}

/**
 * Represents a JSON-RPC 2.0 response object.
 */
export interface Response {
  /** JSON-RPC protocol version, always "2.0" */
  jsonrpc: '2.0';
  /** Response identifier, matches the id of the corresponding request */
  id: number;
  /** Result of the successful procedure call */
  result?: any;
  /** Error information if the procedure call failed */
  error?: {
    /** Numeric error code */
    code: number;
    /** Short error description */
    message: string;
    /** Additional error details (optional) */
    data?: any;
  };
}

/**
 * Represents a JSON-RPC 2.0 notification object.
 * Notifications are one-way messages that don't expect a response.
 */
export interface Notification {
  /** JSON-RPC protocol version, always "2.0" */
  jsonrpc: '2.0';
  /** Name of the notification method */
  method: string;
  /** Parameters associated with the notification */
  params?: any;
}

/** Union type for all possible JSON-RPC message types */
export type Message = Request | Response | Notification;

export interface ListOptions {
  startAt?: string;
  startAfter?: string;
  endAt?: string;
  endBefore?: string;
  prefix?: string;
  limit?: number;
  reverse?: boolean;
}

export interface PatchesAPI {
  // === Subscription Operations ===
  /**
   * Subscribes the connected client to one or more documents.
   * @param ids Document ID(s) to subscribe to.
   * @returns A list of document IDs the client is now successfully subscribed to.
   */
  subscribe(ids: string | string[]): Promise<string[]>;

  /**
   * Unsubscribes the connected client from one or more documents.
   * @param ids Document ID(s) to unsubscribe from.
   */
  unsubscribe(ids: string | string[]): Promise<void>;

  // === Document Operations ===
  /** Get the latest version of a document and changes since the last version. */
  getDoc(docId: string, atRev?: number): Promise<PatchesSnapshot>;

  /** Get changes that occurred after a specific revision. */
  getChangesSince(docId: string, rev: number): Promise<Change[]>;

  /** Apply a set of changes from the client to a document. Returns the committed changes. */
  commitChanges(docId: string, changes: Change[]): Promise<Change[]>;

  /** Delete a document. */
  deleteDoc(docId: string): Promise<void>;

  // === Version Operations ===
  /** Create a new named version snapshot of a document's current state. */
  createVersion(docId: string, name: string): Promise<string>; // Returns versionId

  /** List metadata for saved versions of a document. */
  listVersions(docId: string, options?: ListVersionsOptions): Promise<VersionMetadata[]>;

  /** Get the state snapshot for a specific version ID. */
  getVersionState(docId: string, versionId: string): Promise<PatchesState>;

  /** Get the original Change objects associated with a specific version ID. */
  getVersionChanges(docId: string, versionId: string): Promise<Change[]>;

  /** Update the name of a specific version. */
  updateVersion(docId: string, versionId: string, updates: Pick<VersionMetadata, 'name'>): Promise<void>;
}

// Also define the expected parameters for notifications the server might send:
export interface PatchesNotificationParams {
  docId: string;
  changes: Change[];
}

export interface AwarenessUpdateNotificationParams {
  docId: string;
  /** The awareness state from a specific client (server should add sender info) */
  state: any;
  /** Server should add the client ID of the sender */
  clientId?: string;
}

// Add notification params for WebRTC signaling
export interface SignalNotificationParams {
  fromClientId: string;
  data: any;
}

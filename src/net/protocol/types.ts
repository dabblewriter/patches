import type { Change, PatchesSnapshot, PatchesState, VersionMetadata } from '../../types';

/**
 * Represents the possible states of a network transport connection.
 * - 'connecting': Connection is being established
 * - 'connected': Connection is active and ready for communication
 * - 'disconnected': Connection is not active
 * - 'error': Connection encountered an error
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Interface defining the core functionality of a transport layer.
 * Transport implementations provide a communication channel between client and server,
 * abstracting the underlying protocol details (WebSocket, WebRTC, etc.).
 */
export interface Transport {
  /**
   * Establishes the connection for this transport.
   * @returns A promise that resolves when the connection is established
   */
  connect(): Promise<void>;

  /**
   * Terminates the connection for this transport.
   */
  disconnect(): void;

  /**
   * Sends data through this transport.
   * @param data - The string data to send
   */
  send(data: string): void;

  /**
   * Registers a handler for incoming messages.
   * @param handler - Function that will be called when a message is received
   */
  onMessage(handler: (data: string) => void): void;

  /**
   * Registers a handler for connection state changes.
   * @param handler - Function that will be called when the connection state changes
   */
  onStateChange(handler: (state: ConnectionState) => void): void;
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
  listVersions(docId: string, options: ListOptions): Promise<VersionMetadata[]>;

  /** Get the state snapshot for a specific version ID. */
  getVersionState(docId: string, versionId: string): Promise<PatchesState>;

  /** Get the original Change objects associated with a specific version ID. */
  getVersionChanges(docId: string, versionId: string): Promise<Change[]>;

  /** Update the name of a specific version. */
  updateVersion(docId: string, versionId: string, name: string): Promise<void>;
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

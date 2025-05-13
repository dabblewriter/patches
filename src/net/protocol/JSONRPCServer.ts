import { signal, type Signal, type Unsubscriber } from '../../event-signal.js';
import { PatchesServer } from '../../server/PatchesServer.js';
import type { Change, ListVersionsOptions } from '../../types.js';
import type { Message, Notification, Request, Response, Transport } from './types.js';

export type ConnectionSignalSubscriber = (connectionId: string, ...args: any[]) => any;

/**
 * Lightweight JSON-RPC 2.0 server adapter for {@link PatchesServer}.
 *
 * The class is intentionally transport-agnostic: it only needs an object that
 * fulfils the {@link Transport} contract (i.e. something that can exchange
 * string messages and notify when one arrives).  This makes it suitable for
 * WebSocket, TCP, or even `postMessage` usage.
 *
 * A new instance is typically created per connected client.  You therefore
 * pass in:
 *   • the {@link Transport} that represents this client connection
 *   • a shared (singleton) {@link PatchesServer}
 *   • the unique `clientId` that identifies the connection in subscription
 *     calls.  How you generate that ID (auth token, random GUID, etc.) is left
 *     to the host application.
 */
export class JSONRPCServer {
  /** Allow external callers to emit server-initiated notifications. */
  private readonly notificationSignals = new Map<string, Signal>();
  public readonly onSend = signal<(connectionId: string, msg: string) => void>();

  constructor(private readonly patches: PatchesServer) {}

  // -------------------------------------------------------------------------
  // Public helpers
  // -------------------------------------------------------------------------

  /**
   * Subscribes to server-sent notifications for a specific method.
   *
   * @param method - The notification method name to subscribe to
   * @param handler - The callback function that will be invoked when notifications are received
   * @returns A function that can be called to unsubscribe from the notifications
   * @template T - The type of the handler function
   */
  on<T extends ConnectionSignalSubscriber = ConnectionSignalSubscriber>(method: string, handler: T): Unsubscriber {
    let thisSignal = this.notificationSignals.get(method);
    if (!thisSignal) {
      thisSignal = signal();
      this.notificationSignals.set(method, thisSignal);
    }
    return thisSignal(handler);
  }

  /**
   * Sends a JSON-RPC notification (no `id`, therefore no response expected) to
   * the connected client.
   */
  notify(connectionIds: string[], method: string, params?: any): void {
    const msg: Notification = { jsonrpc: '2.0', method, params };
    const msgStr = JSON.stringify(msg);
    connectionIds.forEach(id => this.onSend.emit(id, msgStr));
  }

  /**
   * Handles incoming messages from the client.
   * @param connectionId - The WebSocket transport object.
   * @param raw - The raw message string.
   */
  async onMessage(connectionId: string, raw: string): Promise<void> {
    let message: Message;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      this._sendError(connectionId, null, -32700, 'Parse error', err);
      return;
    }

    if (message && typeof message === 'object' && 'method' in message) {
      // Notification or request either way--delegate.
      if ('id' in message && message.id !== undefined) {
        await this._handleRequest(connectionId, message as Request);
      } else {
        await this._handleNotification(connectionId, message as Notification);
      }
    } else {
      // Client sent something we do not understand.
      this._sendError(connectionId, (message as any)?.id ?? null, -32600, 'Invalid Request');
    }
  }

  /**
   * Handles incoming JSON-RPC requests from the client.
   * @param connectionId - The WebSocket transport object.
   * @param req - The JSON-RPC request object.
   */
  protected async _handleRequest(connectionId: string, req: Request): Promise<void> {
    try {
      const result = await this._dispatch(connectionId, req.method, req.params);
      const response: Response = { jsonrpc: '2.0', id: req.id as number, result };
      this.onSend.emit(connectionId, JSON.stringify(response));
    } catch (err: any) {
      this._sendError(connectionId, req.id as number, -32000, err?.message ?? 'Server error', err?.stack);
    }
  }

  /**
   * Handles incoming JSON-RPC notifications from the client.
   * @param connectionId - The WebSocket transport object.
   * @param note - The JSON-RPC notification object.
   */
  protected async _handleNotification(connectionId: string, note: Notification): Promise<void> {
    const thisSignal = this.notificationSignals.get(note.method);
    if (thisSignal) {
      thisSignal.emit(connectionId, note.params);
    }
  }

  /**
   * Maps JSON-RPC method names to {@link PatchesServer} calls.
   * @param connectionId - The WebSocket transport object.
   * @param method - The JSON-RPC method name.
   * @param params - The JSON-RPC parameters.
   * @returns The result of the {@link PatchesServer} call.
   */
  protected async _dispatch(connectionId: string, method: string, params: any): Promise<any> {
    switch (method) {
      // ---------------------------------------------------------------------
      // Subscription operations
      // ---------------------------------------------------------------------
      case 'subscribe': {
        const ids = params?.ids ?? params;
        return this.patches.subscribe(connectionId, ids);
      }
      case 'unsubscribe': {
        const ids = params?.ids ?? params;
        return this.patches.unsubscribe(connectionId, ids);
      }

      // ---------------------------------------------------------------------
      // Document operations
      // ---------------------------------------------------------------------
      case 'getDoc':
        return this.patches.getDoc(params.docId, params.atRev);
      case 'getChangesSince':
        return this.patches.getChangesSince(params.docId, params.rev);
      case 'commitChanges': {
        const [, /* committed */ transformed] = await this.patches.commitChanges(
          params.docId,
          params.changes as Change[]
        );
        return transformed;
      }
      case 'deleteDoc':
        return this.patches.deleteDoc(params.docId);

      // ---------------------------------------------------------------------
      // Version operations
      // ---------------------------------------------------------------------
      case 'createVersion':
        return this.patches.createVersion(params.docId, params.name);
      case 'listVersions':
        return this.patches.listVersions(params.docId, params.options as ListVersionsOptions);
      case 'getVersionState':
        return this.patches.getVersionState(params.docId, params.versionId);
      case 'getVersionChanges':
        return this.patches.getVersionChanges(params.docId, params.versionId);
      case 'updateVersion':
        return this.patches.updateVersion(params.docId, params.versionId, params.name);

      // ---------------------------------------------------------------------
      default:
        throw new Error(`Unknown method '${method}'.`);
    }
  }

  /**
   * Sends a JSON-RPC error object back to the client.
   */
  private _sendError(connectionId: string, id: number | null, code: number, message: string, data?: any): void {
    const errorObj: Response = {
      jsonrpc: '2.0',
      id: id as any,
      error: { code, message, data },
    } as Response; // type cast because TS cannot narrow when error present
    this.onSend.emit(connectionId, JSON.stringify(errorObj));
  }
}

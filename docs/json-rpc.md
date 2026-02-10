# JSON-RPC in Patches

Patches uses [JSON-RPC 2.0](https://www.jsonrpc.org/specification) for all client-server communication. It is a thin wrapper around plain JSON that specifies **what** you want (the _method_) and optionally waits for an answer (the _id_). No HTTP verbs to debate. No custom framing to invent.

## Why JSON-RPC?

1. **Minimal spec** - The entire specification fits on a single page. You can read and understand it in 10 minutes.
2. **Bidirectional** - Either side can send requests _or_ notifications. Perfect for pushing changes to collaborators.
3. **Transport-agnostic** - Works over WebSockets, TCP, HTTP, or anything else that can transmit strings.
4. **Easy to test** - Plain JSON means you can construct test payloads by hand and inspect responses without special tooling.

## The Building Blocks

### 1. Transports: The Wire

```typescript
interface ClientTransport {
  send(raw: string): void | Promise<void>;
  onMessage(cb: (raw: string) => void): Unsubscriber;
}

interface ServerTransport {
  getConnectionIds(): string[];
  send(toConnectionId: string, raw: string): void | Promise<void>;
  onMessage(cb: (fromConnectionId: string, raw: string) => void): Unsubscriber;
  listSubscriptions(docId: string): Promise<string[]>;
  addSubscription(clientId: string, docIds: string[]): Promise<string[]>;
  removeSubscription(clientId: string, docIds: string[]): Promise<string[]>;
}
```

`ClientTransport` has two methods. `ServerTransport` adds connection multiplexing and subscription tracking. Implement these interfaces and the rest of the stack does not care whether you use `ws`, `net.Socket`, or an in-memory mock.

### 2. JSONRPCClient: Ask and Listen

```typescript
import { WebSocketTransport } from '@dabble/patches/net';
import { JSONRPCClient } from '@dabble/patches/net';

const transport = new WebSocketTransport('wss://collab.example');
const rpc = new JSONRPCClient(transport);

// Make a request (returns a Promise)
const result = await rpc.call('getDoc', 'sales-proposal');

// Fire-and-forget notification (no response expected)
rpc.notify('ping');

// Listen for server-pushed notifications
rpc.on('changesCommitted', params => {
  console.log('Someone edited', params.docId);
});
```

- `call(method, ...args)` returns a Promise tied to the server's response
- `notify(method, ...args)` sends a message with no `id` - fire-and-forget
- `on(method, handler)` subscribes to server-initiated notifications

### 3. JSONRPCServer: Route and Respond

```typescript
import { JSONRPCServer } from '@dabble/patches/net';

const server = new JSONRPCServer({ auth: myAuthProvider });

// Register individual methods
server.registerMethod('echo', async message => {
  return message;
});

// Or register an entire object with a static `api` definition
// (OTServer, LWWServer, PatchesHistoryManager, and branch managers all do this)
server.register(otServer);

// Send notifications to clients
server.notify('changesCommitted', { docId, changes, options });
```

The server processes incoming messages via `processMessage(raw, ctx)`, which parses the JSON-RPC frame, dispatches to the registered handler, and returns the response (or `undefined` for notifications).

## API Methods

These are the JSON-RPC methods registered by Patches components. Your authorization provider controls which clients can call which methods.

### Core Document Operations

Registered by [OTServer](OTServer.md) or [LWWServer](LWWServer.md):

| Method            | Access  | Parameters                     | Returns        | Notes                                                     |
| ----------------- | ------- | ------------------------------ | -------------- | --------------------------------------------------------- |
| `getDoc`          | `read`  | `docId`                        | `PatchesState` | Returns current state and revision                        |
| `getChangesSince` | `read`  | `docId`, `rev`                 | `Change[]`     | Get changes after a specific revision                     |
| `commitChanges`   | `write` | `docId`, `changes`, `options?` | `Change[]`     | Commit changes; returns all changes client needs to apply |
| `deleteDoc`       | `write` | `docId`, `options?`            | `void`         | Delete a document (creates tombstone by default)          |
| `undeleteDoc`     | `write` | `docId`                        | `boolean`      | Remove tombstone to allow recreation                      |

### Subscription Operations

Registered by [WebSocketServer](websocket.md):

| Method        | Parameters | Returns    | Notes                                                |
| ------------- | ---------- | ---------- | ---------------------------------------------------- |
| `subscribe`   | `{ ids }`  | `string[]` | Subscribe to documents; returns IDs actually allowed |
| `unsubscribe` | `{ ids }`  | `string[]` | Remove subscriptions                                 |

### Version Operations

Registered by [PatchesHistoryManager](PatchesHistoryManager.md) (requires versioning-capable store):

| Method              | Access  | Parameters                       | Returns             |
| ------------------- | ------- | -------------------------------- | ------------------- |
| `listVersions`      | `read`  | `docId`, `options?`              | `VersionMetadata[]` |
| `createVersion`     | `write` | `docId`, `metadata?`             | `string \| null`    |
| `updateVersion`     | `write` | `docId`, `versionId`, `metadata` | `void`              |
| `getVersionState`   | `read`  | `docId`, `versionId`             | State snapshot      |
| `getVersionChanges` | `read`  | `docId`, `versionId`             | `Change[]`          |

### Branch Operations

Registered by [OTBranchManager or LWWBranchManager](branching.md) (requires branching-capable store):

| Method         | Access  | Parameters                  | Returns    |
| -------------- | ------- | --------------------------- | ---------- |
| `listBranches` | `read`  | `docId`                     | `Branch[]` |
| `createBranch` | `write` | `docId`, `rev`, `metadata?` | `string`   |
| `updateBranch` | `write` | `branchId`, `metadata`      | `void`     |
| `closeBranch`  | `write` | `branchId`, `status?`       | `void`     |
| `mergeBranch`  | `write` | `branchId`                  | `Change[]` |

## Notifications

The server pushes notifications to subscribed clients. Notifications have no `id` field and expect no response.

| Method             | When                             | Payload                  |
| ------------------ | -------------------------------- | ------------------------ |
| `changesCommitted` | After server commits changes     | `{ docId, changes }`     |
| `docDeleted`       | When a subscribed doc is deleted | `{ docId }`              |
| `signal`           | WebRTC signaling (if enabled)    | `{ fromClientId, data }` |

## How It Flows

Here is what happens when a client commits changes:

1. Client calls `rpc.call('commitChanges', docId, changes)`
2. JSONRPCClient wraps this as `{ jsonrpc: '2.0', id: 1, method: 'commitChanges', params: [docId, changes] }`
3. Server's JSONRPCServer parses the message, checks authorization, dispatches to the handler
4. Server returns `{ jsonrpc: '2.0', id: 1, result: [...committedChanges] }`
5. Server also fires `server.notify('changesCommitted', { docId, changes, options })` to other subscribers
6. Other clients receive the notification via their `rpc.on('changesCommitted', ...)` handlers

## Error Handling

When a method throws, the server responds with an error object:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Document not found",
    "data": { "docId": "nonexistent" }
  }
}
```

On the client side, `rpc.call()` rejects with this error object. Inspect `error.code` and `error.message` to decide how to handle it.

Standard JSON-RPC error codes:

- `-32700` - Parse error (invalid JSON)
- `-32600` - Invalid request (missing required fields)
- `-32601` - Method not found
- `-32000` to `-32099` - Server errors (Patches uses these for application-level errors)

## Tips

1. **Batch wisely** - JSON-RPC supports batch requests (array of requests in one message), but Patches typically handles batching at the change level via [breakChanges](algorithms.md). You rarely need to batch RPC calls yourself.

2. **Keep IDs simple** - The client uses incrementing integers starting at 1. They reset when the connection restarts. Do not overthink this.

3. **Notifications are one-way** - If you need confirmation, use a request. Notifications are for broadcasts where you do not care about individual acknowledgments.

## Related Documentation

- [Networking Overview](net.md) - How PatchesSync coordinates the full sync flow
- [WebSocket Transport](websocket.md) - WebSocket-specific setup and usage
- [OTServer](OTServer.md) - Server-side OT implementation
- [LWWServer](LWWServer.md) - Server-side LWW implementation
- [PatchesHistoryManager](PatchesHistoryManager.md) - Version management
- [Branching](branching.md) - Branch creation and merging

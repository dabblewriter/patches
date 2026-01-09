# JSON-RPC in Patches: Small, Simple, Superb ✨

> "Give me an envelope. I'll handle the letter." – JSON-RPC, probably

Patches leans on [JSON-RPC 2.0](https://www.jsonrpc.org/specification) for every bit of client-server chatter. It's a thin wrapper around plain JSON that lets us say **what** we want (the _method_) and optionally wait for the answer (the _id_). No HTTP verbs to argue about, no custom framing to invent.

## Why We Picked It 🍰

1. **Super-lightweight** – The spec fits on a single page.
2. **Bidirectional** – Either side can send requests _or_ notifications. Perfect for pushing patches to all collaborators.
3. **Transport-agnostic** – Works equally well over WebSockets, raw TCP, Serial, carrier pigeons… as long as you can sling strings.
4. **Tooling-friendly** – Easy to generate TypeScript helpers and unit-test stubs.

## The Building Blocks 🧩

### 1. Transports: The Wire

```ts
interface ClientTransport {
  send(raw: string): void | Promise<void>;
  onMessage(cb: (raw: string) => void): Unsubscriber;
}

interface ServerTransport {
  getConnectionIds(): string[];
  send(to: string, raw: string): void | Promise<void>;
  onMessage(cb: (from: string, raw: string) => void): Unsubscriber;
}
```

That's it. Two methods in, one method out. Implement those and the rest of the stack doesn't care whether you're using `ws`, `net`, or an in-memory mock.

### 2. JSONRPCClient: Ask & Listen

```ts
const transport = new WebSocketTransport('wss://collab.example');
const rpc = new JSONRPCClient(transport);

const result = await rpc.request('getDoc', { docId: 'sales-proposal' });

rpc.on('changesCommitted', params => {
  console.log('Someone edited', params.docId);
});
```

• `request` returns a Promise tied to the response.
• `notify` (not shown) is fire-and-forget – no `id`, no result.
• `on()` lets you react to server-pushed notifications.

### 3. JSONRPCServer: Route & Respond

```ts
const server = new JSONRPCServer(myWsAdaptor);

server.registerMethod('subscribe', async (connId, { ids }) => {
  return patches.subscribe(connId, ids);
});

server.notify(['abc', 'xyz'], 'changesCommitted', { docId, changes });
```

Implement your business logic once, run it over any transport.

## Method Cheat-Sheet 📚

| Category     | Method              | Params                                   | Notes                                                          |
| ------------ | ------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Subscription | `subscribe`         | `{ ids }`                                | Returns list of docs actually subscribed (auth may filter)     |
|              | `unsubscribe`       | `{ ids }`                                |                                                                |
| Docs         | `getDoc`            | `{ docId, atRev? }`                      |                                                                |
|              | `getChangesSince`   | `{ docId, rev }`                         |                                                                |
|              | `commitChanges`     | `{ docId, changes, options? }`           | Returns _all_ changes the server now knows about after merging. Use `options.forceCommit: true` for migrations. |
|              | `deleteDoc`         | `{ docId }`                              |                                                                |
| Versions\*   | `createVersion`     | `{ docId, name }`                        | Requires `PatchesHistoryManager` configured                    |
|              | `listVersions`      | `{ docId, options? }`                    |                                                                |
|              | `updateVersion`     | `{ docId, versionId, name }`             |                                                                |
|              | `getVersionState`   | `{ docId, versionId }`                   |                                                                |
|              | `getVersionChanges` | `{ docId, versionId }`                   |                                                                |
| Branches\*   | `listBranches`      | `{ docId }`                              | Requires `PatchesBranchManager` configured                     |
|              | `createBranch`      | `{ docId, rev, branchName?, metadata? }` |                                                                |
|              | `closeBranch`       | `{ branchId, status? }`                  |                                                                |
|              | `mergeBranch`       | `{ branchId }`                           |                                                                |

📝 _Version & branch calls are automatically wired when you pass the respective manager objects into `WebSocketServer`._

## Notifications

| Method             | When It Fires                                       | Payload                  |
| ------------------ | --------------------------------------------------- | ------------------------ |
| `changesCommitted` | After the server accepts a client's `commitChanges` | `{ docId, changes }`     |
| `signal`†          | WebRTC signalling helper                            | `{ fromClientId, data }` |
| _your-own_         | Anything you `server.notify()`                      | Whatever you decide      |

† Optional – only relevant if you build peer-to-peer awareness.

## Tips & Tricks 🛠️

1. **Batch wisely** – JSON-RPC doesn't force you one-request-per-patch. Collapse bursts for better throughput.
2. **Handle errors** – `.request()` rejects if the server replies with an `error` object. Inspect `code`/`message` and act accordingly.
3. **Keep IDs short** – Numbers are fine. They restart at 1 when the connection restarts.

## Wrap-up 🎁

JSON-RPC keeps Patches' critical path _boringly predictable_. You string-ify. We deliver. Your users see their teammate's cursor move before they can say "Did you save?"

That's the kind of boring we like.

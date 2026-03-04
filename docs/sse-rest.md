# SSE + REST Transport

WebSockets are great. Until they're not. Your load balancer strips the upgrade header. Your CDN doesn't support persistent connections. Your corporate proxy was configured by someone who thinks 2005 was a great year for security policies.

The SSE + REST transport gives you the same real-time collaboration over plain HTTP:

- **Server-Sent Events** for receiving other clients' changes
- **fetch** for sending yours

Same sync. Different pipes.

## When to Use This

Use SSE + REST when:

- Your infrastructure doesn't support WebSockets (or makes them painful)
- You want standard HTTP requests with proper status codes and headers
- You're behind proxies or CDNs that handle HTTP beautifully but choke on upgrades
- You prefer REST semantics over JSON-RPC

Use WebSocket when:

- You need the lowest possible latency (single persistent connection for both directions)
- Your infrastructure handles WebSockets well
- You want WebRTC awareness/presence (which requires WebSocket for signaling)

## Client Setup

### PatchesREST

`PatchesREST` is the client-side connection — a drop-in replacement for `PatchesWebSocket` when paired with `PatchesSync`.

```typescript
import { Patches, IndexedDBStore } from '@dabble/patches';
import { PatchesREST, PatchesSync } from '@dabble/patches/net';

const patches = new Patches({ store: new IndexedDBStore('my-app') });

const rest = new PatchesREST('https://api.example.com', {
  headers: { Authorization: `Bearer ${token}` },
});

const sync = new PatchesSync(patches, rest);
await sync.connect();

// Now use documents exactly as you would with WebSocket
const doc = await patches.getDoc('my-doc');
doc.change(draft => {
  draft.title = 'Updated Title';
});
// Changes sync automatically
```

### Options

```typescript
interface PatchesRESTOptions {
  // Explicit client ID. If not provided, restored from sessionStorage or generated.
  clientId?: string;

  // Static headers for every request (e.g. Authorization)
  headers?: Record<string, string>;

  // Dynamic headers called before every request (useful for token refresh)
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
}
```

### Client ID Persistence

By default, `PatchesREST` persists the client ID in `sessionStorage`. This means:

- **Page refresh** → same client ID → seamless buffer replay, no full re-sync
- **New tab** → new client ID (each tab is a separate client)
- **Tab close** → sessionStorage cleared
- **Web Worker** → no sessionStorage, falls back to random UUID per construction

To control this yourself, pass `clientId` in the options:

```typescript
const clientId = localStorage.getItem('my-client-id') ?? crypto.randomUUID();
localStorage.setItem('my-client-id', clientId);
const rest = new PatchesREST(url, { clientId });
```

### Backward Compatibility with PatchesSync

`PatchesSync` still accepts a URL string for WebSocket:

```typescript
// WebSocket (unchanged)
const sync = new PatchesSync(patches, 'wss://server.example.com');

// SSE + REST (new)
const rest = new PatchesREST('https://server.example.com');
const sync = new PatchesSync(patches, rest);
```

Both implement the `PatchesConnection` interface, so everything downstream (`PatchesSync`, your application code) works identically regardless of transport.

## REST API

All document operations use standard HTTP methods. Document IDs can contain slashes (they're hierarchical). Sub-resources use `_`-prefixed path segments to avoid collisions.

### SSE & Subscriptions

| Method | Path                       | Description                               |
| ------ | -------------------------- | ----------------------------------------- |
| GET    | `/events/:clientId`        | Open SSE stream                           |
| POST   | `/subscriptions/:clientId` | Subscribe to docs `{ docIds: [...] }`     |
| DELETE | `/subscriptions/:clientId` | Unsubscribe from docs `{ docIds: [...] }` |

### Documents

| Method | Path                             | Description                            |
| ------ | -------------------------------- | -------------------------------------- |
| GET    | `/docs/:docId+`                  | Get document state (optional `?rev=N`) |
| DELETE | `/docs/:docId+`                  | Delete document                        |
| GET    | `/docs/:docId+/_changes?since=N` | Get changes since revision             |
| POST   | `/docs/:docId+/_changes`         | Commit changes                         |

### Versions

| Method | Path                                    | Description             |
| ------ | --------------------------------------- | ----------------------- |
| GET    | `/docs/:docId+/_versions`               | List versions           |
| POST   | `/docs/:docId+/_versions`               | Create version          |
| GET    | `/docs/:docId+/_versions/:vid`          | Get version state       |
| GET    | `/docs/:docId+/_versions/:vid/_changes` | Get version changes     |
| PUT    | `/docs/:docId+/_versions/:vid`          | Update version metadata |

### Branches

| Method | Path                      | Description                              |
| ------ | ------------------------- | ---------------------------------------- |
| GET    | `/docs/:docId+/_branches` | List branches                            |
| POST   | `/docs/:docId+/_branches` | Create branch                            |
| DELETE | `/docs/:branchId+`        | Close branch (branchId is the full path) |
| POST   | `/docs/:branchId+/_merge` | Merge branch (branchId is the full path) |

## Server Setup

### SSEServer

`SSEServer` manages SSE connections, subscriptions, per-client event buffering, and heartbeats. It's framework-agnostic — you wire it into your HTTP routes.

```typescript
import { SSEServer } from '@dabble/patches/net';
import { OTServer } from '@dabble/patches/server';

const otServer = new OTServer(store);
const sse = new SSEServer({
  heartbeatIntervalMs: 30_000, // 30 seconds
  bufferTTLMs: 300_000, // 5 minutes
  auth: myAuthProvider,
});

// Wire up notifications when changes are committed
otServer.onChangesCommitted((docId, changes, options, originClientId) => {
  sse.notify(docId, 'changesCommitted', { docId, changes, options }, originClientId);
});

otServer.onDocDeleted((docId, originClientId) => {
  sse.notify(docId, 'docDeleted', { docId }, originClientId);
});
```

### Example Routes (Hono)

```typescript
import { Hono } from 'hono';

const app = new Hono();

// SSE stream
app.get('/events/:clientId', c => {
  const stream = sse.connect(c.req.param('clientId'), c.req.header('Last-Event-ID') ?? undefined);
  // IMPORTANT: detect disconnect and tell SSEServer
  c.req.raw.signal.addEventListener('abort', () => {
    sse.disconnect(c.req.param('clientId'));
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// Subscriptions
app.post('/subscriptions/:clientId', async c => {
  const { docIds } = await c.req.json();
  const ctx = { clientId: c.req.param('clientId'), ...c.get('auth') };
  const subscribed = await sse.subscribe(c.req.param('clientId'), docIds, ctx);
  return c.json({ docIds: subscribed });
});

app.delete('/subscriptions/:clientId', async c => {
  const { docIds } = await c.req.json();
  sse.unsubscribe(c.req.param('clientId'), docIds);
  return c.body(null, 204);
});

// Documents
app.get('/docs/:docId{.+}', async c => {
  const result = await otServer.getDoc(c.req.param('docId'));
  // getDoc returns a ReadableStream — read it and return as JSON
  return new Response(result, { headers: { 'Content-Type': 'application/json' } });
});

app.post('/docs/:docId{.+}/_changes', async c => {
  const { changes, options } = await c.req.json();
  const result = await otServer.commitChanges(c.req.param('docId'), changes, options);
  return c.json(result);
});
```

## Reconnection and Recovery

This is where SSE + REST actually shines compared to WebSocket.

### How It Works

1. Each SSE event has a monotonically increasing `id` per client
2. `EventSource` remembers the last `id` it received
3. On reconnect, the browser automatically sends `Last-Event-ID` header
4. The server replays buffered events from that point

### The Three Tiers

| Scenario            | Duration | What happens                                                             |
| ------------------- | -------- | ------------------------------------------------------------------------ |
| Network blip        | Seconds  | Buffer replay — seamless, zero round-trips                               |
| Extended disconnect | Minutes  | Buffer replay if within TTL, else resync                                 |
| Server restart      | Any      | Buffer is gone → `resync` event → full re-sync (same as WebSocket today) |

Most real-world disconnects are tier 1. Phone loses signal for three seconds, laptop closes for a minute, tab gets backgrounded. Buffer replay handles all of these without re-fetching anything.

### Heartbeats

SSE connections can die silently. The server sends a heartbeat comment every 30 seconds:

```
: heartbeat
```

SSE comments are invisible to `EventSource` but keep the connection alive through proxies and let the server detect dead connections when the write fails.

## Authentication

`EventSource` doesn't support custom headers. Authentication works through two mechanisms:

1. **Client ID in the URL** — the SSE stream at `/events/:clientId` is tied to the client
2. **Auth on REST calls** — subscription and document operations use `fetch` with full header support

The server validates auth when the client subscribes. The SSE stream is just a delivery pipe for documents the client has been authorized to access.

For token refresh, use `getHeaders`:

```typescript
const rest = new PatchesREST(url, {
  getHeaders: async () => ({
    Authorization: `Bearer ${await getAccessToken()}`,
  }),
});
```

## Related Documentation

- [PatchesSync](PatchesSync.md) — The sync coordinator (works with both transports)
- [net.md](net.md) — Network layer overview
- [websocket.md](websocket.md) — WebSocket transport
- [OTServer](OTServer.md) — Server-side OT implementation
- [LWWServer](LWWServer.md) — Server-side LWW implementation

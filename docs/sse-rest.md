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

Awareness/presence works on either transport — server-relayed (`RelayTransport`) or WebRTC — with signaling multiplexed over the existing SSE stream via `PatchesRESTSignalingTransport` (see [awareness.md](awareness.md)).

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

| Method | Path                       | Description                                                                   |
| ------ | -------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/events/:clientId`        | Open SSE stream                                                               |
| POST   | `/subscriptions/:clientId` | Subscribe to docs `{ docIds: [...] }`                                         |
| DELETE | `/subscriptions/:clientId` | Unsubscribe from docs `{ docIds: [...] }`                                     |
| POST   | `/signal/:clientId`        | WebRTC signaling frame (raw JSON-RPC body). See [awareness.md](awareness.md). |

The subscribe response is `{ docIds: [...], denied?: [...] }`:

- `docIds` — the ids actually registered on the instance holding the client's event stream.
- `denied` — ids **authoritatively refused by access control** (a definitive authorization "no").
- An id whose access check errored transiently (a thrown/rejected check, an unreachable registry)
  belongs in **neither** array — absence means "unknown, safe to retry".

`PatchesREST` gates completeness on set membership, never on counts: the response is complete when
every requested id appears in `docIds` or `denied`. Unaccounted ids are retried — only those ids,
with backoff, each POST re-rolling the load balancer. An older server that never sends `denied`
simply leaves non-registered ids unaccounted (they retry naturally), and `denied: []` accounts for
nothing — it does not disable retries. Servers may also answer with a status error carrying
`data.code: 'UNKNOWN_CLIENT'` when no instance holds an event stream for the clientId;
`PatchesREST` responds by rebuilding its stream. Adopting `denied` requires the unknown-client
check — see [Multi-instance deployments](#multi-instance-deployments) for the contract.

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

### Multi-instance deployments

`SSEServer` state (streams, subscriptions, buffers) is **instance-local**. When the server runs as
multiple load-balanced instances without session affinity, a `POST /subscriptions/:clientId` will
usually land on a _different_ instance than the one holding that client's `GET /events/:clientId`
stream — and `subscribe()` on an instance that doesn't know the client registers nothing and
returns `[]`. Nothing errors, so live updates silently never arrive.

Route subscribes to the stream-owning instance yourself (e.g. record which instance handled
`/events/:clientId` in shared state, and forward misdirected subscribes over your message bus).
Three APIs support this:

- `hasClient(clientId)` — whether THIS instance holds state for the client (live stream or a
  disconnected client within its buffer TTL). Treat `true` as "may hold state", **not** "owns the
  live stream": a disconnected client stays claimable for up to `bufferTTLMs` (default 5 minutes),
  and without session affinity a reconnect routinely lands on a different instance — so during
  that window two instances can both truthfully answer `true` for the same client. A router that
  picks the stale claimant registers subscriptions on an instance the client will never return
  to, and events buffer there silently. Prefer the instance holding the live stream (shared state
  recording who served `/events/:clientId` last, or a live-only check à la `getConnectionIds()`)
  whenever both claim the client.
- `addSubscriptions(clientId, docIds)` — register **already-authorized** docIds without auth
  checks, for a forwarded subscribe arriving from the instance that ran authorization. Returns
  `null` (instead of `[]`) when the client is unknown, so a failed forward is detectable. This
  method is trusted: it must never be reachable with client-supplied docIds that haven't passed
  authorization — wiring it to such a route hands any client read access to arbitrary documents
  via `changesCommitted`.
- `releaseClient(clientId)` — drop THIS instance's local state for a client whose live stream was
  just claimed by another instance (broadcast a claim over your message bus when `/events`
  connects, and call this on every other instance). With a shared event store this keeps exactly
  one instance appending the client's events — a stale ghost would append every relayed event a
  second time — and cancels the ghost's buffer-TTL expiry, which would otherwise fire `dropClient`
  against a client that is live elsewhere. Never touches the event store.
- When no instance owns the stream, answer the POST with a status error carrying
  `data.code: 'UNKNOWN_CLIENT'` — `PatchesREST` responds by rebuilding its stream and
  re-subscribing, instead of waiting on a stream that no longer exists.

#### The `denied` contract

`denied` must mean "authorization refused" — never "this instance didn't know the client" and
never "the access check errored". The `denied` field and the `hasClient`/`UNKNOWN_CLIENT` check
are a package deal, not independent options: a server that adopts `denied` alone will answer a
misdirected subscribe with `{ docIds: [], denied: [everything] }`, which the client treats as
authoritative — no retry, no telemetry, and live updates silently never arrive. That re-creates
the exact failure this contract exists to fix, with the client-side mitigation disabled. Adopting
`denied` without the unknown-client gate is strictly worse than not adopting it.

The required ordering:

```typescript
app.post('/subscriptions/:clientId', async c => {
  const clientId = c.req.param('clientId');
  if (!sse.hasClient(clientId)) {
    // Forward to the stream-owning instance — or, when no instance owns it:
    return c.json({ error: 'Unknown client', data: { code: 'UNKNOWN_CLIENT' } }, 409);
  }
  const { docIds } = await c.req.json();
  const ctx = { clientId, ...c.get('auth') };
  const subscribed = await sse.subscribe(clientId, docIds, ctx);
  return c.json({ docIds: subscribed, denied: docIds.filter((id: string) => !subscribed.includes(id)) });
});
```

The subtraction on the last line is only safe because the `hasClient` gate above it ran — and only
when every non-registered id really was an authorization "no". If an access check can fail
transiently (a database blip, a registry timeout), the affected ids must be left out of BOTH
arrays so the client retries them; sweeping them into `denied` converts a transient fault into a
permanent, silent subscription loss. Note that `SSEServer.subscribe` folds errored checks into
"not registered" — subtraction over its result is only contract-safe when `canAccess` cannot fail
transiently. Otherwise derive `denied` from your own auth results, or omit the field entirely:
without `denied`, the client simply retries any shortfall, which is always safe.

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

SSE connections can die silently. The server sends a heartbeat as a named event every 30 seconds (`heartbeatIntervalMs`):

```
event: heartbeat
data:
```

It keeps the connection alive through proxies and lets the server detect dead connections when the write fails. Because it's an observable named event (not a `:` comment, which `EventSource` discards), the client can also see it: `PatchesREST` runs a liveness watchdog that forces a reconnect if no frame — event _or_ heartbeat — arrives within ~75s (`LIVENESS_TIMEOUT_MS`, which must stay >= ~2x `heartbeatIntervalMs`). This catches a half-open stream that stays `connected` without ever firing `onerror`.

> **Deploy ordering:** the heartbeat changed from a `:` comment to a named `event: heartbeat` in 0.12.1. A watchdog client only counts observable frames, so against an older server (<= 0.9.13, comment heartbeat) an idle stream gets zero observable frames and the watchdog tears it down every ~75s. Deploy the named-heartbeat server build before shipping any watchdog client.

On a fatal error or watchdog teardown, `PatchesREST` reconnects itself with exponential backoff (mirroring `WebSocketTransport`); the consumer re-syncs on the next `connected` event.

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

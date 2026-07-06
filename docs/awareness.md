# Awareness: Real-Time Presence for Collaborative Apps

## What Awareness Actually Is

You know that feature in Google Docs where you see other people's cursors moving around? That's awareness.

Awareness is the real-time "who's doing what" information that transforms collaborative editing from "taking turns on the same file" into actual collaboration. It's what makes users feel like they're in the same room, even when they're not.

With awareness, you can show:

- Who's currently viewing the document
- Where everyone's cursor is positioned
- What text someone has selected
- Typing indicators
- Any other ephemeral state your app needs

The key distinction: awareness data is _ephemeral_. It doesn't get persisted. When a user disconnects, their awareness state disappears. This is by design - nobody cares where Bob's cursor was three days ago.

## The Pieces

`WebRTCAwareness` synchronizes each peer's state object with everyone else. Despite the name, it doesn't care how the bytes move — it rides on any `AwarenessTransport`. Two ship in the box:

- **`RelayTransport`** — every message goes through your signaling server. No WebRTC, no NAT traversal, no TURN servers, no simple-peer in your bundle. Works for 100% of networks because it's just your existing server connection.
- **`WebRTCTransport`** — peers exchange data directly over WebRTC data channels. The server only brokers the handshake. Sounds great until you meet symmetric NATs: mobile carriers, hotel wifi, and corporate networks silently fail to connect unless you deploy a TURN server.

Start with `RelayTransport`. Presence payloads are tiny and throttled — relaying them through the server costs almost nothing, and you skip the entire NAT failure class. Reach for WebRTC when you have a real reason for traffic to bypass the server, and budget for TURN when you do.

Both transports speak the same signaling protocol, so the server side is identical either way: a `SignalingService`. You can switch transports later without touching the server.

## Getting Started

### Server-relayed awareness (recommended)

`RelayTransport` wraps any `SignalingTransport` — whichever wire your app already has open. Import from `@dabble/patches/net`; this path never pulls simple-peer into your bundle.

Over a WebSocket:

```typescript
import { RelayTransport, WebRTCAwareness, WebSocketTransport } from '@dabble/patches/net';

const ws = new WebSocketTransport(`wss://your.server/ws?token=${token}`);
const awareness = new WebRTCAwareness(new RelayTransport(ws));

await awareness.connect();
```

Over the SSE+REST connection (signaling multiplexes over the existing SSE stream — no second `EventSource`, no second auth token, same `clientId` for doc sync and signaling):

```typescript
import { PatchesREST, PatchesRESTSignalingTransport, RelayTransport, WebRTCAwareness } from '@dabble/patches/net';

const patches = new PatchesREST('https://your.server/api');
const signaling = new PatchesRESTSignalingTransport(patches);
const awareness = new WebRTCAwareness(new RelayTransport(signaling));

await patches.connect(); // opens the shared SSE stream
await awareness.connect();
```

#### Rooms: several peer groups on one connection

A server that hosts multiple peer groups per connection (say, one presence room per document) tags signaling frames with a `room` param. Give each `RelayTransport` its room id and it filters inbound frames to its room and stamps outbound ones — several transports then share one signaling connection:

```typescript
const docAwareness = new WebRTCAwareness(new RelayTransport(signaling, docId));
const chatAwareness = new WebRTCAwareness(new RelayTransport(signaling, chatId));
```

Omit the room id for servers that host a single peer group per connection — stock `SignalingService` behavior.

### Peer-to-peer awareness (WebRTC)

Same `WebRTCAwareness` class, different transport. Pass your ICE servers — without a TURN server, peers behind symmetric NATs will not connect:

```typescript
import { WebRTCAwareness, WebSocketTransport } from '@dabble/patches/net';
import { WebRTCTransport } from '@dabble/patches/webrtc';

const ws = new WebSocketTransport(`wss://your.server/ws?token=${token}`);
const transport = new WebRTCTransport(ws, {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.example.com', username: 'user', credential: 'secret' },
    ],
  },
});
const awareness = new WebRTCAwareness(transport);

await awareness.connect();
```

`WebRTCTransport` also accepts `trickle: true` for faster connection setup at the cost of more signaling messages.

### Setting Your Local State

```typescript
// Set your presence data - broadcasts to all connected peers
awareness.localState = {
  name: 'Alice',
  color: '#FF5733',
  avatar: 'https://example.com/alice.jpg',
  cursor: { line: 7, column: 12 },
};
```

When you set `localState`, two things happen:

1. Your peer ID gets attached automatically
2. The state broadcasts to all connected peers

### Listening for Updates

```typescript
// Subscribe to state changes from all peers
awareness.onUpdate(states => {
  // states is an array of all connected peer states
  console.log(`${states.length} people online`);

  // Each state includes the peer's ID plus whatever they set
  states.forEach(state => {
    console.log(`${state.name} is at line ${state.cursor?.line}`);
  });
});

// Get current states synchronously
const currentStates = awareness.states;
```

### Cleaning Up

```typescript
// Disconnect when done
awareness.disconnect();
```

## TypeScript Support

`WebRTCAwareness` is generic. Define your state shape for type safety:

```typescript
interface MyAwarenessState {
  id: string; // Added automatically
  name: string;
  color: string;
  cursor?: { line: number; column: number };
  selection?: { start: number; end: number };
}

const awareness = new WebRTCAwareness<MyAwarenessState>(transport);

// Now localState and states are properly typed
awareness.localState = {
  name: 'Alice',
  color: '#FF5733',
  cursor: { line: 10, column: 5 },
};
```

## Practical Considerations

### Throttle Your Updates

Cursor movements can fire hundreds of times per second. Don't flood the network.

```typescript
import { debounce } from 'lodash';

const updateAwareness = debounce(() => {
  awareness.localState = {
    ...awareness.localState,
    cursor: editor.getCursor(),
  };
}, 50); // 50ms feels responsive without overwhelming peers

editor.on('cursorActivity', updateAwareness);
```

This matters double for `RelayTransport`: a broadcast sends one relayed message per peer, so an unthrottled cursor in a ten-person room is a lot of server traffic for no reason.

### Sanitize Incoming Data

Peers can send any JSON they want. Don't blindly trust it.

```typescript
awareness.onUpdate(states => {
  const sanitized = states.map(state => ({
    ...state,
    // Clamp cursor to valid range
    cursor: state.cursor
      ? {
          line: Math.max(0, Math.min(state.cursor.line, editor.lineCount() - 1)),
          column: Math.max(0, state.cursor.column),
        }
      : undefined,
    // Strip HTML from names
    name: state.name ? sanitizeHTML(state.name) : 'Anonymous',
  }));

  renderCollaborators(sanitized);
});
```

### Smooth Cursor Movement

Add CSS transitions so remote cursors don't teleport:

```css
.remote-cursor {
  position: absolute;
  transition:
    left 0.1s ease,
    top 0.1s ease;
}
```

## Server-Side: SignalingService

Both transports need the same thing from your server: a `SignalingService`. It handles:

1. Tracking connected clients
2. Notifying new clients about existing peers
3. Relaying messages between peers (WebRTC handshakes, or the awareness states themselves with `RelayTransport`)

The server treats relayed payloads as opaque JSON either way — there is no relay-specific server code. With WebRTC the server drops out after the handshake; with `RelayTransport` it keeps relaying, which is exactly why that flavor has nothing extra to deploy.

### Implementing SignalingService

Extend the class and implement `send()`. Pick whichever wire you already have open.

#### Over a WebSocket

```typescript
import { SignalingService, type JsonRpcMessage } from '@dabble/patches/net';

class WebSocketSignalingService extends SignalingService {
  private sockets = new Map<string, WebSocket>();

  send(id: string, message: JsonRpcMessage): void {
    const ws = this.sockets.get(id);
    if (ws) ws.send(JSON.stringify(message));
  }

  async addClient(ws: WebSocket): Promise<string> {
    const id = await this.onClientConnected();
    this.sockets.set(id, ws);
    return id;
  }

  async removeClient(id: string): Promise<void> {
    this.sockets.delete(id);
    await this.onClientDisconnected(id);
  }
}
```

#### Over an SSE+REST connection (`SSESignalingService`)

`SSESignalingService` is the ready-made implementation that ships with Patches. It rides on the same `SSEServer` you use for document sync, so signaling traffic is multiplexed over the existing `EventSource`.

```typescript
import { SSEServer, SSESignalingService } from '@dabble/patches/net';

const sse = new SSEServer();
const signaling = new SSESignalingService(sse);
```

### Wiring It Up

#### WebSocket flavor

```typescript
const signaling = new WebSocketSignalingService();

websocketServer.on('connection', async ws => {
  const clientId = await signaling.addClient(ws);

  ws.on('message', async data => {
    const handled = await signaling.handleClientMessage(clientId, data.toString());
    if (!handled) {
      // Not a signaling message - handle your app's messages here
    }
  });

  ws.on('close', () => signaling.removeClient(clientId));
});
```

#### SSE+REST flavor

Three hook points in your existing routes — same `clientId` is used for both doc sync and signaling so peer addressing matches.

> **Security requirement, not optional:** never trust the URL `:clientId` as the sender. Reject any request whose authenticated identity doesn't match the URL parameter, otherwise client A can POST to `/signal/B` and forge `peer-signal` traffic on B's behalf — including spoofing `from: B` to a third party, redirecting WebRTC handshakes, and leaking IP/relay metadata via coerced TURN paths.

```typescript
// GET /events/:clientId — alongside the existing sse.connect(...) call.
app.get('/events/:clientId', (req, res) => {
  if (req.auth.clientId !== req.params.clientId) return res.status(403).end();
  const clientId = req.auth.clientId;
  const stream = sse.connect(clientId, req.headers['last-event-id']);
  // ...pipe stream to response, then on close:
  req.on('close', async () => {
    sse.disconnect(clientId);
    await signaling.onClientDisconnected(clientId);
  });
  signaling.onClientConnected(clientId);
});

// POST /signal/:clientId — raw JSON-RPC body. fromId comes from auth, never URL.
app.post('/signal/:clientId', async (req, res) => {
  if (req.auth.clientId !== req.params.clientId) return res.status(403).end();
  const body = await readBody(req); // raw string, do not parse twice
  await signaling.handleClientMessage(req.auth.clientId, body);
  res.status(204).end();
});
```

The three key methods (same shape for both flavors):

- `onClientConnected()` - Registers a client, returns their ID, sends them a welcome with peer list
- `handleClientMessage()` - Routes signaling messages between peers, returns `true` if it was a signaling message
- `onClientDisconnected()` - Removes client and notifies remaining peers

### Scoping and multi-instance servers

Two things `SignalingService` deliberately leaves to you, because they're app decisions:

- **Rooms.** The registry is flat: every registered client is a peer of every other. If your app has documents or projects, partition server-side — one `SignalingService` per room, or a room-aware service that tags frames with the `room` param `RelayTransport` understands — or everyone sees everyone.
- **Multiple server instances.** Room membership and message routing must work when two members' connections land on different instances (and, without sticky routing, when a member's _requests_ land on an instance other than the one holding its stream). Keep membership in shared storage (`getClients`/`setClients` are async and overridable for exactly this) and relay frames across instances yourself (Redis pub/sub, etc.). Don't gate per-request behavior on instance-local state.

## Full Example: Collaborative Editor with Cursors

```typescript
import { RelayTransport, WebRTCAwareness, WebSocketTransport } from '@dabble/patches/net';
import { debounce } from 'lodash';

interface EditorAwareness {
  id: string;
  name: string;
  color: string;
  cursor?: { line: number; column: number };
  selection?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

// Setup
const transport = new RelayTransport(new WebSocketTransport(signalingServerUrl));
const awareness = new WebRTCAwareness<EditorAwareness>(transport);
await awareness.connect();

// Set initial local state
awareness.localState = {
  name: currentUser.name,
  color: currentUser.color,
};

// Update on cursor/selection changes (throttled)
const updateLocalAwareness = debounce(() => {
  awareness.localState = {
    ...awareness.localState,
    cursor: editor.getCursor(),
    selection: editor.getSelection(),
  };
}, 50);

editor.on('cursorActivity', updateLocalAwareness);
editor.on('selectionChange', updateLocalAwareness);

// Render remote cursors
awareness.onUpdate(states => {
  // Clear existing remote cursors
  document.querySelectorAll('.remote-cursor').forEach(el => el.remove());

  states.forEach(state => {
    // Skip our own state (it has our ID)
    if (state.id === transport.id) return;
    if (!state.cursor) return;

    const pos = editor.positionToCoords(state.cursor);

    const cursor = document.createElement('div');
    cursor.className = 'remote-cursor';
    cursor.style.cssText = `
      left: ${pos.left}px;
      top: ${pos.top}px;
      height: ${pos.height}px;
      background-color: ${state.color};
    `;

    const label = document.createElement('div');
    label.className = 'cursor-label';
    label.textContent = state.name;
    label.style.backgroundColor = state.color;
    cursor.appendChild(label);

    document.body.appendChild(cursor);
  });
});
```

## Why Awareness Matters

Without awareness, collaborative apps feel like version control with auto-merge. Users don't know who else is editing, where they're working, or whether they're about to step on each other's toes.

With awareness, users can:

- See exactly where others are working
- Naturally avoid edit conflicts
- Coordinate without explicit communication
- Feel connected to remote collaborators

It's the difference between a shared document and a shared workspace.

## Related Documentation

- [WebSocket Transport](websocket.md) - Server-mediated communication for document sync
- [Networking Overview](net.md) - How PatchesSync coordinates synchronization
- [JSON-RPC Protocol](json-rpc.md) - The messaging protocol used by SignalingService
- [PatchesDoc](PatchesDoc.md) - Document management on the client

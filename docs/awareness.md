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

## WebRTCAwareness: Peer-to-Peer Presence

Patches provides `WebRTCAwareness` - a utility that lets clients share presence state directly with each other via WebRTC. The server only handles the initial handshake; after that, awareness data flows peer-to-peer.

Your awareness state can be any JSON object. User photos, cursor colors, emoji status indicators - whatever your app needs.

## Getting Started

### Setup

```typescript
import { WebRTCTransport, WebRTCAwareness } from '@dabble/patches/webrtc';

// Create your transport (requires a signaling server URL)
const transport = new WebRTCTransport(signalingServerUrl);

// Create awareness instance
const awareness = new WebRTCAwareness(transport);

// Connect to start syncing
await awareness.connect();
```

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

WebRTC is peer-to-peer, but peers need help finding each other initially. That's where `SignalingService` comes in.

`SignalingService` is an abstract class that handles:

1. Tracking connected clients
2. Notifying new clients about existing peers
3. Relaying WebRTC signaling messages (offers, answers, ICE candidates)

Once peers establish direct connections, the server is out of the picture for awareness data.

### Implementing SignalingService

Extend the class and implement `send()`:

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

### Wiring It Up

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

The three key methods:

- `onClientConnected()` - Registers a client, returns their ID, sends them a welcome with peer list
- `handleClientMessage()` - Routes signaling messages between peers, returns `true` if it was a signaling message
- `onClientDisconnected()` - Removes client and notifies remaining peers

## Full Example: Collaborative Editor with Cursors

```typescript
import { WebRTCTransport, WebRTCAwareness } from '@dabble/patches/webrtc';
import { debounce } from 'lodash';

interface EditorAwareness {
  id: string;
  name: string;
  color: string;
  cursor?: { line: number; column: number };
  selection?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

// Setup
const transport = new WebRTCTransport(signalingServerUrl);
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

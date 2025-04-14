# Awareness (Presence, Cursors, and More)

## What is Awareness?

"Awareness" refers to the real-time sharing of user state between collaborators—such as who is online, where their cursor is, what they are selecting, or any other ephemeral data. Awareness is essential for building collaborative UIs that feel alive and interactive.

Common use cases:

- Show who is currently viewing or editing a document
- Display user cursors, selections, or highlights
- Indicate user activity (typing, idle, etc.)

## Awareness in Patches

Patches supports awareness using the `WebRTCAwareness` utility, which allows clients to exchange awareness state directly with each other over WebRTC.

Awareness state is an arbitrary JSON object, so you can include whatever data your app needs (user info, cursor, color, etc.).

---

## Using Awareness with WebRTC (`WebRTCAwareness`)

For peer-to-peer awareness, use the `WebRTCAwareness` class.

### Setup

```typescript
import { WebRTCTransport, WebRTCAwareness } from '@dabble/patches';

const transport = new WebRTCTransport(/* ...signaling config... */);
const awareness = new WebRTCAwareness(transport);

await awareness.connect();
```

### Setting and Getting State

```typescript
// Set your local awareness state (will be broadcast to peers)
awareness.localState = { name: 'Bob', color: 'blue', cursor: { line: 2, ch: 3 } };

// Listen for updates from all peers
awareness.onUpdate(states => {
  // states: array of all current peer awareness states
  // Update your UI to show all collaborators
});

// Get current combined state
const allStates = awareness.states;
```

---

## Best Practices for Awareness UI

- **Debounce updates:** Don't send awareness state on every keystroke—batch or debounce rapid changes.
- **Show identity:** Include user name, color, or avatar in your awareness state for a friendly UI.
- **Handle disconnects:** Remove users from your UI when they disconnect (handled automatically by awareness utilities).
- **Security:** Never trust awareness state blindly—validate or sanitize as needed.
- **Custom data:** Awareness state is arbitrary JSON. You can include anything your app needs (e.g., role, emoji, etc.).

---

## Example: Collaborative Cursor UI

```typescript
// WebRTC example
awareness.onUpdate(states => {
  states.forEach(state => {
    // Render a cursor for state.id at state.cursor
  });
});
```

---

## See Also

- [WebRTC Transport](./operational-transformation.md#webrtc)
- [PatchDoc](./PatchDoc.md)
- [operational-transformation.md](./operational-transformation.md)

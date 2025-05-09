# Awareness: Making Your Collaborative App Feel ALIVE! 👥

## What the Heck is "Awareness"?

You know that magical feeling when you're using Google Docs and you see other people's cursors dancing around the page? That's _awareness_ in action!

Awareness is all the real-time "who's doing what" info that makes collaborative apps feel like actual _collaboration_ instead of just "taking turns editing the same document." It's the digital equivalent of seeing your coworkers in the same room.

With awareness, you can show:

- Who's looking at the doc right now (hello, little profile pics!)
- Where everyone's cursor is hanging out
- What text Jane is selecting
- That Bob is currently typing (those animated dots...)
- Whatever else your app needs to feel like a bustling hive of activity!

## Awareness in Patches: Where the Magic Happens

Patches gives you `WebRTCAwareness` - a super handy utility that lets clients share their status directly with each other using WebRTC. No server needed for this part!

The best part? Your awareness state can be _any JSON object_ you want. Go wild! Include user photos, fancy cursor colors, emoji mood indicators - whatever makes your app awesome.

## Getting Started with WebRTC Awareness

Ready to make your app feel alive? Let's do this!

### Setting Things Up

```typescript
import { WebRTCTransport, WebRTCAwareness } from '@dabble/patches/net';

// First, create your transport
const transport = new WebRTCTransport(/* your signaling config */);

// Then create your awareness instance
const awareness = new WebRTCAwareness(transport);

// Connect to the magic awareness network!
await awareness.connect();
```

### Sharing Your State (and Seeing Others)

```typescript
// Tell the world about yourself!
awareness.localState = {
  name: 'Alice',
  color: '#FF5733',
  avatar: 'https://example.com/alice.jpg',
  cursor: { line: 7, column: 12 },
  mood: '🔥', // Why not?
};

// Listen for updates from your collaborators
awareness.onUpdate(states => {
  // states is an array of everyone's current state
  // Time to update your UI!

  console.log(`${states.length} people are currently active!`);

  // Now you can show cursors, highlight selections, etc.
});

// Want to check who's around right now?
const currentStates = awareness.states;
console.log(`${Object.keys(currentStates).length} people online`);
```

## Pro Tips for Amazing Awareness UIs

### 1. Don't Flood the Network!

```typescript
// BAD: Updating on every keystroke
editor.on('cursorActivity', () => {
  awareness.localState = { cursor: editor.getCursor() };
});

// GOOD: Debounce those updates
import { debounce } from 'lodash';

const updateAwareness = debounce(() => {
  awareness.localState = { cursor: editor.getCursor() };
}, 50); // 50ms delay feels responsive but won't swamp the network

editor.on('cursorActivity', updateAwareness);
```

### 2. Make It Personal

Give each user a distinct identity:

```typescript
// When your user logs in:
const userColor = generateUniqueColor(username); // Your function to assign colors

awareness.localState = {
  name: username,
  color: userColor,
  avatar: userAvatarUrl,
  // ... other state
};
```

### 3. Transitions Make Everything Better

When rendering other users' cursors, add some CSS transitions for smooth movement:

```css
.remote-cursor {
  position: absolute;
  transition:
    left 0.1s ease,
    top 0.1s ease;
}
```

### 4. Be Cautious with What You Trust

Remember, clients can send any JSON they want as their awareness state. Don't blindly trust it!

```typescript
// Sanitize incoming awareness data
awareness.onUpdate(states => {
  states.forEach(state => {
    // Check that cursor positions are within bounds
    if (state.cursor) {
      state.cursor.line = Math.min(state.cursor.line, editor.lineCount() - 1);
      state.cursor.column = Math.min(state.cursor.column, editor.getLine(state.cursor.line).length);
    }
    // Sanitize any HTML in names
    if (state.name) {
      state.name = sanitizeHTML(state.name);
    }
  });

  // Now update your UI with the sanitized data
});
```

## A Full Example: Building a Collaborative Editor with Cursors

Here's a quick example using a fictional editor:

```typescript
import { WebRTCTransport, WebRTCAwareness } from '@dabble/patches/net';
import { debounce } from 'lodash';

// Set up awareness
const transport = new WebRTCTransport(signalingServerUrl);
const awareness = new WebRTCAwareness(transport);
await awareness.connect();

// Initialize editor (fictitious API)
const editor = createEditor('#editor');

// Set up a function to update your local awareness state
const updateLocalAwareness = debounce(() => {
  awareness.localState = {
    name: currentUser.name,
    color: currentUser.color,
    avatar: currentUser.avatarUrl,
    cursor: editor.getCursor(),
    selection: editor.getSelection(),
  };
}, 50);

// Call it whenever your cursor or selection changes
editor.on('cursorActivity', updateLocalAwareness);
editor.on('selectionChange', updateLocalAwareness);

// Set initial state
updateLocalAwareness();

// Render other users' cursors and selections
awareness.onUpdate(states => {
  // Clear existing cursors first
  document.querySelectorAll('.remote-cursor, .remote-selection').forEach(el => el.remove());

  // For each remote user
  Object.entries(states).forEach(([clientId, state]) => {
    // Skip our own state
    if (clientId === awareness.clientId) return;

    // Create cursor element
    if (state.cursor) {
      const pos = editor.positionToCoords(state.cursor);
      const cursorEl = document.createElement('div');
      cursorEl.className = 'remote-cursor';
      cursorEl.style.left = `${pos.left}px`;
      cursorEl.style.top = `${pos.top}px`;
      cursorEl.style.height = `${pos.height}px`;
      cursorEl.style.backgroundColor = state.color;

      // Add name label
      const labelEl = document.createElement('div');
      labelEl.className = 'cursor-label';
      labelEl.textContent = state.name;
      labelEl.style.backgroundColor = state.color;
      cursorEl.appendChild(labelEl);

      document.body.appendChild(cursorEl);
    }

    // Render selection if it exists
    if (state.selection && state.selection.start !== state.selection.end) {
      // Highlight the selected text
      // This is editor-specific - just a conceptual example
      const selectionEl = document.createElement('div');
      selectionEl.className = 'remote-selection';
      selectionEl.style.backgroundColor = `${state.color}40`; // 25% opacity
      editor.addOverlay(state.selection, selectionEl);
    }
  });
});
```

## Why Awareness Makes Your App 10x Cooler

With awareness, your collaborative app transforms from "a document multiple people can edit" to "a shared space where people work together." It's the difference between a static document and a living, breathing collaborative environment.

Users can:

- See exactly where others are working
- Avoid edit conflicts naturally
- Feel connected, even when working remotely
- Coordinate work more efficiently
- Experience that "wow factor" that makes your app memorable

So don't skip on awareness - it's the secret ingredient that turns good collaborative apps into great ones!

## Want to Learn More?

- [WebRTC Transport](./operational-transformation.md#webrtc) - How the networking part works
- [PatchesDoc](./PatchesDoc.md) - All about document management
- [operational-transformation.md](./operational-transformation.md) - The core magic that makes it all work

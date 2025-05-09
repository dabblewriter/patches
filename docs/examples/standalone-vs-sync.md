# Patches: Do You Want Sprinkles With That? 🍦

So you've got Patches, but you're wondering: "Do I need the sync stuff too?" Let's break it down! Patches can run in two delicious flavors: plain vanilla (standalone) or with sprinkles on top (networked sync)!

## Standalone Mode: Just You and Your Documents ✍️

If you just want to manage documents locally without all the network jazz, this is for you! It's simple, clean, and perfect for single-user apps:

```typescript
import { Patches } from '@dabble/patches';
import { IndexedDBStore } from '@dabble/patches/persist';

// Set up a local storage vault for your docs
const store = new IndexedDBStore('my-private-docs');

// Create your Patches instance (no sync, just local goodness)
const patches = new Patches({
  store,
  metadata: { user: 'just-little-old-me' },
});

// Now let's actually use it!
async function letsDoThis() {
  // Open a document (creating it if it doesn't exist)
  const doc = await patches.openDoc('my-secret-novel');

  // Make some brilliant changes
  doc.change(draft => {
    draft.title = 'The Next Great American Novel';
    draft.chapter1 = 'It was a dark and stormy night...';
    draft.lastEdited = new Date().toISOString();
  });

  // Your changes are already saved locally! Magic!
  console.log(doc.state.title); // "The Next Great American Novel"

  // When you're done with this document
  await patches.closeDoc('my-secret-novel');

  // Or when you're completely done with everything
  patches.close();
}
```

That's it! No servers, no network code, no sync drama - just you and your documents, living your best life. Everything gets stored in IndexedDB, so it persists across page reloads!

## With Network Sync: Team Work Makes the Dream Work! 👯‍♀️

Ready to collaborate? Let's add real-time sync so you can work with friends (or enemies, we don't judge):

```typescript
import { Patches } from '@dabble/patches';
import { PatchesSync } from '@dabble/patches/net';
import { IndexedDBStore } from '@dabble/patches/persist';

// Local storage still needed for offline support
const store = new IndexedDBStore('our-shared-docs');

// Step 1: Create your base Patches instance
const patches = new Patches({
  store,
  metadata: {
    user: 'alice@example.com',
    displayName: 'Alice',
    color: '#FF5733', // for cursors and such
  },
});

// Step 2: Add the sync layer! 🪄
const sync = new PatchesSync('wss://collaboration-server.example.com', patches, {
  // Optional auth headers
  wsOptions: {
    headers: {
      Authorization: 'Bearer your-super-secret-token',
    },
  },
  // Tweak performance if needed
  maxBatchSize: 100,
});

// Know when you're online/offline
sync.onStateChange(state => {
  if (state.connected) {
    showGreenDot();
    hideOfflineWarning();
  } else {
    showRedDot();
    if (!state.online) {
      showOfflineWarning("You're offline! Changes will sync when you reconnect.");
    } else {
      showReconnectingSpinner();
    }
  }
});

// Handle any sync oopsies
sync.onError((error, context) => {
  console.error('Uh oh, sync trouble:', error);
  showErrorToast('Something went wrong syncing ' + context.docId);
});

// Now use it for ACTUAL collaboration!
async function letsCollaborate() {
  // Connect to the mothership
  await sync.connect();

  // Tell the server which docs you care about
  await sync.trackDocs(['team-roadmap', 'meeting-notes']);

  // Open a document (same API as before!)
  const doc = await patches.openDoc('team-roadmap');

  // Make changes that everyone will see
  doc.change(draft => {
    draft.goals.push({
      id: generateId(),
      text: 'Ship v2 by December',
      assignee: 'alice@example.com',
    });
  });

  // Changes automatically sync in the background!
  // But you can force a sync if you're impatient
  await sync.syncDoc('team-roadmap');

  // Not interested in a doc anymore?
  await sync.untrackDocs(['meeting-notes']);

  // Clean up when you're done
  await patches.closeDoc('team-roadmap');
  sync.disconnect();
  patches.close();
}
```

With this setup, you get the best of both worlds:

- Changes sync automatically when online
- Work continues offline (changes saved locally)
- Everything syncs back up when you reconnect
- Everyone sees each other's edits in real-time!

## Why We Split Things Up (It's Good For You!)

You might wonder: "Why not just one class that does everything?" Good question! Here's why we built it this way:

1. **Eat What You Want**: Only use the parts you need! Making a single-user app? Skip the sync stuff and save bandwidth.

2. **Testing Heaven**: Testing a complex sync system is HARD. With separate components, you can test each part independently.

3. **Brain Organization**: It's easier to understand "this thing manages documents" and "this other thing handles network" than one mega-class that does everything.

4. **Plug-and-Play**: Want a different sync strategy? Swap it out without touching your document logic!

It's like keeping your chocolate separate from your peanut butter until you WANT a Reese's cup.

## Migrating from the Old Ways

If you're updating from a previous version that had everything bundled together:

```typescript
// How things used to be (so 2022...)
const patches = new Patches({
  url: 'wss://example.com',
  store: new IndexedDBStore('my-docs'),
});
await patches.connect();
```

Here's how to update:

```typescript
// The shiny new way (so fresh!)
const patches = new Patches({
  store: new IndexedDBStore('my-docs'),
});
const sync = new PatchesSync('wss://example.com', patches);
await sync.connect();
```

Most methods are the same, just moved to the appropriate class. Network stuff → PatchesSync. Document stuff → Patches.

## TL;DR: Which One Should I Use?

**Use Standalone Mode When:**

- Building a single-user app
- Working with sensitive data that shouldn't leave the device
- Creating an offline-only tool
- Just getting started and want to keep things simple

**Add Sync When:**

- Building a collaborative app
- Users need to access their documents across devices
- You want real-time updates between users
- You need version history or conflict resolution

Whichever path you choose, Patches has got your back! 💪

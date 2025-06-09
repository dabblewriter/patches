# PatchesHistoryClient: Your Document Time Machine! ⏰

Ever wanted to peek into the past? See how a document evolved over time? Or maybe just watch that brilliant edit you made last week? Say hello to `PatchesHistoryClient` – your personal document time machine!

## What's This All About? 🤔

`PatchesHistoryClient` is your ticket to browsing, exploring, and even scrubbing through your document's history. It's like having DVR for your documents! You can:

- 📋 Browse all versions of a document
- ⏮️ Load up any past version to see how things looked
- 🎬 Scrub through changes frame-by-frame (like video editing!)
- 🔍 Inspect exactly what changed in each version

The best part? It's totally read-only, so you can explore without fear of messing things up!

## How Does It Fit Into the Patches Family? 👪

- **PatchesHistoryManager** is the server-side history keeper
- **PatchesHistoryClient** is the client-side explorer (that's this one!)
- **PatchesDoc** is for making changes
- **PatchesHistoryClient** is for exploring history

Think of it like this: Use `PatchesDoc` when you want to write, use `PatchesHistoryClient` when you want to read the past!

## Let's Get This Party Started! 🎉

### Setting Up Your Time Machine

```typescript
import { PatchesHistoryClient } from '@dabble/patches/client';
import { PatchesWebSocket } from '@dabble/patches/net';

// First, get your transport (the connection to the server)
const ws = new PatchesWebSocket('wss://your-awesome-server.com');
await ws.connect();

// Then create your history client for a specific document
const history = new PatchesHistoryClient('proposal-final', ws);

// Now you're ready to start time traveling!
```

### Browsing Your Document's Timeline

```typescript
// Get a list of all versions (newest first)
const versions = await history.listVersions({
  limit: 10, // Just the 10 most recent
  reverse: true, // Newest first
});

console.log(`Found ${versions.length} versions!`);

// Each version has useful metadata:
versions.forEach(version => {
  console.log(`Version: ${version.name || 'Unnamed'}`);
  console.log(`  Created: ${new Date(version.startDate).toLocaleString()}`);
  console.log(`  Changes: ${version.changes.length}`);
  console.log(`  Author: ${version.metadata?.author || 'Unknown'}`);
});
```

### Loading a Specific Version

```typescript
// I want to see how the document looked last Tuesday!
const tuesdayVersionId = 'version-abc-123';
const tuesdayState = await history.getStateAtVersion(tuesdayVersionId);

// Now you can display this state in your UI
renderDocument(tuesdayState);
```

### Frame-by-Frame Scrubbing

This is where things get SUPER cool! You can scrub through changes like a video editor:

```typescript
// Start with a version
const versionId = 'version-xyz-789';

// Get all the changes in this version
const changes = await history.getChangesForVersion(versionId);
console.log(`This version has ${changes.length} individual changes!`);

// Now let's scrub through them one by one
for (let i = 0; i < changes.length; i++) {
  // This loads the parent state and applies changes up to index i
  await history.scrubTo(versionId, i);

  // Your UI will update with each step!
  console.log(`Showing change ${i + 1} of ${changes.length}`);

  // Maybe add a "next" button in your UI here
}
```

### Listening for Updates

For a reactive UI, use the built-in event signals:

```typescript
// Subscribe to version list changes
history.onVersionsChange(versions => {
  // Update your version list UI
  updateVersionListUI(versions);
});

// Subscribe to state changes (happens during scrubbing)
history.onStateChange(state => {
  // Update your document viewer
  updateDocumentUI(state);
});
```

### Cleaning Up

When you're done time traveling, clean up after yourself:

```typescript
// Clear all caches and reset state
history.clear();
```

## Cool Things You Should Know 🧠

### Smart Caching

`PatchesHistoryClient` isn't just fast - it's smart:

- It uses an LRU cache to keep recently viewed versions in memory
- Frequently accessed versions stay cached for super-fast scrubbing
- The cache automatically drops the least recently used versions if memory gets tight

### Type Safety with TypeScript

If you're using TypeScript (and you totally should!), you can get full type safety:

```typescript
interface MyDocType {
  title: string;
  content: string;
  author: {
    id: string;
    name: string;
  };
  lastModified: string;
}

// Pass your type as a generic parameter
const history = new PatchesHistoryClient<MyDocType>('my-doc', ws);

// Now 'state' will be properly typed!
history.onStateChange(state => {
  console.log(state.title); // TypeScript knows this exists!
});
```

## Real-World Example: Building a History Browser UI

Here's how you might use `PatchesHistoryClient` in a real application:

```typescript
import { PatchesHistoryClient } from '@dabble/patches/client';
import { PatchesWebSocket } from '@dabble/patches/net';

class DocumentHistoryExplorer {
  private history: PatchesHistoryClient;
  private currentVersionId: string | null = null;
  private scrubPosition: number = 0;

  constructor(docId: string, serverUrl: string) {
    const ws = new PatchesWebSocket(serverUrl);
    this.history = new PatchesHistoryClient(docId, ws);

    // Set up event listeners
    this.history.onVersionsChange(this.handleVersionsUpdate);
    this.history.onStateChange(this.handleStateUpdate);
  }

  async initialize() {
    // Connect to server
    await this.ws.connect();

    // Load version list
    await this.history.listVersions({
      limit: 20,
      reverse: true,
      orderBy: 'startDate',
    });
  }

  async selectVersion(versionId: string) {
    this.currentVersionId = versionId;
    this.scrubPosition = 0;

    // Load the full version state
    await this.history.getStateAtVersion(versionId);

    // Also load changes so we know how many we have
    const changes = await this.history.getChangesForVersion(versionId);
    this.updateScrubberUI(0, changes.length);
  }

  async scrubToPosition(position: number) {
    if (!this.currentVersionId) return;

    this.scrubPosition = position;
    await this.history.scrubTo(this.currentVersionId, position);
  }

  // Event handlers
  private handleVersionsUpdate = versions => {
    this.renderVersionList(versions);
  };

  private handleStateUpdate = state => {
    this.renderDocumentPreview(state);
  };

  // UI methods (to be implemented based on your framework)
  private renderVersionList(versions) {
    /* ... */
  }
  private renderDocumentPreview(state) {
    /* ... */
  }
  private updateScrubberUI(position, total) {
    /* ... */
  }

  // Cleanup
  dispose() {
    this.history.clear();
  }
}

// Usage
const explorer = new DocumentHistoryExplorer('important-doc', 'wss://server.example.com');
await explorer.initialize();
```

## Best Practices for Time Travelers 🚀

1. **Clean Up After Yourself**: Always call `clear()` when you're done to free up memory

2. **Use Event Signals**: Don't poll for updates - use the `onVersionsChange` and `onStateChange` signals

3. **Limit Your Results**: Use the options in `listVersions()` to paginate large histories

4. **Cache Smart**: The LRU cache defaults to 5 entries - increase this if you're doing a lot of scrubbing

5. **Error Handling**: Wrap your calls in try/catch to handle transport errors gracefully

## Want to Learn More? 📚

- [PatchesHistoryManager](./PatchesHistoryManager.md) - The server-side counterpart
- [PatchesDoc](./PatchesDoc.md) - For when you want to edit documents
- [PatchesWebSocket](./websocket.md) - Details on the transport layer

Happy time traveling! ⏰🚀

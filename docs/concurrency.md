# Concurrency Utilities

Four tools for managing concurrent async operations on documents. Critical when you're building server backends where multiple requests for the same document can arrive simultaneously.

**Table of Contents**

- [The Problem](#the-problem)
- [`blockable` and `blocking`](#blockable-and-blocking)
- [`blockableResponse`](#blockableresponse)
- [`singleInvocation`](#singleinvocation)
- [How They Work Together](#how-they-work-together)
- [Usage as Decorators](#usage-as-decorators)

## The Problem

Consider a custom `OTStoreBackend`. Two requests arrive for the same document at the same instant: one reads the state, one commits new changes. Without coordination, the read might return stale data mid-write, or the write might corrupt the state while a read is in progress.

The concurrency utilities solve this at the per-document level. Each document gets its own queue — operations on `doc-A` never block operations on `doc-B`.

## `blockable` and `blocking`

These two work as a pair. Any function wrapped with `blockable` will pause while a `blocking` operation runs on the same document. When the `blocking` operation finishes, all waiting `blockable` calls resume.

```typescript
import { blockable, blocking } from '@dabble/patches/server';

class MyOTStore implements OTStoreBackend {
  // These can run freely, but pause during any blocking operation
  @blockable
  async getDoc(docId: string) {
    return this.db.get(docId);
  }

  @blockable
  async getChangesSince(docId: string, rev: number) {
    return this.db.getChanges(docId, rev);
  }

  // This blocks all blockable operations until it completes
  @blocking
  async commitChanges(docId: string, changes: Change[]) {
    await this.db.transaction(async tx => {
      await tx.appendChanges(docId, changes);
      await tx.updateRevision(docId, changes.at(-1)!.rev);
    });
  }
}
```

The rule: reads are `blockable`, writes are `blocking`. A write blocks concurrent reads from seeing a half-written state. Reads don't block each other — they can run in parallel freely.

Both functions require the first argument to be `docId: string`. That's how the per-document queue is keyed.

You can also use them as plain wrapper functions instead of decorators:

```typescript
const getDoc = blockable(async (docId: string) => {
  return db.get(docId);
});

const commitChanges = blocking(async (docId: string, changes: Change[]) => {
  await db.transaction(...);
});
```

## `blockableResponse`

Same as `blockable`, but for functions where you want the _response_ to be blocked rather than the function invocation itself. Useful when the call must start immediately (e.g., initiating a network request or stream), but the response should wait until any active blocking operation completes.

```typescript
import { blockableResponse } from '@dabble/patches/server';

class MyStore {
  @blockableResponse
  async fetchDocStream(docId: string): Promise<ReadableStream> {
    // Fetch starts immediately, but the resolved stream is
    // only returned after any in-progress blocking operation finishes
    return this.objectStorage.getStream(docId);
  }
}
```

## `singleInvocation`

Deduplicates concurrent calls to the same function. While a call is in flight, any subsequent calls with the same arguments return the same promise instead of starting a new operation.

```typescript
import { singleInvocation } from '@dabble/patches/server';

class MyStore {
  // Without matchOnFirstArg: all calls share one promise
  loadConfig = singleInvocation(async () => {
    return this.db.getConfig();
  });

  // With matchOnFirstArg: calls are deduplicated per docId
  loadDoc = singleInvocation(true)(async (docId: string) => {
    return this.db.getDoc(docId);
  });
}
```

The `matchOnFirstArg: true` form is what you usually want on the server — two simultaneous `loadDoc('doc-A')` calls collapse into one database hit, while `loadDoc('doc-B')` runs independently.

As a decorator:

```typescript
class MyStore {
  @singleInvocation(true)
  async loadDoc(docId: string) {
    return this.db.getDoc(docId);
  }
}
```

## How They Work Together

Here's a realistic custom backend pattern:

```typescript
import { blockable, blocking, singleInvocation } from '@dabble/patches/server';
import type { OTStoreBackend } from '@dabble/patches/server';

export class PostgresOTStore implements OTStoreBackend {
  constructor(private db: Database) {}

  // Deduplicate concurrent loads, then mark as blockable
  @singleInvocation(true)
  @blockable
  async getDoc(docId: string) {
    return this.db.query('SELECT * FROM docs WHERE id = $1', [docId]);
  }

  @blockable
  async getChangesSince(docId: string, rev: number) {
    return this.db.query('SELECT * FROM changes WHERE doc_id = $1 AND rev > $2 ORDER BY rev', [docId, rev]);
  }

  @blocking
  async commitChanges(docId: string, changes: Change[]) {
    await this.db.transaction(async client => {
      for (const change of changes) {
        await client.query('INSERT INTO changes (doc_id, rev, ops) VALUES ($1, $2, $3)', [
          docId,
          change.rev,
          change.ops,
        ]);
      }
    });
  }
}
```

`getDoc` is both `singleInvocation` and `blockable`: concurrent loads collapse into one, and any in-progress commit blocks new reads until it's done.

## Usage as Decorators

TypeScript decorators require `experimentalDecorators: true` in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true
  }
}
```

All four utilities work as both decorators (on class methods) and as plain higher-order functions (wrapping standalone functions). Pick whichever fits your code style.

# Micro Sync

A minimal, portable LWW sync system with support for special field types: increment, bitmask, rich text (OT via Delta), and max.

## Dependencies

```bash
npm install @dabble/delta easy-signal crypto-id
```

## Data Model

A document is a flat map of dot-notation field paths. Every field is stored as `{ op, val, ts }` — the operation type, the value, and an LWW timestamp:

| Op  | Type      | Behavior                                        |
| --- | --------- | ----------------------------------------------- |
| `=` | set       | Last-Write-Wins by timestamp                    |
| `!` | delete    | LWW tombstone; also tombstones child paths      |
| `+` | increment | Additive — always adds to current value         |
| `~` | bitmask   | Combinable — applies on/off mask (15 bits each) |
| `#` | text      | Rich text — OT via Delta compose/transform      |
| `^` | max       | Idempotent — keeps the larger value             |

Setting or deleting a parent path tombstones every `parent.*` child field (respecting LWW timestamps), so deleted subtrees do not resurrect from child rows.

Because paths are dot-joined, field names cannot contain `.` — the updater throws if one does. The updater method names `set`, `del`, `inc`, `bit`, `max`, and `txt` are reserved: a data field with one of those names cannot be addressed through the updater.

## Client Usage

```typescript
import { MicroClient, bitmask } from '@dabble/patches/micro';

const client = new MicroClient({
  url: 'https://api.example.com',
  dbName: 'myapp', // optional: enables IndexedDB persistence
});

interface MyDoc {
  user: { name: string; age: number };
  stats: { views: number };
  flags: number;
  content: Delta;
}

const doc = await client.open<MyDoc>('doc-123');

// Reactive subscription
doc.subscribe(state => {
  console.log(state.user.name, state.stats.views);
});

// Proxy-based updates
doc.update(d => {
  d.user.name.set('Alice');
  d.stats.views.inc(); // +1
  d.stats.views.inc(10); // +10 (consolidates with the +1)
  d.flags.bit(bitmask(2, true)); // set bit 2
  d.content.txt(delta); // rich text edit
});

// Close when done (flushes unsent ops best-effort)
client.close('doc-123');
```

Edits are durable when `dbName` is set: pending ops and the in-flight change (with its change id) persist to IndexedDB on every update and flush, so a crash mid-send re-sends the same change id on reopen and the server's idempotency log deduplicates it.

## Server Usage

```typescript
import { MicroServer, MemoryDbBackend, CompactionError } from '@dabble/patches/micro';

const server = new MicroServer(new MemoryDbBackend());

// REST endpoints (wire up with your HTTP framework)
app.get('/docs/:id', async (req, res) => {
  res.json(await server.getDoc(req.params.id));
});

// Sync/catch-up: current state + text log entries since a revision
app.get('/docs/:id/changes', async (req, res) => {
  res.json(await server.getChangesSince(req.params.id, Number(req.query.since) || 0));
});

app.post('/docs/:id/changes', async (req, res) => {
  try {
    res.json(await server.commitChanges(req.params.id, req.body));
  } catch (e) {
    if (e instanceof CompactionError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

// WebSocket handler
wss.on('connection', ws => {
  const unsubs = new Map();
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type === 'sub' && !unsubs.has(msg.docId)) {
      unsubs.set(
        msg.docId,
        server.subscribe(msg.docId, (fields, rev, changeId) => {
          ws.send(JSON.stringify({ type: 'change', docId: msg.docId, fields, rev, changeId }));
        })
      );
    } else if (msg.type === 'unsub') {
      unsubs.get(msg.docId)?.();
      unsubs.delete(msg.docId);
    }
  });
  ws.on('close', () => unsubs.forEach(fn => fn()));
});

// Maintenance
await server.compactTextLog('doc-123', 'content', throughRev);
await server.pruneChanges('doc-123', Date.now() - 86400000); // 24h
```

Commits are serialized per document in-process. A single server instance is safe with any backend; multi-instance deployments must implement `DbBackend.commit` (atomic CAS on the rev) or route each document to one instance.

Compaction: a compacted text log entry records the range it composes. A commit or catch-up whose base rev falls inside a compacted range cannot be transformed — the server rejects it (`CompactionError`, map it to HTTP 409) and the client resyncs and re-sends. Only compact through revisions your clients have likely passed.

`pruneChanges` bounds the idempotency log. Prune only entries older than your longest realistic client retry window (offline clients re-send on reopen).

## DbBackend Interface

Implement this interface for your database (Postgres, SQLite, D1, etc.):

```typescript
interface DbBackend {
  getFields(docId: string): Promise<FieldMap>;
  setFields(docId: string, fields: FieldMap): Promise<void>;
  getTextLog(docId: string, key: string, sinceRev?: number): Promise<TextLogEntry[]>;
  appendTextLog(docId: string, entry: TextLogEntry): Promise<void>;
  compactTextLog(docId: string, key: string, throughRev: number, composedDelta: any): Promise<void>;
  hasChange(docId: string, changeId: string): Promise<boolean>;
  addChange(docId: string, entry: ChangeLogEntry): Promise<void>;
  pruneChanges(docId: string, beforeTs: number): Promise<void>;
  getRev(docId: string): Promise<number>;
  setRev(docId: string, rev: number): Promise<void>;
  // Optional but strongly recommended: atomic commit with rev CAS.
  // Required for multi-instance deployments.
  commit?(docId: string, write: CommitWrite): Promise<number>;
}
```

## Wire Protocol

**REST:**

- `GET /docs/:id` → `{ rev, fields }`
- `GET /docs/:id/changes?since=rev` → `{ rev, fields, textLog }` (textLog: `TextLogEntry[]` per `#` field)
- `POST /docs/:id/changes` ← `{ id, rev, fields }` → `{ rev, fields }` (409 on compaction conflict)

The commit response's `fields` are the server-resolved values (text ops come back as the transformed delta; a deduplicated retry returns the committed absolute values). Clients fold these — never their own unsent ops — into confirmed state.

**WebSocket:**

- Client → Server: `{ type: 'sub', docId }`, `{ type: 'unsub', docId }`
- Server → Client: `{ type: 'change', docId, fields, rev, changeId }`

`changeId` lets the committing client ignore the echo of its own change. Broadcasts are applied only in contiguous rev order; on a gap (or reconnect) the client resyncs via `GET /docs/:id/changes?since=rev`.

## Large Values

Values exceeding 64KB are automatically stored in the ObjectStore (S3/R2) under the deterministic key `{docId}/{key}`, with a `{ __ref }` stub kept in the DB. Refs never leave the server: every read path resolves them before merging or returning fields. Superseded blobs are overwritten in place; blobs for deleted fields are not garbage-collected automatically.

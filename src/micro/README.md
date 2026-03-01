# Micro Sync

A minimal, portable LWW sync system with support for special field types: increment, bitmask, rich text (OT via Delta), and max.

## Dependencies

```bash
npm install @dabble/delta easy-signal
```

## Data Model

Fields use dot-notation paths with optional suffix encoding for special operations:

| Suffix | Type | Behavior |
|--------|------|----------|
| _(none)_ | set/del | Last-Write-Wins by timestamp |
| `+` | increment | Additive — always adds to current value |
| `~` | bitmask | Combinable — applies on/off mask (15 bits each) |
| `#` | text | Rich text — OT via Delta compose/transform |
| `^` | max | Idempotent — keeps the larger value |

Every field is stored as `{ val: any, ts: number }`.

## Client Usage

```typescript
import { MicroClient } from './micro/client';

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
  d.stats.views.inc();          // +1
  d.stats.views.inc(10);        // +10
  d.flags.bit(bitmask(2, true)); // set bit 2
  d.content.txt(delta);         // rich text edit
});

// Close when done
client.close('doc-123');
```

## Server Usage

```typescript
import { MicroServer, MemoryDbBackend } from './micro/server';

const server = new MicroServer(new MemoryDbBackend());

// REST endpoints (wire up with your HTTP framework)
app.get('/docs/:id', async (req, res) => {
  res.json(await server.getDoc(req.params.id));
});

app.post('/docs/:id/changes', async (req, res) => {
  const result = await server.commitChanges(req.params.id, req.body);
  res.json(result);
});

// WebSocket handler
wss.on('connection', (ws) => {
  let unsubs: (() => void)[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'sub') {
      unsubs.push(server.subscribe(msg.docId, (fields, rev) => {
        ws.send(JSON.stringify({ type: 'change', docId: msg.docId, fields, rev }));
      }));
    }
  });
  ws.on('close', () => unsubs.forEach(fn => fn()));
});

// Maintenance
await server.compactTextLog('doc-123', 'content#', throughRev);
await server.pruneChanges('doc-123', Date.now() - 86400000); // 24h
```

## DbBackend Interface

Implement this interface for your database (Postgres, SQLite, D1, etc.):

```typescript
interface DbBackend {
  getFields(docId: string): Promise<FieldMap>;
  getField(docId: string, key: string): Promise<Field | null>;
  setFields(docId: string, fields: FieldMap): Promise<void>;
  getTextLog(docId: string, key: string, sinceRev?: number): Promise<TextLogEntry[]>;
  appendTextLog(docId: string, entry: TextLogEntry): Promise<void>;
  compactTextLog(docId: string, key: string, throughRev: number, composedDelta: any): Promise<void>;
  hasChange(docId: string, changeId: string): Promise<boolean>;
  addChange(docId: string, entry: ChangeLogEntry): Promise<void>;
  pruneChanges(docId: string, beforeTs: number): Promise<void>;
  getRev(docId: string): Promise<number>;
  setRev(docId: string, rev: number): Promise<void>;
}
```

## Wire Protocol

**REST:**
- `GET /docs/:id` → `{ rev, fields }`
- `GET /docs/:id/changes?since=rev` → `{ rev, fields }`
- `POST /docs/:id/changes` ← `{ id, rev, fields }` → `{ rev, fields }`

**WebSocket:**
- Client → Server: `{ type: 'sub', docId }`, `{ type: 'unsub', docId }`
- Server → Client: `{ type: 'change', docId, fields, rev }`

## Large Values

Values exceeding 64KB are automatically stored in the ObjectStore (S3/R2) with a reference kept in the DB. Implement the `ObjectStore` interface and pass it to `MicroServer`.

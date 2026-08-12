import { Delta } from '@dabble/delta';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDbBackend, MicroClient, MicroServer } from '../../src/micro/index.js';
import type { Change, FieldMap, MicroDoc } from '../../src/micro/index.js';

const URL_BASE = 'http://micro.test';

type Route = 'doc' | 'sync' | 'commit';

let db: MemoryDbBackend;
let server: MicroServer;
let sockets: FakeSocket[];
let requests: Route[];
let posts: Change[];
let failing: Set<Route>;
let dropNextCommit: boolean;
const clients: MicroClient[] = [];

/** Minimal WebSocket wired to MicroServer subscriptions; tests drive connect/close. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _subs = new Map<string, () => void>();

  constructor() {
    sockets.push(this);
    void Promise.resolve().then(() => this.connect());
  }

  connect() {
    if (this.readyState === FakeSocket.OPEN) return;
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    for (const unsub of this._subs.values()) unsub();
    this._subs.clear();
    this.onclose?.();
  }

  send(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.type === 'sub' && !this._subs.has(msg.docId)) {
      const unsub = server.subscribe(msg.docId, (fields, rev, changeId) =>
        this.onmessage?.({ data: JSON.stringify({ type: 'change', docId: msg.docId, fields, rev, changeId }) })
      );
      this._subs.set(msg.docId, unsub);
    } else if (msg.type === 'unsub') {
      this._subs.get(msg.docId)?.();
      this._subs.delete(msg.docId);
    }
  }
}

const ok = (data: any) => ({ ok: true, status: 200, json: async () => data });

/** Route the client's REST calls at the real server, with per-route faults. */
async function fakeFetch(input: string, init?: { method?: string; body?: string }) {
  const [path, query] = input.slice(URL_BASE.length).split('?');
  const [, , docId, sub] = path.split('/');
  const route: Route = init?.method === 'POST' ? 'commit' : sub ? 'sync' : 'doc';
  requests.push(route);
  if (failing.has(route)) return { ok: false, status: 500, json: async () => null };
  if (route === 'commit') {
    const change = JSON.parse(init!.body!) as Change;
    posts.push(change);
    const result = await server.commitChanges(docId, change);
    if (dropNextCommit) {
      dropNextCommit = false;
      return new Promise<never>(() => {}); // committed server-side, response never arrives
    }
    return ok(result);
  }
  if (route === 'sync') return ok(await server.getChangesSince(docId, Number(query.split('=')[1])));
  return ok(await server.getDoc(docId));
}

// A long debounce keeps every send explicit: tests drive flushes themselves.
const client = (dbName?: string) => {
  const c = new MicroClient({ url: URL_BASE, dbName, debounce: 10000 });
  clients.push(c);
  return c;
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const clientText = (doc: MicroDoc<any>) => JSON.stringify(new Delta((doc.state as any).content ?? []).ops);

const serverText = async (docId: string, key: string) =>
  JSON.stringify(new Delta((await db.getField(docId, key))!.val).ops);

const idbOpen = (name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('docs');
      req.result.createObjectStore('pending');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Seed the exact shape MicroClient persists: confirmed state plus unsent ops. */
async function seedIdb(name: string, docId: string, cached: { fields: FieldMap; rev: number }, pending: FieldMap) {
  const idb = await idbOpen(name);
  const tx = idb.transaction(['docs', 'pending'], 'readwrite');
  tx.objectStore('docs').put(cached, docId);
  tx.objectStore('pending').put({ ops: pending, sending: null, sendingId: null }, docId);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  idb.close();
}

async function readPending(name: string, docId: string) {
  const idb = await idbOpen(name);
  const req = idb.transaction('pending', 'readonly').objectStore('pending').get(docId);
  const value = await new Promise<any>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  idb.close();
  return value;
}

beforeEach(() => {
  db = new MemoryDbBackend();
  server = new MicroServer(db);
  sockets = [];
  requests = [];
  posts = [];
  failing = new Set();
  dropNextCommit = false;
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  for (const c of clients) c.destroy();
  clients.length = 0;
  vi.unstubAllGlobals();
});

describe('MicroClient', () => {
  it('recovers changes broadcast while disconnected', async () => {
    await server.commitChanges('d', {
      id: 'seed',
      rev: 0,
      fields: {
        content: { op: '#', val: new Delta().insert('hello').ops, ts: 1 },
        title: { op: '=', val: 'A', ts: 1 },
      },
    });

    const clientA = client();
    const a = await clientA.open<{ content: Delta; title: string }>('d');
    const socketA = sockets.at(-1)!;
    const clientB = client();
    const b = await clientB.open<{ content: Delta; title: string }>('d');
    await tick(); // both sockets connect, subscribe and resync

    socketA.close(); // A drops off the network

    b.update(d => {
      d.content.txt(new Delta().retain(5).insert(' world'));
      d.title.set('B');
    });
    await clientB.flush('d');

    expect(a.rev).toBe(1);
    expect(clientText(a)).toBe(JSON.stringify(new Delta().insert('hello').ops)); // missed the broadcast

    socketA.connect(); // onopen re-subscribes and resyncs
    await vi.waitFor(() => expect(a.rev).toBe(2));

    expect(clientText(a)).toBe(JSON.stringify(new Delta().insert('hello world').ops));
    expect(clientText(a)).toBe(await serverText('d', 'content'));
    expect(a.state.title).toBe('B');
  });

  it('open() keeps pending ops when the incremental fetch fails', async () => {
    await server.commitChanges('d', {
      id: 'seed',
      rev: 0,
      fields: { title: { op: '=', val: 'server', ts: 1 }, views: { op: '=', val: 10, ts: 1 } },
    });
    await server.commitChanges('d', { id: 'seed2', rev: 1, fields: { views: { op: '+', val: 5, ts: 2 } } });

    // Cached one rev behind, with unsent ops on top.
    await seedIdb(
      'micro-stale',
      'd',
      { fields: { title: { op: '=', val: 'server', ts: 1 }, views: { op: '=', val: 10, ts: 1 } }, rev: 1 },
      { title: { op: '=', val: 'local', ts: 5 }, views: { op: '+', val: 1, ts: 5 } }
    );
    failing.add('sync');

    const c = client('micro-stale');
    const doc = await c.open<{ title: string; views: number }>('d');
    expect(requests.slice(0, 2)).toEqual(['sync', 'doc']); // incremental fetch failed, full fetch took over
    await tick();

    expect(doc.rev).toBe(2);
    expect(doc.pending.title.val).toBe('local'); // ops survived the fallback
    expect(doc.pending.views.val).toBe(1);
    expect(doc.state.title).toBe('local');
    expect(doc.state.views).toBe(16); // pending inc layered on the fresher server value

    await c.flush('d');

    expect(doc.isSending).toBe(false);
    expect((await db.getField('d', 'title'))!.val).toBe('local');
    expect((await db.getField('d', 'views'))!.val).toBe(16);
    expect(doc.state.views).toBe(16);
  });

  it('crash mid-send reopens from IDB and re-sends the same change id', async () => {
    const crashed = client('micro-crash');
    const doc = await crashed.open<{ n: number }>('d');
    await tick();

    doc.update(d => d.n.inc(5));
    dropNextCommit = true;
    void crashed.flush('d'); // server commits, the client never hears back
    await vi.waitFor(async () => expect((await readPending('micro-crash', 'd')).sendingId).toBeTruthy());

    expect(posts).toHaveLength(1);
    expect(await db.getRev('d')).toBe(1);

    // The tab dies with the send unconfirmed; a new client reopens the same database.
    const reopened = client('micro-crash');
    const doc2 = await reopened.open<{ n: number }>('d');
    await tick();
    expect(doc2.isSending).toBe(true);

    await reopened.flush('d');

    expect(posts).toHaveLength(2);
    expect(posts[1].id).toBe(posts[0].id);
    expect((await db.getField('d', 'n'))!.val).toBe(5); // deduped, not applied twice
    expect(await db.getRev('d')).toBe(1);
    expect(doc2.state.n).toBe(5);
    expect(doc2.isSending).toBe(false);
  });
});

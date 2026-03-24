import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchesREST } from '../../../src/net/rest/PatchesREST';

// Mock onlineState
vi.mock('../../../src/net/websocket/onlineState', () => ({
  onlineState: {
    isOnline: true,
    isOffline: false,
    onOnlineChange: vi.fn(() => vi.fn()),
  },
}));

// --- Mock EventSource ---
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  private listeners = new Map<string, ((e: any) => void)[]>();

  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (e: any) => void) {
    const arr = this.listeners.get(type);
    if (arr) {
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.({});
  }

  simulateError() {
    this.onerror?.({});
  }

  simulateEvent(type: string, data: string) {
    const event = { data, lastEventId: '' };
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  static instances: MockEventSource[] = [];
  static reset() {
    MockEventSource.instances = [];
  }
  static get latest() {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
}

// --- Mock fetch ---
function mockFetchResponse(data: any, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

describe('PatchesREST', () => {
  let rest: PatchesREST;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.reset();
    (globalThis as any).EventSource = MockEventSource;
    globalThis.fetch = mockFetchResponse({ ok: true });
    rest = new PatchesREST('https://api.example.com', { clientId: 'test-client-123' });
  });

  afterEach(() => {
    rest.disconnect();
    (globalThis as any).EventSource = originalEventSource;
  });

  describe('constructor', () => {
    it('should use provided clientId', () => {
      expect(rest.clientId).toBe('test-client-123');
    });

    it('should generate a clientId when not provided', () => {
      const r = new PatchesREST('https://api.example.com');
      expect(r.clientId).toBeTruthy();
      expect(r.clientId.length).toBeGreaterThan(10);
    });

    it('should strip trailing slash from URL', () => {
      const r = new PatchesREST('https://api.example.com/');
      expect(r.url).toBe('https://api.example.com');
    });
  });

  describe('connection management', () => {
    it('should open EventSource on connect', async () => {
      const connectPromise = rest.connect();
      MockEventSource.latest.simulateOpen();
      await connectPromise;

      expect(MockEventSource.latest.url).toBe('https://api.example.com/events/test-client-123');
    });

    it('should resolve only after onopen fires', async () => {
      let resolved = false;
      const connectPromise = rest.connect().then(() => {
        resolved = true;
      });

      // Before open: still pending
      expect(resolved).toBe(false);

      MockEventSource.latest.simulateOpen();
      await connectPromise;
      expect(resolved).toBe(true);
    });

    it('should reject on initial connection error', async () => {
      const connectPromise = rest.connect();
      MockEventSource.latest.simulateError();

      await expect(connectPromise).rejects.toThrow('SSE connection failed');
    });

    it('should emit connected state on EventSource open', async () => {
      const states: string[] = [];
      rest.onStateChange(s => states.push(s));

      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;

      expect(states).toEqual(['connecting', 'connected']);
    });

    it('should close EventSource on disconnect', async () => {
      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;
      const es = MockEventSource.latest;

      rest.disconnect();

      expect(es.close).toHaveBeenCalled();
    });

    it('should emit disconnected state on disconnect', async () => {
      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;

      const states: string[] = [];
      rest.onStateChange(s => states.push(s));

      rest.disconnect();

      expect(states).toEqual(['disconnected']);
    });

    it('should transition through disconnected/connecting on error while connected', async () => {
      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;

      const states: string[] = [];
      rest.onStateChange(s => states.push(s));

      MockEventSource.latest.simulateError();

      expect(states).toEqual(['disconnected', 'connecting']);
    });

    it('should not create duplicate EventSource on double connect', async () => {
      const p = rest.connect();
      rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;
      expect(MockEventSource.instances.length).toBe(1);
    });

    it('should not emit resync state changes after disconnect', async () => {
      const p = rest.connect();
      const es = MockEventSource.latest;
      es.simulateOpen();
      await p;

      rest.disconnect();

      const states: string[] = [];
      rest.onStateChange(s => states.push(s));

      // Resync arrives on the now-closed EventSource (shouldn't happen in practice,
      // but guards against race conditions)
      es.simulateEvent('resync', '{}');

      expect(states).toEqual([]);
    });
  });

  describe('SSE notifications', () => {
    it('should emit onChangesCommitted from SSE event', async () => {
      const p = rest.connect();
      const es = MockEventSource.latest;
      es.simulateOpen();
      await p;

      const received: any[] = [];
      rest.onChangesCommitted((docId, changes, options) => {
        received.push({ docId, changes, options });
      });

      es.simulateEvent(
        'changesCommitted',
        JSON.stringify({
          docId: 'doc1',
          changes: [{ id: 'c1', ops: [] }],
          options: { forceCommit: true },
        })
      );

      expect(received).toEqual([
        {
          docId: 'doc1',
          changes: [{ id: 'c1', ops: [] }],
          options: { forceCommit: true },
        },
      ]);
    });

    it('should emit onDocDeleted from SSE event', async () => {
      const p = rest.connect();
      const es = MockEventSource.latest;
      es.simulateOpen();
      await p;

      const deleted: string[] = [];
      rest.onDocDeleted(docId => deleted.push(docId));

      es.simulateEvent('docDeleted', JSON.stringify({ docId: 'doc2' }));

      expect(deleted).toEqual(['doc2']);
    });

    it('should cycle state on resync event', async () => {
      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;

      const states: string[] = [];
      rest.onStateChange(s => states.push(s));

      MockEventSource.latest.simulateEvent('resync', '{}');

      expect(states).toEqual(['disconnected', 'connected']);
    });
  });

  describe('API methods', () => {
    beforeEach(async () => {
      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;
    });

    it('should POST to subscribe endpoint', async () => {
      globalThis.fetch = mockFetchResponse({ docIds: ['doc1'] });
      const result = await rest.subscribe(['doc1']);
      expect(result).toEqual(['doc1']);

      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/subscriptions/test-client-123');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({ docIds: ['doc1'] });
    });

    it('should normalize single string id for subscribe', async () => {
      globalThis.fetch = mockFetchResponse({ docIds: ['doc1'] });
      await rest.subscribe('doc1');

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(JSON.parse(init?.body as string)).toEqual({ docIds: ['doc1'] });
    });

    it('should DELETE to unsubscribe endpoint', async () => {
      globalThis.fetch = mockFetchResponse(undefined, 204);
      await rest.unsubscribe(['doc1']);

      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/subscriptions/test-client-123');
      expect(init?.method).toBe('DELETE');
    });

    it('should GET doc state', async () => {
      const docState = { state: { title: 'Hello' }, rev: 5 };
      globalThis.fetch = mockFetchResponse(docState);

      const result = await rest.getDoc('users/abc/stats/2026-01');

      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/users/abc/stats/2026-01');
      expect(result).toEqual(docState);
    });

    it('should GET changes since revision', async () => {
      globalThis.fetch = mockFetchResponse([{ id: 'c1', rev: 6 }]);
      const result = await rest.getChangesSince('doc1', 5);

      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_changes?since=5');
      expect(result).toEqual([{ id: 'c1', rev: 6 }]);
    });

    it('should POST to commit changes', async () => {
      const committed = { changes: [{ id: 'c1', rev: 6 }] };
      globalThis.fetch = mockFetchResponse(committed);

      const result = await rest.commitChanges('doc1', [{ id: 'c1', ops: [] }]);

      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_changes');
      expect(init?.method).toBe('POST');
      expect(result).toEqual(committed);
    });

    it('should DELETE doc', async () => {
      globalThis.fetch = mockFetchResponse(undefined, 204);
      await rest.deleteDoc('doc1');

      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1');
      expect(init?.method).toBe('DELETE');
    });

    it('should throw StatusError on non-OK response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ message: 'Document not found' }),
      });

      await expect(rest.getDoc('missing')).rejects.toMatchObject({
        code: 404,
        message: 'Document not found',
      });
    });
  });

  describe('headers', () => {
    it('should include static headers in requests', async () => {
      const r = new PatchesREST('https://api.example.com', {
        clientId: 'test',
        headers: { Authorization: 'Bearer token123' },
      });
      globalThis.fetch = mockFetchResponse({ state: {}, rev: 0 });

      await r.getDoc('doc1');

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer token123' });
    });

    it('should call getHeaders for dynamic headers', async () => {
      const r = new PatchesREST('https://api.example.com', {
        clientId: 'test',
        getHeaders: () => ({ Authorization: 'Bearer dynamic' }),
      });
      globalThis.fetch = mockFetchResponse({ state: {}, rev: 0 });

      await r.getDoc('doc1');

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer dynamic' });
    });
  });

  describe('URL management', () => {
    it('should update URL without reconnecting (PatchesSync handles reconnect)', async () => {
      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;

      rest.url = 'https://new-api.example.com';

      // URL is updated but no reconnect — that's PatchesSync's job
      expect(rest.url).toBe('https://new-api.example.com');
      // Still only one EventSource (no disconnect/reconnect)
      expect(MockEventSource.instances.length).toBe(1);
    });
  });

  describe('version operations', () => {
    beforeEach(async () => {
      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;
    });

    it('should POST to create version', async () => {
      globalThis.fetch = mockFetchResponse('version-123');
      await rest.createVersion('doc1', { name: 'v1' });
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_versions');
      expect(init?.method).toBe('POST');
    });

    it('should GET versions list', async () => {
      globalThis.fetch = mockFetchResponse([]);
      await rest.listVersions('doc1');
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_versions');
    });

    it('should GET version state', async () => {
      globalThis.fetch = mockFetchResponse({ state: {}, rev: 1 });
      await rest.getVersionState('doc1', 'v1');
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_versions/v1');
    });

    it('should GET version changes', async () => {
      globalThis.fetch = mockFetchResponse([]);
      await rest.getVersionChanges('doc1', 'v1');
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_versions/v1/_changes');
    });

    it('should PUT to update version', async () => {
      globalThis.fetch = mockFetchResponse(undefined, 204);
      await rest.updateVersion('doc1', 'v1', { name: 'Updated' });
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_versions/v1');
      expect(init?.method).toBe('PUT');
    });
  });

  describe('branch operations', () => {
    beforeEach(async () => {
      const p = rest.connect();
      MockEventSource.latest.simulateOpen();
      await p;
    });

    it('should GET branches list', async () => {
      globalThis.fetch = mockFetchResponse([]);
      await rest.listBranches('doc1');
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_branches');
    });

    it('should GET branches list with since param', async () => {
      globalThis.fetch = mockFetchResponse([]);
      await rest.listBranches('doc1', { since: 9999 });
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_branches?since=9999');
    });

    it('should POST to create branch', async () => {
      globalThis.fetch = mockFetchResponse('branch-id');
      await rest.createBranch('doc1', 5, { name: 'Feature' });
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_branches');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({ branchedAtRev: 5, name: 'Feature' });
    });

    it('should PUT to update branch', async () => {
      globalThis.fetch = mockFetchResponse({ ok: true });
      await rest.updateBranch('doc1', 'branch-abc', { name: 'Renamed' });
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_branches/branch-abc');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(init?.body as string)).toEqual({ name: 'Renamed' });
    });

    it('should DELETE branch', async () => {
      globalThis.fetch = mockFetchResponse(undefined, 204);
      await rest.deleteBranch('doc1', 'branch-abc');
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_branches/branch-abc');
      expect(init?.method).toBe('DELETE');
    });

    it('should POST to merge branch', async () => {
      globalThis.fetch = mockFetchResponse(undefined, 204);
      await rest.mergeBranch('doc1', 'branch-abc');
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_branches/branch-abc/_merge');
      expect(init?.method).toBe('POST');
    });

    it('should encode branchId in URL', async () => {
      globalThis.fetch = mockFetchResponse(undefined, 204);
      await rest.deleteBranch('doc1', 'branch/with/slashes');
      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toBe('https://api.example.com/docs/doc1/_branches/branch%2Fwith%2Fslashes');
    });
  });
});

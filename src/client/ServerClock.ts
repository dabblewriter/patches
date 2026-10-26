import { signal } from 'easy-signal';

/**
 * Where a {@link ServerClock} keeps its samples between loads. Synchronous because the offset is
 * read on the stamping path; a store that throws (private mode, quota) is treated as absent.
 */
export interface ServerClockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ServerClockOptions {
  /**
   * Smallest drift that is applied, in ms. Below it the offset is 0, so ordinary latency jitter
   * never reorders concurrent edits. Default 30s.
   */
  threshold?: number;
  /** How many recent samples the median is taken over. Default 5. */
  maxSamples?: number;
  /**
   * Persists samples across loads so offline edits are corrected before the first commit of the
   * session. Defaults to `globalThis.localStorage` when present; `null` disables persistence.
   * Keyed per origin, not per server: tabs on one origin overwrite each other's samples, which is
   * harmless because the offset belongs to the device.
   */
  storage?: ServerClockStorage | null;
  /** Storage key. Default `patches.serverClock`. */
  storageKey?: string;
  /** The local clock. Default `Date.now`. */
  now?: () => number;
}

/** Reported through {@link ServerClock.onDrift} whenever the applied offset changes. */
export interface ClockDriftInfo {
  /** The offset now applied to stamps, in ms (server minus local). 0 when back under the threshold. */
  offset: number;
  /** The offset applied before this change. */
  previousOffset: number;
  /** The sample that moved it: drift outside the request's own round trip, in ms. */
  sample: number;
  /** The round trip of the request the sample came from, in ms. */
  rtt: number;
}

const DEFAULT_THRESHOLD = 30_000;
const DEFAULT_MAX_SAMPLES = 5;
const DEFAULT_STORAGE_KEY = 'patches.serverClock';

/**
 * Corrects LWW timestamps for a device clock that disagrees with the server's.
 *
 * LWW resolves by highest `ts`. The server clamps a future `ts` down to its own time, but nothing
 * can raise one: a device whose clock runs behind stamps honest-looking past timestamps, and each
 * write loses to any newer stored row and snaps back. A clock that runs ahead is clamped on every
 * commit, forever, without the client ever learning.
 *
 * Each commit response already carries the server's `committedAt`, so the offset is derived from
 * data on the wire. The server's clock read happened somewhere inside the request's round trip,
 * so only the part of the difference that falls OUTSIDE `[sentAt, receivedAt]` is clock error —
 * the rest is latency. Samples are medianed, applied only past {@link ServerClockOptions.threshold},
 * and persisted so the first offline edit after a reload is already corrected.
 */
export class ServerClock {
  /**
   * Fires when the applied offset changes (crossing the threshold either way, or moving by more
   * than it). An offset restored from storage at construction is not reported — read
   * {@link offset} once at startup to report a device that is still drifted from a past session.
   */
  readonly onDrift = signal<(info: ClockDriftInfo) => void>();

  private readonly _threshold: number;
  private readonly _maxSamples: number;
  private readonly _storage: ServerClockStorage | null;
  private readonly _storageKey: string;
  private readonly _now: () => number;
  private _samples: number[];
  /** True until the first live sample of the session has been checked against restored ones. */
  private _restored: boolean;
  private _offset: number;
  private _lastIssued = 0;

  constructor(options: ServerClockOptions = {}) {
    this._threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this._maxSamples = Math.max(1, options.maxSamples ?? DEFAULT_MAX_SAMPLES);
    this._storage = options.storage === undefined ? defaultStorage() : options.storage;
    this._storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this._now = options.now ?? Date.now;
    this._samples = this._load();
    this._restored = this._samples.length > 0;
    this._offset = this._applied(median(this._samples));
  }

  /** The offset currently added to the local clock, in ms. 0 while drift is under the threshold. */
  get offset(): number {
    return this._offset;
  }

  /**
   * The corrected time to stamp an LWW op with. Never runs backwards within a session: when the
   * offset steps down, stamps hold at the last one issued until the corrected clock catches up.
   * A stamp behind one this device already issued would lose to its own earlier write — the newer
   * edit dropped against the older pending one, the very snap-back this class exists to stop.
   * Holding is safe: ties go to the incoming op, and a held stamp is AHEAD of true time, which the
   * server clamp already absorbs.
   *
   * @param after A stamp already written that this one must strictly follow — a queued op from
   *   before a reload, or from another tab with its own clock instance. The result is then at
   *   least `after + 1`, and later stamps continue from it.
   */
  now(after?: number): number {
    const raw = this._now() + this._offset;
    if (raw > this._lastIssued) this._lastIssued = raw;
    // `after`: a stamp already written that this one must strictly follow (a queued op from
    // before a reload, or from another tab with its own clock instance)
    if (after !== undefined && this._lastIssued <= after) this._lastIssued = after + 1;
    return this._lastIssued;
  }

  /**
   * Records one commit round trip. `sentAt`/`receivedAt` are raw local-clock reads around the
   * request; `serverTime` is the server's clock read during it (`committedAt`).
   */
  observe(sentAt: number, receivedAt: number, serverTime: number): void {
    if (![sentAt, receivedAt, serverTime].every(Number.isFinite) || serverTime <= 0) return;
    if (receivedAt < sentAt) return; // the local clock was stepped mid-request — no usable window

    const sample = serverTime < sentAt ? serverTime - sentAt : serverTime > receivedAt ? serverTime - receivedAt : 0;
    // Restored samples describe the clock as it was last session. If the first live measurement
    // disagrees with them by the threshold or more, the device clock was changed in between
    // (the user or NTP fixed it) — drop them rather than apply a stale offset for the next
    // several commits, which would stamp every write wrong by exactly that much.
    const stale = this._restored && Math.abs(sample - median(this._samples)) >= this._threshold;
    this._restored = false;
    this._samples = stale ? [sample] : [...this._samples, sample].slice(-this._maxSamples);
    this._save();

    const previousOffset = this._offset;
    const offset = this._applied(median(this._samples));
    if (offset === previousOffset) return;
    this._offset = offset;
    // Report only moves big enough to matter: crossing the threshold, or shifting by at least it.
    if (offset === 0 || previousOffset === 0 || Math.abs(offset - previousOffset) >= this._threshold) {
      this.onDrift.emit({ offset, previousOffset, sample, rtt: receivedAt - sentAt });
    }
  }

  private _applied(drift: number): number {
    return Math.abs(drift) >= this._threshold ? Math.round(drift) : 0;
  }

  private _load(): number[] {
    try {
      const raw = this._storage?.getItem(this._storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      const samples = Array.isArray(parsed?.samples) ? parsed.samples : [];
      return samples
        .filter((s: unknown): s is number => typeof s === 'number' && Number.isFinite(s))
        .slice(-this._maxSamples);
    } catch {
      return [];
    }
  }

  private _save(): void {
    try {
      this._storage?.setItem(this._storageKey, JSON.stringify({ samples: this._samples }));
    } catch {
      // Unpersisted samples still correct this session; the next load starts uncorrected.
    }
  }
}

/**
 * The median, taking the middle value nearer zero for an even count rather than averaging: an
 * average invents an offset no sample measured (a stored X plus one honest 0 would apply X/2), and
 * every step the offset takes is a step the stamps must ride out.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2) return sorted[mid];
  return Math.abs(sorted[mid - 1]) <= Math.abs(sorted[mid]) ? sorted[mid - 1] : sorted[mid];
}

function defaultStorage(): ServerClockStorage | null {
  try {
    const storage = (globalThis as { localStorage?: ServerClockStorage }).localStorage;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null; // accessing localStorage throws when site data is blocked
  }
}

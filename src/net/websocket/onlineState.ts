import { signal } from 'easy-signal';

class OnlineState {
  onOnlineChange = signal<(isOnline: boolean) => void>();
  protected _isOnline = typeof navigator !== 'undefined' && navigator.onLine;

  constructor() {
    if (typeof addEventListener === 'function') {
      addEventListener('online', () => this.set(true));
      addEventListener('offline', () => this.set(false));
    }
  }

  /**
   * Inject a connectivity change from a Window into a Worker hub (which never gets
   * `online`/`offline` events). Emits only on change so N tabs dedup to one.
   */
  set(isOnline: boolean): void {
    if (this._isOnline === isOnline) return;
    this._isOnline = isOnline;
    this.onOnlineChange.emit(isOnline);
  }

  get isOnline(): boolean {
    // Read navigator.onLine live: Chromium doesn't fire online/offline events in
    // Worker scopes, so the event-driven `_isOnline` cache goes stale there.
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
    return this._isOnline;
  }

  get isOffline(): boolean {
    return !this.isOnline;
  }
}

export const onlineState = new OnlineState();

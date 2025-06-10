import { signal } from '../../event-signal.js';

class OnlineState {
  onOnlineChange = signal<(isOnline: boolean) => void>();
  protected _isOnline = typeof navigator !== 'undefined' && navigator.onLine;

  constructor() {
    if (typeof addEventListener === 'function') {
      addEventListener('online', () => {
        this._isOnline = true;
        this.onOnlineChange.emit(true);
      });
      addEventListener('offline', () => {
        this._isOnline = false;
        this.onOnlineChange.emit(false);
      });
    }
  }

  get isOnline(): boolean {
    return this._isOnline;
  }

  get isOffline(): boolean {
    return !this._isOnline;
  }
}

export const onlineState = new OnlineState();

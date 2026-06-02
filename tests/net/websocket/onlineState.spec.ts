import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onlineState } from '../../../src/net/websocket/onlineState';

describe('onlineState', () => {
  describe('properties', () => {
    it('should have isOnline property', () => {
      // In test environment, navigator may not exist, so isOnline could be undefined
      const isOnline = onlineState.isOnline;
      expect(typeof isOnline === 'boolean' || isOnline === undefined).toBe(true);
    });

    it('should have isOffline property', () => {
      expect(typeof onlineState.isOffline).toBe('boolean');
    });

    it('should have isOffline as opposite of isOnline', () => {
      expect(onlineState.isOffline).toBe(!onlineState.isOnline);
    });
  });

  describe('onOnlineChange signal', () => {
    it('should have onOnlineChange signal', () => {
      expect(typeof onlineState.onOnlineChange).toBe('function');
    });

    it('should allow subscribing to changes', () => {
      const spy = vi.fn();
      const unsubscriber = onlineState.onOnlineChange(spy);

      expect(typeof unsubscriber).toBe('function');
    });

    it('should allow unsubscribing from changes', () => {
      const spy = vi.fn();
      const unsubscriber = onlineState.onOnlineChange(spy);

      expect(() => unsubscriber()).not.toThrow();
    });
  });

  describe('navigator.onLine integration', () => {
    let onLineDescriptor: PropertyDescriptor | undefined;
    let originalCache: boolean;

    beforeEach(() => {
      onLineDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
      originalCache = onlineState['_isOnline'];
    });

    afterEach(() => {
      if (onLineDescriptor) Object.defineProperty(navigator, 'onLine', onLineDescriptor);
      onlineState['_isOnline'] = originalCache;
    });

    function setOnLine(value: boolean | undefined) {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
    }

    it('reflects a live navigator.onLine reading', () => {
      setOnLine(true);
      expect(onlineState.isOnline).toBe(true);
      expect(onlineState.isOffline).toBe(false);

      setOnLine(false);
      expect(onlineState.isOnline).toBe(false);
      expect(onlineState.isOffline).toBe(true);
    });

    it('ignores a stale _isOnline cache when navigator.onLine is available (worker scenario)', () => {
      // Worker: the offline event never fired, so the cache is stale-true; the
      // live navigator.onLine read must win.
      setOnLine(false);
      onlineState['_isOnline'] = true;
      expect(onlineState.isOnline).toBe(false);
      expect(onlineState.isOffline).toBe(true);
    });

    it('falls back to the cached value when navigator.onLine is unavailable', () => {
      setOnLine(undefined);
      onlineState['_isOnline'] = true;
      expect(onlineState.isOnline).toBe(true);
      onlineState['_isOnline'] = false;
      expect(onlineState.isOnline).toBe(false);
    });

    it('should emit signal when state changes', () => {
      const spy = vi.fn();
      onlineState.onOnlineChange(spy);

      // Manually trigger the signal emission
      onlineState.onOnlineChange.emit(true);
      expect(spy).toHaveBeenCalledWith(true);

      onlineState.onOnlineChange.emit(false);
      expect(spy).toHaveBeenCalledWith(false);
    });
  });

  describe('set (forwarded connectivity transitions)', () => {
    let originalCache: boolean;

    beforeEach(() => {
      originalCache = onlineState['_isOnline'];
    });

    afterEach(() => {
      onlineState['_isOnline'] = originalCache;
    });

    it('emits onOnlineChange when the value changes', () => {
      const spy = vi.fn();
      const unsub = onlineState.onOnlineChange(spy);

      onlineState['_isOnline'] = true;
      onlineState.set(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(false);

      onlineState.set(true);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith(true);

      unsub();
    });

    it('dedups repeated values so N tabs forwarding the same transition emit once', () => {
      const spy = vi.fn();
      const unsub = onlineState.onOnlineChange(spy);

      onlineState['_isOnline'] = true;
      onlineState.set(false);
      onlineState.set(false);
      onlineState.set(false);

      expect(spy).toHaveBeenCalledTimes(1);
      unsub();
    });
  });

  describe('environment compatibility', () => {
    it('should be defined in test environment', () => {
      expect(onlineState).toBeDefined();
    });

    it('should handle boolean state values', () => {
      // Test that the state properties work with boolean values
      const isOnline = onlineState.isOnline;
      const isOffline = onlineState.isOffline;

      expect(typeof isOnline === 'boolean' || isOnline === undefined).toBe(true);
      expect(typeof isOffline === 'boolean' || isOffline === undefined).toBe(true);
    });
  });

  describe('signal functionality', () => {
    it('should support multiple subscribers', () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();
      const spy3 = vi.fn();

      onlineState.onOnlineChange(spy1);
      onlineState.onOnlineChange(spy2);
      onlineState.onOnlineChange(spy3);

      // Trigger signal
      onlineState.onOnlineChange.emit(true);

      expect(spy1).toHaveBeenCalledWith(true);
      expect(spy2).toHaveBeenCalledWith(true);
      expect(spy3).toHaveBeenCalledWith(true);
    });

    it('should handle unsubscription correctly', () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();

      const unsub1 = onlineState.onOnlineChange(spy1);
      onlineState.onOnlineChange(spy2);

      // Trigger once
      onlineState.onOnlineChange.emit(true);
      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);

      // Unsubscribe first handler
      unsub1();
      spy1.mockClear();
      spy2.mockClear();

      // Trigger again
      onlineState.onOnlineChange.emit(false);
      expect(spy1).not.toHaveBeenCalled();
      expect(spy2).toHaveBeenCalledWith(false);
    });

    it('should handle errors in subscribers gracefully', async () => {
      const errorSpy = vi.fn().mockImplementation(() => {
        throw new Error('Subscriber error');
      });
      const normalSpy = vi.fn();

      onlineState.onOnlineChange(errorSpy);
      onlineState.onOnlineChange(normalSpy);

      // The signal implementation uses Promise.all, so errors will reject the promise
      await expect(onlineState.onOnlineChange.emit(true)).rejects.toThrow('Subscriber error');
    });
  });

  describe('state consistency', () => {
    it('should maintain isOnline and isOffline as opposites', () => {
      expect(onlineState.isOffline).toBe(!onlineState.isOnline);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  describe('state manipulation', () => {
    it('should allow direct state changes for testing', () => {
      const originalState = onlineState.isOnline;

      // Directly manipulate internal state for testing
      onlineState['_isOnline'] = true;
      expect(onlineState.isOnline).toBe(true);
      expect(onlineState.isOffline).toBe(false);

      onlineState['_isOnline'] = false;
      expect(onlineState.isOnline).toBe(false);
      expect(onlineState.isOffline).toBe(true);

      // Restore original state
      onlineState['_isOnline'] = originalState;
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
      // Test various state values
      onlineState['_isOnline'] = true;
      expect(onlineState.isOnline).toBe(true);
      expect(onlineState.isOffline).toBe(false);

      onlineState['_isOnline'] = false;
      expect(onlineState.isOnline).toBe(false);
      expect(onlineState.isOffline).toBe(true);

      (onlineState as any)['_isOnline'] = undefined;
      expect(onlineState.isOnline).toBe(undefined);
      expect(onlineState.isOffline).toBe(true); // !undefined is true
    });
  });
});

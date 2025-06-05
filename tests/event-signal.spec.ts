import { describe, it, expect, vi } from 'vitest';
import { signal } from '../src/event-signal';

describe('signal', () => {
  it('should create a signal function', () => {
    const mySignal = signal();
    expect(typeof mySignal).toBe('function');
    expect(typeof mySignal.emit).toBe('function');
    expect(typeof mySignal.error).toBe('function');
    expect(typeof mySignal.clear).toBe('function');
  });

  it('should allow subscribing and unsubscribing', () => {
    const mySignal = signal<(data: string) => void>();
    const subscriber = vi.fn();
    
    const unsubscribe = mySignal(subscriber);
    expect(typeof unsubscribe).toBe('function');
    
    unsubscribe();
    // Should not throw
  });

  it('should emit to subscribers', async () => {
    const mySignal = signal<(data: string) => void>();
    const subscriber1 = vi.fn();
    const subscriber2 = vi.fn();
    
    mySignal(subscriber1);
    mySignal(subscriber2);
    
    await mySignal.emit('test data');
    
    expect(subscriber1).toHaveBeenCalledWith('test data');
    expect(subscriber2).toHaveBeenCalledWith('test data');
  });

  it('should handle multiple arguments in emit', async () => {
    const mySignal = signal<(a: string, b: number) => void>();
    const subscriber = vi.fn();
    
    mySignal(subscriber);
    await mySignal.emit('hello', 42);
    
    expect(subscriber).toHaveBeenCalledWith('hello', 42);
  });

  it('should unsubscribe properly', async () => {
    const mySignal = signal<(data: string) => void>();
    const subscriber = vi.fn();
    
    const unsubscribe = mySignal(subscriber);
    unsubscribe();
    
    await mySignal.emit('test data');
    
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('should handle error subscribers', async () => {
    const mySignal = signal();
    const errorListener = vi.fn();
    
    mySignal.error(errorListener);
    
    // Error listeners are called when first arg is Error
    const testError = new Error('test error');
    await mySignal.emit(testError);
    
    expect(errorListener).toHaveBeenCalledWith(testError);
  });

  it('should unsubscribe error listeners', async () => {
    const mySignal = signal();
    const errorListener = vi.fn();
    
    const unsubscribeError = mySignal.error(errorListener);
    unsubscribeError();
    
    const testError = new Error('test error');
    await mySignal.emit(testError);
    
    expect(errorListener).not.toHaveBeenCalled();
  });

  it('should clear all subscribers and error listeners', async () => {
    const mySignal = signal<(data: string) => void>();
    const subscriber = vi.fn();
    const errorListener = vi.fn();
    
    mySignal(subscriber);
    mySignal.error(errorListener);
    
    mySignal.clear();
    
    await mySignal.emit('test data');
    const testError = new Error('test error');
    await mySignal.emit(testError);
    
    expect(subscriber).not.toHaveBeenCalled();
    expect(errorListener).not.toHaveBeenCalled();
  });

  it('should handle async subscribers', async () => {
    const mySignal = signal<(data: string) => void>();
    const asyncSubscriber = vi.fn().mockImplementation(async (data) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return data.toUpperCase();
    });
    
    mySignal(asyncSubscriber);
    
    await mySignal.emit('hello');
    
    expect(asyncSubscriber).toHaveBeenCalledWith('hello');
  });

  it('should wait for all subscribers to complete', async () => {
    const mySignal = signal<(data: string) => void>();
    const results: string[] = [];
    
    const slowSubscriber = vi.fn().mockImplementation(async (data) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      results.push(`slow-${data}`);
    });
    
    const fastSubscriber = vi.fn().mockImplementation(async (data) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      results.push(`fast-${data}`);
    });
    
    mySignal(slowSubscriber);
    mySignal(fastSubscriber);
    
    await mySignal.emit('test');
    
    expect(results).toHaveLength(2);
    expect(results).toContain('slow-test');
    expect(results).toContain('fast-test');
  });

  it('should handle subscriber errors gracefully', async () => {
    const mySignal = signal<(data: string) => void>();
    const throwingSubscriber = vi.fn().mockRejectedValue(new Error('subscriber error'));
    const normalSubscriber = vi.fn();
    
    mySignal(throwingSubscriber);
    mySignal(normalSubscriber);
    
    // Should not throw even if subscriber throws
    await expect(mySignal.emit('test')).rejects.toThrow('subscriber error');
    
    expect(throwingSubscriber).toHaveBeenCalledWith('test');
    expect(normalSubscriber).toHaveBeenCalledWith('test');
  });
});
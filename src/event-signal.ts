export type SignalSubscriber = (...args: any[]) => any;
export type ErrorSubscriber = (error: Error) => any;
export type Unsubscriber = () => void;
type Args<T> = T extends (...args: infer A) => any ? A : never;

export type Signal<T extends SignalSubscriber = SignalSubscriber> = {
  (subscriber: T): Unsubscriber;
  error: (errorListener: ErrorSubscriber) => Unsubscriber;
  emit: (...args: Args<T>) => Promise<void>;
  clear: () => void;
};

/**
 * Creates a signal, a function that can be used to subscribe to events. The signal can be called with a subscriber
 * function to register event listeners. It has methods for emitting events, handling errors, and managing subscriptions.
 *
 * @example
 * const onLoad = signal<(data: MyData) => void>();
 *
 * // Subscribe to data
 * onLoad((data) => console.log('loaded', data));
 *
 * // Subscribe to errors
 * onLoad.error((error) => console.error('error', error));
 *
 * // Emit data to subscribers
 * await onLoad.emit('data'); // logs 'loaded data'
 *
 * // Clear all subscribers
 * onLoad.clear();
 */
export function signal<T extends SignalSubscriber = SignalSubscriber>(): Signal<T> {
  const subscribers = new Set<SignalSubscriber>();
  const errorListeners = new Set<ErrorSubscriber>();

  function signal(subscriber: T | ErrorSubscriber): Unsubscriber {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  signal.emit = async (...args: Args<T>) => {
    const listeners = args[0] instanceof Error ? errorListeners : subscribers;
    await Promise.all(Array.from(listeners).map(listener => listener(...args)));
  };
  signal.error = (errorListener: ErrorSubscriber) => {
    errorListeners.add(errorListener);
    return () => errorListeners.delete(errorListener);
  };
  signal.clear = () => {
    subscribers.clear();
    errorListeners.clear();
  };

  return signal;
}

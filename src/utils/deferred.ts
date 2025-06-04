export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  status: 'pending' | 'fulfilled' | 'rejected';
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  let _status: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = (value: T) => {
      _resolve(value);
      _status = 'fulfilled';
    };
    reject = (reason?: any) => {
      _reject(reason);
      _status = 'rejected';
    };
  });
  return {
    promise,
    resolve,
    reject,
    get status() {
      return _status;
    },
  };
}

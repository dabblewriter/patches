import type { State } from '../types.js';
import { shallowCopy } from './shallowCopy.js';

export const EMPTY = {};

export function pluck(state: State, keys: string[]) {
  let object: any = state.root;
  for (let i = 0, imax = keys.length - 1; i < imax; i++) {
    const key = keys[i];
    if (!object[key]) {
      return null;
    }
    object = object[key];
  }
  return object;
}

export function pluckWithShallowCopy(state: State, keys: string[]) {
  let object: any = state.root;
  for (let i = 0, imax = keys.length - 1; i < imax; i++) {
    const key = keys[i];
    object = object[key] = !object[key] ? getValue(state, EMPTY) : getValue(state, object[key]);
  }
  return object;
}

export function getValue(state: State, value: any) {
  if (!state.cache?.has(value)) {
    value = shallowCopy(value);
    state.cache?.add(value);
  }
  return value;
}

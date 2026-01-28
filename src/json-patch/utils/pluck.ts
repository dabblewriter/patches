import type { State } from '../types.js';
import { shallowCopy } from './shallowCopy.js';

export const EMPTY = {};
export const EMPTY_ARRAY: any[] = [];

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

export function pluckWithShallowCopy(
  state: State,
  keys: string[],
  createMissingObjects?: boolean,
  createMissingArrays?: boolean
) {
  let object: any = state.root;
  for (let i = 0, imax = keys.length - 1; i < imax; i++) {
    const key = keys[i];
    const container = createMissingArrays && (keys[i + 1] === '0' || keys[i + 1] === '-') ? EMPTY_ARRAY : EMPTY;

    // Handle array append when key is '-' and object is an array
    if (key === '-' && Array.isArray(object)) {
      if (createMissingObjects && object.length === 0) {
        const newItem = getValue(state, container);
        object.push(newItem);
        object = newItem;
      } else {
        object = getValue(state, object[object.length - 1]);
      }
    } else {
      object = object[key] =
        createMissingObjects && !object[key] ? getValue(state, container) : getValue(state, object[key]);
    }
  }
  return object;
}

export function getValue(state: State, value: any, addKey?: string, addValue?: any) {
  if (!state.cache?.has(value)) {
    value = shallowCopy(value);
    state.cache?.add(value);
  }
  if (addKey) value[addKey] = addValue;
  return value;
}

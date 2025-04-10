import type { State } from '../types.js';

export function getType(state: State, opName: string) {
  return state.types?.[opName];
}

export function getTypeLike(state: State, opName: string) {
  return state.types?.[opName]?.like;
}

import type { State } from '../types.js';
import { getOpData } from './getOpData.js';

export function get(state: State, path: string) {
   
  const [, lastKey, target] = getOpData(state, path);
  return target ? target[lastKey] : undefined;
}

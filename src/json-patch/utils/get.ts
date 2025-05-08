import type { State } from '../types.js';
import { getOpData } from './getOpData.js';

export function get(state: State, path: string) {
  // eslint-disable-next-line no-unused-vars
  const [, lastKey, target] = getOpData(state, path);
  return target ? target[lastKey] : undefined;
}

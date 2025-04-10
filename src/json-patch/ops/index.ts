import type { JSONPatchOpHandlerMap } from '../../types.js';
import { ACTION_TO_SYMBOL } from '../compactPatch.js';
import { add } from './add.js';
import { bit } from './bitmask.js';
import { copy } from './copy.js';
import { increment } from './increment.js';
import { move } from './move.js';
import { remove } from './remove.js';
import { replace } from './replace.js';
import { text } from './text.js';

export * from './bitmask.js';
export { add, bit, copy, increment, move, remove, replace };

export function getTypes(custom?: JSONPatchOpHandlerMap) {
  const types: JSONPatchOpHandlerMap = {
    add,
    remove,
    replace,
    copy,
    move,
    '@inc': increment,
    '@bit': bit,
    '@txt': text,
    ...custom,
  };
  Object.keys(types).forEach(op => {
    const symbol = ACTION_TO_SYMBOL.get(op);
    if (symbol) types[symbol] = types[op];
  });
  return types;
}

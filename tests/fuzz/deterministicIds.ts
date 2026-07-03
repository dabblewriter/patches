/**
 * Deterministic replacement for the `crypto-id` package, installed via `vi.mock` in the
 * fuzz spec. `crypto-id` draws from `crypto.getRandomValues`, which would make change ids
 * (and therefore printed action scripts / failure repros) differ run to run. Ids only need
 * to be unique — nothing orders or compares them beyond equality — so a global counter
 * rendered in the same 0-9A-Za-z alphabet is a faithful stand-in.
 *
 * `resetDeterministicIds()` is called at the start of every fuzz run so a seed reproduces
 * byte-identical ids regardless of which other tests ran before it.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let counter = 0;

function encode(value: number, length: number): string {
  let out = '';
  let v = value;
  while (v > 0) {
    out = ALPHABET[v % ALPHABET.length] + out;
    v = Math.floor(v / ALPHABET.length);
  }
  while (out.length < length) out = '0' + out;
  // If the counter ever outgrows the requested length, keep the (still unique) tail.
  return out.slice(-length);
}

export function resetDeterministicIds(): void {
  counter = 0;
}

export const cryptoIdMock = {
  /** Mirrors crypto-id's createId(length = 12): unique alphanumeric id. */
  createId(length = 12): string {
    return encode(counter++, length);
  },
  /** Mirrors crypto-id's createSortableId(): 16-char id that sorts by creation order. */
  createSortableId(): string {
    return encode(counter++, 16);
  },
};

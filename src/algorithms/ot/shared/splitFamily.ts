import type { ChangeInput, SplitFrom } from '../../../types.js';

/**
 * Separator between an entry's stable id and its piece index. Generated ids are base62, so it
 * can never appear in one; and it must stay inside the id alphabet stores accept for their
 * write-time duplicate guard (`[\w-]`), or derived piece ids would silently bypass it.
 */
const PIECE_SEPARATOR = '_';

/** The id of piece `k` (k ≥ 1) of the entry minted under `id`; piece 0 keeps `id` itself. */
export function pieceId(id: string, k: number): string {
  return `${id}${PIECE_SEPARATOR}${k}`;
}

/** Whether `changeId` is the entry `id` itself or one of its pieces. */
export function isPieceOf(changeId: string, id: string): boolean {
  return changeId === id || changeId.startsWith(`${id}${PIECE_SEPARATOR}`);
}

/** The rendering a change belongs to: its split stamp, or the change itself as a 1-piece whole. */
export function splitFamily(change: ChangeInput): SplitFrom {
  return change.splitFrom ?? { id: change.id, count: 1 };
}

/** Longest family id a server will keep a stamp for; well past any generated id. */
const MAX_SPLIT_ID_LENGTH = 64;

/** Whether a client-supplied stamp is well-formed enough to store and act on. */
export function isValidSplitFrom(value: unknown): value is SplitFrom {
  if (!value || typeof value !== 'object') return false;
  const { id, count } = value as SplitFrom;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_SPLIT_ID_LENGTH &&
    Number.isSafeInteger(count) &&
    count >= 2
  );
}

/**
 * Tracks the rendering each entry has committed under, so another rendering of the same entry is
 * recognised as redundant: same family, different piece count. The first rendering seen for a
 * family wins — it is the one whose pieces the log already holds or is about to.
 */
export class SplitRenderings {
  private readonly _counts = new Map<string, number>();

  /** Record `change`'s rendering, unless its family already has one. */
  note(change: ChangeInput): void {
    const { id, count } = splitFamily(change);
    if (!this._counts.has(id)) this._counts.set(id, count);
  }

  /** Whether `change` belongs to a different rendering of a family already noted. */
  isRedundant(change: ChangeInput): boolean {
    const { id, count } = splitFamily(change);
    const noted = this._counts.get(id);
    return noted !== undefined && noted !== count;
  }
}

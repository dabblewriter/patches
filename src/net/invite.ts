/**
 * Shapes returned by pup's invite endpoints (`GET /docs/:docId/_invites/:inviteId`)
 * and embedded in roles documents. Kept in sync with pup's `Invite` / `UserAccess`
 * surface so clients deserialize with correct field names.
 */
export type InviteRole = 'owner' | 'write' | 'edit' | 'comment' | 'view';

/** Invite addressee payload (`invite.to`). */
export interface InviteTo {
  role: InviteRole;
  private?: boolean;
  doc?: string;
  /** Optional client-side id echoed from legacy creation paths; stripped on accept server-side. */
  id?: string;
  name?: string;
  email: string;
}

/**
 * Minimal book-row shape stored on invites for dashboard-style previews.
 * Mirrors writer `NovelBookMeta` / pup-embedded JSON (extra keys are ignored).
 */
export interface InviteProjectBookMeta {
  id?: string;
  title?: string;
  subtitle?: string;
  author?: string;
  coverArt?: string;
  coverArtRatio?: unknown;
  pattern?: number;
  backgroundColor?: unknown;
}

/** Novel project meta snapshot on an invite (writer `InviteProjectMetaSnapshot`). */
export interface InviteProjectMetaSnapshot {
  title?: string;
  modifiedAt?: string;
  books: InviteProjectBookMeta[];
  isTemplate?: boolean;
  templateCount?: number;
  type?: string;
}

export interface Invite {
  from: string;
  to: InviteTo;
  createdAt: number;
  expiresAt: number;
  /** Cached project title at invite creation (writer/pup roles doc). */
  projectName?: string;
  /** @deprecated Prefer `projectMetaSnapshot.books`. */
  projectBooks?: InviteProjectBookMeta[];
  /** @deprecated Prefer `projectMetaSnapshot.modifiedAt`. */
  projectModifiedAt?: string;
  /** Full project meta snapshot for accept-modal preview. */
  projectMetaSnapshot?: InviteProjectMetaSnapshot;
}

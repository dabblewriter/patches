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

export interface Invite {
  from: string;
  to: InviteTo;
  createdAt: number;
  expiresAt: number;
}

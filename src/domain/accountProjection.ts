/**
 * The account projection every response body is built from.
 *
 * This lived as two near-identical copies — one in routes/auth.ts and one in
 * routes/profile.ts — and they had already drifted: adding `decorations` to one
 * left the other serving a user body without it, so a PATCH echoed back no
 * decorations while GET /me/profile did. Two writers for one wire shape is a
 * bug waiting to happen, so there is now exactly one.
 *
 * `includeEmail` is the only difference the callers ever needed: the private
 * `/me` and `/auth/me` bodies carry the address, the publicly cacheable
 * `/:id/profile` body must not (see toPublicSafe in routes/profile.ts).
 */

import { parseProfileDecorations } from './profileDecorations.js';

export function toIso(value: unknown): string | null {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function toPublic(u: any, options: { includeEmail?: boolean } = {}) {
  const joined = toIso(u.createdAt);
  const base = {
    id: u.externalId ?? u.id,
    externalId: u.externalId ?? u.id,
    name: u.displayName ?? null,
    username: u.username ?? null,
    avatarUrl: u.avatarUrl,
    bannerUrl: u.bannerUrl ?? null,
    bio: u.bio ?? null,
    status: u.bio ?? null,
    // Read trust-nothing, never raw: a row written by a newer client (or
    // hand-edited) that this build cannot validate degrades to null, so a card
    // renders plain instead of half-rendered. The client's own
    // normalizeNameEffect/normalizeBannerGradient apply the same rule one step
    // further out, so an unknown kind is safe at both ends.
    decorations: parseProfileDecorations(u.profileDecorations),
    role: u.role ?? 'reader',
    isAuthor: Boolean(u.isAuthor),
    isTranslator: Boolean(u.isTranslator),
    provider: 'google',
    createdAt: joined,
    memberSince: joined,
  };
  // `email` is a key that is PRESENT or ABSENT — never null — so a publicly
  // cacheable body cannot leak the address under a null either.
  return options.includeEmail === false
    ? base
    : { email: u.email, ...base };
}

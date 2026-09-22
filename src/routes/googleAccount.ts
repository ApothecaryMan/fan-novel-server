import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Db } from '../database/db.js';
import { users } from '../database/schema.js';
import type { VerifiedGoogleIdentity } from './googleIdentity.js';
import { USERNAME_RE, UsernameTakenError, suggestUsernames } from './usernames.js';

export function isUniqueConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

export function cleanMediaUrl(url?: string | null): string | undefined {
  if (typeof url !== 'string') return undefined;
  const value = url.trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value.slice(0, 2000);
  // Server-hosted uploads (POST /api/v1/upload/cover returns a relative
  // /uploads/covers/<file> URL). Accept the safe subset so avatars/banners
  // uploaded here persist across reinstalls instead of being rejected.
  if (/^\/uploads\/covers\/[\w.\-]+\.(png|jpg|jpeg|webp|gif)$/i.test(value)) return value.slice(0, 2000);
  return undefined;
}

export function cleanBio(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, 500);
  return trimmed.length === 0 ? null : trimmed;
}

type DisplayInput = { name?: string; username?: string; avatarUrl?: string; bannerUrl?: string };
export async function resolveGoogleAccount(database: Db, identity: VerifiedGoogleIdentity,
  input: DisplayInput, bootstrapAdmin: boolean, requestId: string) {
  const externalId = `google_${identity.sub}`;
  const find = async () => (await database.select().from(users)
    .where(eq(users.googleSubject, identity.sub)).limit(1))[0];
  const assertCanonical = (row: typeof users.$inferSelect) => {
    if (row.externalId !== externalId) throw new HTTPException(409, { message: 'account identity conflict' });
    return row;
  };
  let row = await find();
  if (!row) {
    if (input.username !== undefined && !USERNAME_RE.test(input.username)) {
      throw new HTTPException(400, { message: 'invalid Google login payload' });
    }
    const explicit = typeof input.username === 'string' && USERNAME_RE.test(input.username) ? input.username : null;
    if (explicit) {
      const clash = await database.select({ id: users.id }).from(users).where(eq(users.username, explicit)).limit(1);
      if (clash[0]) {
        const suggestions = await suggestUsernames(explicit, async (candidate) =>
          (await database.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1)).length > 0);
        throw new UsernameTakenError(suggestions);
      }
    }
    try {
      const displayName = (input.name || identity.email.split('@')[0]).slice(0, 100);
      const inserted = await database.insert(users).values({
        externalId, googleSubject: identity.sub, email: identity.email,
        username: explicit,
        displayName,
        avatarUrl: cleanMediaUrl(input.avatarUrl) ?? null,
        bannerUrl: cleanMediaUrl(input.bannerUrl) ?? null,
        role: bootstrapAdmin ? 'admin' : 'reader',
      }).returning();
      row = inserted[0];
      if (!row) throw new Error('account insert returned no row');
      console.info(JSON.stringify({ event: 'account.provisioned', requestId, accountId: row.id, outcome: 'created' }));
      return assertCanonical(row);
    } catch (error) {
      if (error instanceof UsernameTakenError) throw error;
      if (!isUniqueConflict(error)) throw error;
      if (explicit) {
        const holder = await database.select({ id: users.id }).from(users)
          .where(eq(users.username, explicit)).limit(1);
        if (holder[0]) {
          const committed = await find();
          if (!committed) {
            const suggestions = await suggestUsernames(explicit, async (candidate) =>
              (await database.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1)).length > 0);
            throw new UsernameTakenError(suggestions);
          }
        }
      }
      const committed = await find();
      if (!committed || committed.email !== identity.email) {
        throw new HTTPException(409, { message: 'account identity conflict' });
      }
      // Only an identical committed binding is an idempotent race winner.
      // Never heal or update any row in the conflict-recovery branch.
      return assertCanonical(committed);
    }
  }
  assertCanonical(row);
  const patch: Partial<typeof users.$inferInsert> = {};
  if (row.email !== identity.email) patch.email = identity.email;
  if (bootstrapAdmin && row.role !== 'admin') patch.role = 'admin';
  if (!cleanMediaUrl(row.avatarUrl) && cleanMediaUrl(input.avatarUrl)) patch.avatarUrl = cleanMediaUrl(input.avatarUrl);
  if (!cleanMediaUrl(row.bannerUrl) && cleanMediaUrl(input.bannerUrl)) patch.bannerUrl = cleanMediaUrl(input.bannerUrl);
  if (Object.keys(patch).length === 0) return row;
  try {
    const updated = await database.update(users).set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, row.id)).returning();
    if (!updated[0]) throw new HTTPException(401, { message: 'account not found' });
    return updated[0];
  } catch (error) {
    if (isUniqueConflict(error)) throw new HTTPException(409, { message: 'account identity conflict' });
    throw error;
  }
}

import { and, eq } from 'drizzle-orm';
import { db, dbDriver } from '../../database/db.js';
import {
  readingNovelTombstones,
  readingNovels,
  readingSessions,
  userAchievementUnlocks,
  users,
} from '../../database/schema.js';


async function resetStatements(tx: any, userId: string, resetAt: number): Promise<void> {
  await tx.update(users).set({ statsResetAt: resetAt }).where(eq(users.id, userId));
  await tx.delete(readingSessions).where(eq(readingSessions.userId, userId));
  await tx.delete(readingNovels).where(eq(readingNovels.userId, userId));
  await tx.delete(readingNovelTombstones).where(eq(readingNovelTombstones.userId, userId));
  await tx.delete(userAchievementUnlocks).where(eq(userAchievementUnlocks.userId, userId));
}

export async function resetUserReadingData(userId: string, now: number): Promise<number> {
  const resetAt = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  // Gate FIRST: the stats_reset_at write precedes every delete, so a partial
  // failure can never leave deleted data without its gate (late pushes stay
  // dropped; the next reset retries the deletes). On pg the whole sequence
  // additionally runs in one transaction; on Workers (neon-http, no
  // interactive transactions) it runs as sequential statements — a crash
  // between statements is best-effort and self-heals on the next reset.
  if (dbDriver() === 'pg') {
    await (db as any).transaction(async (tx: any) => {
      await resetStatements(tx, userId, resetAt);
    });
    return resetAt;
  }
  await resetStatements(db, userId, resetAt);
  return resetAt;
}

async function deleteNovelStatements(tx: any, userId: string, novelId: string, deletedAt: number): Promise<void> {
  await tx.insert(readingNovelTombstones)
    .values({ userId, novelId, deletedAt })
    .onConflictDoUpdate({
      target: [readingNovelTombstones.userId, readingNovelTombstones.novelId],
      set: { deletedAt },
    });
  await tx.delete(readingSessions)
    .where(and(eq(readingSessions.userId, userId), eq(readingSessions.novelId, novelId)));
  await tx.delete(readingNovels)
    .where(and(eq(readingNovels.userId, userId), eq(readingNovels.novelId, novelId)));
}

export async function deleteNovelReadingData(
  userId: string,
  novelId: string,
  now: number,
): Promise<number> {
  const deletedAt = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  // Same gate-first discipline as resetUserReadingData: the tombstone upsert
  // lands before the session deletes.
  if (dbDriver() === 'pg') {
    await (db as any).transaction(async (tx: any) => {
      await deleteNovelStatements(tx, userId, novelId, deletedAt);
    });
    return deletedAt;
  }
  await deleteNovelStatements(db, userId, novelId, deletedAt);
  return deletedAt;
}

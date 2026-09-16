import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, isDbAvailable, noteDbFailure } from '../database/db.js';
import { chapters, comments, commentModLog, commentVotes, novels, users } from '../database/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { getCaller } from '../middleware/ownership.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getEnv } from '../config/env.js';

// Native comments for app-native novels only (sourceId 'internal:published').
// Site sources (site:*) keep the extension path; see docs/COMMENTS_NATIVE_PLAN.md.

export const commentsNovelsRouter = new Hono();
export const commentsRouter = new Hono();
export const adminCommentsRouter = new Hono();

export const MAX_DEPTH = 3;
const EDIT_WINDOW_MS = 15 * 60_000;
const MAX_EDITS = 5;
const POST_COOLDOWN_S = 30;
const OWNER_COOLDOWN_S = 10;
const DAILY_CAP = 100;
const REPORTS_TO_PENDING = 3;

// ---------- pure helpers (unit-tested) ----------

export function normalizeBody(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** cyrb53 hex (sync, Workers-safe) — duplicate detection, not security. */
export function bodyHashHex(normalized: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function shouldHoldForModeration(body: string): boolean {
  const links = (body.match(/https?:\/\//g) || []).length;
  if (links >= 2) return true;
  if (body.length > 1000 && links >= 1) return true;
  if (/(.)\1{19,}/.test(body)) return true;
  return false;
}

export interface RootsCursor { t: number; i: number; s?: number }

export function encodeCursor(c: RootsCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): RootsCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.t !== 'number' || typeof parsed?.i !== 'number') return null;
    if (parsed.s !== undefined && typeof parsed.s !== 'number') return null;
    return parsed as RootsCursor;
  } catch {
    return null;
  }
}

// ---------- validation ----------

const CommentBody = z
  .string()
  .transform((s) => normalizeBody(s))
  .pipe(z.string().min(1, { message: 'نص التعليق مطلوب' }).max(2000, { message: 'التعليق طويل جداً' }));

const createCommentSchema = z
  .object({
    body: CommentBody,
    chapterNumber: z.number().int().min(1).optional(),
    parentId: z.number().int().min(1).nullable().optional(),
  })
  .strict();

const editCommentSchema = z.object({ body: CommentBody }).strict();
const voteSchema = z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).strict();
const modActionSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

const listQuerySchema = z.object({
  chapter: z.coerce.number().int().min(1).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(['new', 'top']).default('new'),
  status: z.enum(['visible', 'pending', 'hidden', 'deleted']).optional(),
});

// ---------- shared shapes ----------

type CommentRow = typeof comments.$inferSelect;

interface ApiAuthor { id: string; name: string; avatarUrl?: string }

function toApi(row: CommentRow, author: ApiAuthor, myVote: 1 | -1 | 0) {
  return {
    id: `app_${row.id}`,
    novelId: row.novelId,
    parentId: row.parentId != null ? `app_${row.parentId}` : null,
    rootId: row.rootId != null ? `app_${row.rootId}` : null,
    chapterNumber: row.chapterNumber,
    author,
    body: row.status === 'deleted' ? '[محذوف]' : row.body,
    likes: row.likesCount ?? 0,
    repliesCount: row.repliesCount ?? 0,
    myVote,
    isEdited: row.editedAt != null || (row.editCount ?? 0) > 0,
    status: row.status === 'deleted' ? 'deleted' : row.status === 'pending' ? 'pending' : 'visible',
    createdAt: (row.createdAt as Date)?.toISOString?.() ?? new Date().toISOString(),
    updatedAt: (row.updatedAt as Date)?.toISOString?.() ?? new Date().toISOString(),
  };
}

function authorOf(userId: string | null, lookup: Map<string, { name: string; avatarUrl?: string }>): ApiAuthor {
  if (!userId) return { id: 'deleted', name: 'مستخدم محذوف' };
  const hit = lookup.get(userId);
  return hit ? { id: userId, name: hit.name, avatarUrl: hit.avatarUrl } : { id: userId, name: 'مستخدم' };
}

/** Run middlewares only in closed (prod) mode; open LAN keeps legacy behavior. */
function prodGuard(...mws: Array<(c: any, next: any) => unknown>) {
  return async (c: any, next: any) => {
    if (getEnv().syncOpen) {
      await next();
      return;
    }
    const dispatch = async (idx: number): Promise<Response | void> => {
      if (idx < mws.length) {
        const res = await mws[idx](c, () => dispatch(idx + 1));
        if (res instanceof Response) {
          c.res = res;
          return res;
        }
        return;
      }
      await next();
    };
    const res = await dispatch(0);
    if (res instanceof Response) return res;
  };
}

// ---------- memory fallback (dev / no DB) ----------

interface MemComment {
  id: number; novelId: string; chapterNumber: number | null;
  userId: string | null; userName: string; avatarUrl?: string;
  parentId: number | null; rootId: number | null; depth: number;
  body: string; bodyHash: string; status: string;
  likesCount: number; repliesCount: number; reportsCount: number; editCount: number;
  createdAt: string; updatedAt: string; editedAt: string | null; deletedAt: string | null;
}

const MEM = new Map<number, MemComment>();
const MEM_VOTES = new Map<string, number>(); // `${commentId}:${userId}` -> value
let MEM_SEQ = 1;

function memList(novelId: string, chapter: number | undefined, visibleOnly: boolean): MemComment[] {
  return [...MEM.values()].filter((m) => {
    if (m.novelId !== novelId) return false;
    if (chapter !== undefined ? m.chapterNumber !== chapter : m.chapterNumber !== null) return false;
    if (visibleOnly && m.status !== 'visible') return false;
    return true;
  });
}

function memToApi(m: MemComment, myVote: 1 | -1 | 0) {
  return {
    id: `app_${m.id}`, novelId: m.novelId,
    parentId: m.parentId != null ? `app_${m.parentId}` : null,
    rootId: m.rootId != null ? `app_${m.rootId}` : null,
    chapterNumber: m.chapterNumber,
    author: { id: m.userId ?? 'anon', name: m.userName, avatarUrl: m.avatarUrl },
    body: m.status === 'deleted' ? '[محذوف]' : m.body,
    likes: m.likesCount, repliesCount: m.repliesCount, myVote,
    isEdited: m.editedAt != null || m.editCount > 0,
    status: m.status === 'deleted' ? 'deleted' : m.status === 'pending' ? 'pending' : 'visible',
    createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

// ---------- shared guards ----------

async function resolveWriter(c: any): Promise<{ userId: string; userName: string; avatarUrl?: string; isAdmin: boolean; cooldownS: number } | { error: Response }> {
  if (getEnv().syncOpen) {
    return { userId: 'local-dev', userName: 'مستخدم محلي', isAdmin: true, cooldownS: 0 };
  }
  const caller = await getCaller(c);
  if (!caller.row) return { error: c.json({ success: false, error: 'غير مصرح: مطلوب تسجيل الدخول' }, 401) };
  return {
    userId: caller.row.id,
    userName: caller.row.displayName || caller.row.username || 'مستخدم',
    avatarUrl: caller.row.avatarUrl ?? undefined,
    isAdmin: caller.isAdmin,
    cooldownS: caller.isAdmin ? OWNER_COOLDOWN_S : POST_COOLDOWN_S,
  };
}

async function checkCooldown(userId: string, cooldownS: number): Promise<number> {
  if (!cooldownS) return 0;
  if (isDbAvailable()) {
    try {
      const rows = await db
        .select({ createdAt: comments.createdAt })
        .from(comments)
        .where(eq(comments.userId, userId))
        .orderBy(desc(comments.createdAt))
        .limit(4);
      if (!rows.length) return 0;
      const last = new Date(rows[0].createdAt as unknown as string).getTime();
      const wait = Math.ceil(cooldownS - (Date.now() - last) / 1000);
      if (wait > 0) return wait;
      const dayAgo = new Date(Date.now() - 24 * 3600_000);
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(comments)
        .where(and(eq(comments.userId, userId), sql`${comments.createdAt} > ${dayAgo}`));
      if (Number(n) >= DAILY_CAP) return 3600;
      const lastBodies = await db
        .select({ bodyHash: comments.bodyHash })
        .from(comments)
        .where(eq(comments.userId, userId))
        .orderBy(desc(comments.createdAt))
        .limit(3);
      return lastBodies.length ? -lastBodies.length : 0; // negative = hashes follow, no wait
    } catch (err) {
      console.error('[comments] cooldown check failed', err);
      noteDbFailure();
    }
  }
  const mine = [...MEM.values()].filter((m) => m.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!mine.length) return 0;
  const wait = Math.ceil(cooldownS - (Date.now() - new Date(mine[0].createdAt).getTime()) / 1000);
  return wait > 0 ? wait : 0;
}

async function isDuplicate(userId: string, hash: string, novelId: string): Promise<boolean> {
  if (isDbAvailable()) {
    try {
      if (userId === 'local-dev') {
        const rows = await db
          .select({ bodyHash: comments.bodyHash })
          .from(comments)
          .where(eq(comments.novelId, novelId))
          .orderBy(desc(comments.createdAt))
          .limit(3);
        return rows.some((r) => r.bodyHash === hash);
      }
      const rows = await db
        .select({ bodyHash: comments.bodyHash })
        .from(comments)
        .where(eq(comments.userId, userId))
        .orderBy(desc(comments.createdAt))
        .limit(3);
      return rows.some((r) => r.bodyHash === hash);
    } catch {
      return false;
    }
  }
  const pool = [...MEM.values()].filter((m) => m.novelId === novelId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
  const mine = userId === 'local-dev' ? pool : pool.filter((m) => m.userId === userId);
  const check = (userId === 'local-dev' ? pool : mine).slice(0, 3);
  return check.some((m) => m.bodyHash === hash);
}

async function novelExists(novelId: string): Promise<boolean> {
  if (isDbAvailable()) {
    try {
      const rows = await db.select({ id: novels.id }).from(novels).where(eq(novels.id, novelId)).limit(1);
      if (rows[0]) return true;
    } catch (err) {
      console.error('[comments] novel lookup failed', err);
      noteDbFailure();
    }
  }
  return true; // memory fallback accepts any novel id
}

async function chapterExists(novelId: string, chapterNumber: number): Promise<boolean> {
  if (!isDbAvailable()) return true;
  try {
    const rows = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.novelId, novelId), eq(chapters.chapterNumber, chapterNumber)))
      .limit(1);
    return Boolean(rows[0]);
  } catch (err) {
    console.error('[comments] chapter lookup failed', err);
    noteDbFailure();
    return true;
  }
}

/** Owner-or-admin check for a novel. Returns caller on success. */
async function requireNovelMod(c: any, novelId: string) {
  const caller = await getCaller(c);
  if (!caller.row) return { error: c.json({ success: false, error: 'غير مصرح: مطلوب تسجيل الدخول' }, 401) };
  if (caller.isAdmin) return { caller };
  if (!isDbAvailable()) return { caller };
  try {
    const rows = await db.select().from(novels).where(eq(novels.id, novelId)).limit(1);
    const novel = rows[0];
    if (!novel) return { error: c.json({ success: false, error: 'الرواية غير موجودة' }, 404) };
    const ownerId = novel.authorUserId ?? novel.translatorUserId ?? null;
    if (ownerId && ownerId === caller.row.id) return { caller };
    return { error: c.json({ success: false, error: 'غير مسموح' }, 403) };
  } catch (err) {
    console.error('[comments] mod check failed', err);
    return { error: c.json({ success: false, error: 'تعذر التحقق' }, 500) };
  }
}

// ---------- novel-scoped routes ----------

// GET /api/v1/novels/:novelId/comments?chapter&cursor&limit&sort=new|top
commentsNovelsRouter.get('/:novelId/comments', async (c) => {
  const novelId = c.req.param('novelId');
  const parsed = listQuerySchema.safeParse({
    chapter: c.req.query('chapter'), cursor: c.req.query('cursor'),
    limit: c.req.query('limit'), sort: c.req.query('sort') ?? 'new', status: c.req.query('status'),
  });
  if (!parsed.success) return c.json({ success: false, error: 'استعلام غير صالح', issues: parsed.error.issues }, 400);
  const { chapter, cursor: cursorRaw, limit, sort, status } = parsed.data;
  let cursor: RootsCursor | undefined;
  if (cursorRaw) {
    const d = decodeCursor(cursorRaw);
    if (!d) return c.json({ success: false, error: 'مؤشر ترقيم غير صالح' }, 400);
    cursor = d;
  }

  // Moderators may request non-visible statuses; everyone else is forced to visible.
  let wantStatus: string | undefined;
  if (status && !getEnv().syncOpen) {
    const mod = await requireNovelMod(c, novelId).catch(() => null);
    if (mod && 'caller' in mod) wantStatus = status;
  } else if (status && getEnv().syncOpen) {
    wantStatus = status;
  }
  const visibleOnly = wantStatus === undefined;

  if (!isDbAvailable()) {
    const all = memList(novelId, chapter, visibleOnly).filter((m) => m.parentId === null);
    all.sort((a, b) => sort === 'top' ? b.likesCount - a.likesCount || b.id - a.id : b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
    let start = 0;
    if (cursor) {
      start = all.findIndex((m) =>
        sort === 'top'
          ? m.likesCount < (cursor.s ?? 0) || (m.likesCount === (cursor.s ?? 0) && (m.createdAt < new Date(cursor.t).toISOString() || m.id < cursor.i))
          : m.createdAt < new Date(cursor.t).toISOString() || (m.createdAt === new Date(cursor.t).toISOString() && m.id < cursor.i));
      if (start < 0) start = all.length;
    }
    const page = all.slice(start, start + limit);
    const roots = page.map((m) => memToApi(m, 0));
    // reply preview: oldest 2 visible children per root
    const data = roots.map((r) => {
      const rid = Number(String(r.id).replace('app_', ''));
      const kids = [...MEM.values()].filter((m) => m.rootId === rid && (visibleOnly ? m.status === 'visible' : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).slice(0, 2)
        .map((m) => memToApi(m, 0));
      return { ...r, preview: kids };
    });
    const last = page[page.length - 1];
    const nextCursor = last && all.length > start + limit
      ? encodeCursor(sort === 'top' ? { s: last.likesCount, t: new Date(last.createdAt).getTime(), i: last.id } : { t: new Date(last.createdAt).getTime(), i: last.id })
      : null;
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, total: all.length, data, pagination: { limit, nextCursor, hasMore: nextCursor !== null } });
  }

  try {
    if (!(await novelExists(novelId))) return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);
    const statusCond = visibleOnly ? eq(comments.status, 'visible') : wantStatus ? eq(comments.status, wantStatus) : undefined;
    const chapterCond = chapter !== undefined ? eq(comments.chapterNumber, chapter) : sql`${comments.chapterNumber} IS NULL`;
    const base = and(eq(comments.novelId, novelId), sql`${comments.parentId} IS NULL`, chapterCond, statusCond);
    const order = sort === 'top' ? [desc(comments.likesCount), desc(comments.id)] : [desc(comments.createdAt), desc(comments.id)];
    let cursorCond;
    if (cursor) {
      cursorCond = sort === 'top'
        ? sql`(${comments.likesCount}, ${comments.createdAt}, ${comments.id}) < (${cursor.s ?? 0}, ${new Date(cursor.t)}, ${cursor.i})`
        : sql`(${comments.createdAt}, ${comments.id}) < (${new Date(cursor.t)}, ${cursor.i})`;
    }
    const rows = await db.select().from(comments).where(cursorCond ? and(base, cursorCond) : base).orderBy(...order).limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(comments).where(base);

    // authors batch
    const uids = [...new Set(page.map((r) => r.userId).filter(Boolean))] as string[];
    const lookup = new Map<string, { name: string; avatarUrl?: string }>();
    if (uids.length) {
      const urows = await db.select().from(users).where(inArray(users.id, uids));
      for (const u of urows) lookup.set(u.id, { name: u.displayName || u.username || 'مستخدم', avatarUrl: u.avatarUrl ?? undefined });
    }
    // liked-by-me batch
    const liked = new Set<number>();
    if (!getEnv().syncOpen) {
      const caller = await getCaller(c);
      if (caller.row && page.length) {
        const vrows = await db.select({ commentId: commentVotes.commentId }).from(commentVotes)
          .where(and(eq(commentVotes.userId, caller.row.id), inArray(commentVotes.commentId, page.map((r) => r.id))));
        for (const v of vrows) liked.add(v.commentId);
      }
    }
    // reply preview in one query
    const rootIds = page.map((r) => r.id);
    const previews = new Map<number, CommentRow[]>();
    if (rootIds.length) {
      const kids = await db.select().from(comments)
        .where(and(inArray(comments.rootId, rootIds), visibleOnly ? eq(comments.status, 'visible') : sql`true`))
        .orderBy(asc(comments.createdAt), asc(comments.id))
        .limit(rootIds.length * 2 + 10);
      const perRoot = new Map<number, number>();
      for (const k of kids) {
        const rk = k.rootId as number;
        const used = perRoot.get(rk) ?? 0;
        if (used >= 2) continue;
        perRoot.set(rk, used + 1);
        const arr = previews.get(rk) ?? [];
        arr.push(k);
        previews.set(rk, arr);
      }
    }
    const data = page.map((r) => ({
      ...toApi(r, authorOf(r.userId, lookup), (liked.has(r.id) ? 1 : 0) as 1 | -1 | 0),
      preview: (previews.get(r.id) ?? []).map((k) => toApi(k, authorOf(k.userId, lookup), 0)),
    }));
    const last = page[page.length - 1];
    const nextCursor = last && hasMore
      ? encodeCursor(sort === 'top'
        ? { s: last.likesCount ?? 0, t: new Date(last.createdAt as unknown as string).getTime(), i: last.id }
        : { t: new Date(last.createdAt as unknown as string).getTime(), i: last.id })
      : null;
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, total: Number(n ?? page.length), data, pagination: { limit, nextCursor, hasMore } });
  } catch (err) {
    console.error('[comments] db list failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر تحميل التعليقات' }, 500);
  }
});

// GET /api/v1/novels/:novelId/comments/count?chapter
commentsNovelsRouter.get('/:novelId/comments/count', async (c) => {
  const novelId = c.req.param('novelId');
  const chapterRaw = c.req.query('chapter');
  const chapter = chapterRaw !== undefined ? Number(chapterRaw) : undefined;
  if (chapterRaw !== undefined && (!Number.isInteger(chapter) || (chapter as number) < 1)) {
    return c.json({ success: false, error: 'رقم الفصل غير صالح' }, 400);
  }
  if (!isDbAvailable()) {
    const all = memList(novelId, chapter, true);
    const roots = all.filter((m) => m.parentId === null).length;
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, data: { total: all.length, roots } });
  }
  try {
    const chapterCond = chapter !== undefined ? eq(comments.chapterNumber, chapter) : sql`${comments.chapterNumber} IS NULL`;
    const base = and(eq(comments.novelId, novelId), chapterCond, eq(comments.status, 'visible'));
    const [{ n: total }] = await db.select({ n: sql<number>`count(*)::int` }).from(comments).where(base);
    const [{ n: roots }] = await db.select({ n: sql<number>`count(*)::int` }).from(comments)
      .where(and(base, sql`${comments.parentId} IS NULL`));
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
    return c.json({ success: true, data: { total: Number(total ?? 0), roots: Number(roots ?? 0) } });
  } catch (err) {
    console.error('[comments] db count failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر تحميل العدد' }, 500);
  }
});

// GET /api/v1/novels/:novelId/comments/:commentId/replies?cursor&limit
commentsNovelsRouter.get('/:novelId/comments/:commentId/replies', async (c) => {
  const novelId = c.req.param('novelId');
  const commentId = Number(c.req.param('commentId'));
  if (!Number.isInteger(commentId)) return c.json({ success: false, error: 'معرف غير صالح' }, 400);
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  const cursorRaw = c.req.query('cursor');
  let cursor: RootsCursor | undefined;
  if (cursorRaw) {
    const d = decodeCursor(cursorRaw);
    if (!d) return c.json({ success: false, error: 'مؤشر ترقيم غير صالح' }, 400);
    cursor = d;
  }
  if (!isDbAvailable()) {
    const root = MEM.get(commentId);
    if (!root || root.novelId !== novelId) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    const kids = [...MEM.values()].filter((m) => m.rootId === (root.rootId ?? root.id) && m.status === 'visible')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    let start = 0;
    if (cursor) {
      const iso = new Date(cursor.t).toISOString();
      start = kids.findIndex((m) => m.createdAt > iso || (m.createdAt === iso && m.id > cursor.i));
      if (start < 0) start = kids.length;
    }
    const page = kids.slice(start, start + limit);
    const last = page[page.length - 1];
    const nextCursor = last && kids.length > start + limit ? encodeCursor({ t: new Date(last.createdAt).getTime(), i: last.id }) : null;
    return c.json({ success: true, total: kids.length, data: page.map((m) => memToApi(m, 0)), pagination: { limit, nextCursor, hasMore: nextCursor !== null } });
  }
  try {
    const rrows = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    const root = rrows[0];
    if (!root || root.novelId !== novelId) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    const threadId = (root.rootId as number) ?? root.id;
    const base = and(eq(comments.rootId, threadId), eq(comments.status, 'visible'));
    const cursorCond = cursor ? sql`(${comments.createdAt}, ${comments.id}) > (${new Date(cursor.t)}, ${cursor.i})` : undefined;
    const rows = await db.select().from(comments).where(cursorCond ? and(base, cursorCond) : base)
      .orderBy(asc(comments.createdAt), asc(comments.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const uids = [...new Set(page.map((r) => r.userId).filter(Boolean))] as string[];
    const lookup = new Map<string, { name: string; avatarUrl?: string }>();
    if (uids.length) {
      const urows = await db.select().from(users).where(inArray(users.id, uids));
      for (const u of urows) lookup.set(u.id, { name: u.displayName || u.username || 'مستخدم', avatarUrl: u.avatarUrl ?? undefined });
    }
    const last = page[page.length - 1];
    const nextCursor = last && hasMore ? encodeCursor({ t: new Date(last.createdAt as unknown as string).getTime(), i: last.id }) : null;
    return c.json({
      success: true, total: page.length,
      data: page.map((r) => toApi(r, authorOf(r.userId, lookup), 0)),
      pagination: { limit, nextCursor, hasMore },
    });
  } catch (err) {
    console.error('[comments] db replies failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر تحميل الردود' }, 500);
  }
});

// POST /api/v1/novels/:novelId/comments
commentsNovelsRouter.post('/:novelId/comments', prodGuard(requireAuth, rateLimit(5)), async (c) => {
  const novelId = c.req.param('novelId');
  const parsed = createCommentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: 'حقول غير صالحة', issues: parsed.error.issues }, 400);
  const { body, chapterNumber, parentId } = parsed.data;

  const writer = await resolveWriter(c);
  if ('error' in writer) return writer.error;

  if (!(await novelExists(novelId))) return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);
  if (chapterNumber !== undefined && !(await chapterExists(novelId, chapterNumber))) {
    return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
  }

  const wait = await checkCooldown(writer.userId, writer.cooldownS);
  if (wait > 0) return c.json({ success: false, error: 'مهلاً — انتظر قليلاً قبل التعليق التالي', retryAfter: wait }, 429);
  const hash = bodyHashHex(body.toLowerCase());
  if (await isDuplicate(writer.userId, hash, novelId)) return c.json({ success: false, error: 'تعليق مكرر' }, 409);

  const pending = shouldHoldForModeration(body);
  const status = pending ? 'pending' : 'visible';

  // Reply validation + thread resolution
  let parent: CommentRow | MemComment | null = null;
  if (parentId != null) {
    if (isDbAvailable()) {
      try {
        const rows = await db.select().from(comments).where(eq(comments.id, parentId)).limit(1);
        parent = rows[0] ?? null;
      } catch (err) {
        console.error('[comments] parent lookup failed', err);
        noteDbFailure();
      }
    } else {
      parent = MEM.get(parentId) ?? null;
    }
    if (!parent) return c.json({ success: false, error: 'التعليق الأب غير موجود' }, 404);
    if (parent.novelId !== novelId) return c.json({ success: false, error: 'التعليق الأب من رواية أخرى' }, 400);
    const pChapter = (parent as CommentRow).chapterNumber ?? (parent as MemComment).chapterNumber;
    if ((pChapter ?? null) !== (chapterNumber ?? null)) return c.json({ success: false, error: 'النطاق غير متطابق' }, 400);
    if ((parent as CommentRow).status !== undefined && (parent as CommentRow).status !== 'visible') {
      return c.json({ success: false, error: 'لا يمكن الرد على تعليق محجوب' }, 409);
    }
    if ((parent as MemComment).status !== undefined && (parent as MemComment).status !== 'visible') {
      return c.json({ success: false, error: 'لا يمكن الرد على تعليق محجوب' }, 409);
    }
    if ((parent.depth ?? 0) >= MAX_DEPTH) return c.json({ success: false, error: 'تم بلوغ أقصى عمق للردود' }, 400);
  }

  if (!isDbAvailable()) {
    const id = MEM_SEQ++;
    const now = new Date().toISOString();
    const rootId = parent ? ((parent.rootId as number | null) ?? parent.id) : null;
    const m: MemComment = {
      id, novelId, chapterNumber: chapterNumber ?? (parent ? ((parent as MemComment).chapterNumber ?? null) : null),
      userId: writer.userId === 'local-dev' ? null : writer.userId, userName: writer.userName, avatarUrl: writer.avatarUrl,
      parentId: parent ? parent.id : null, rootId, depth: parent ? (parent.depth ?? 0) + 1 : 0,
      body, bodyHash: hash, status, likesCount: 0,
      repliesCount: 0, reportsCount: 0, editCount: 0,
      createdAt: now, updatedAt: now, editedAt: null, deletedAt: null,
    };
    MEM.set(id, m);
    if (parent) {
      const bump = (pid: number | null) => {
        if (pid == null) return;
        const p = MEM.get(pid);
        if (p) p.repliesCount += 1;
      };
      bump(m.parentId);
      if (m.rootId !== m.parentId) bump(m.rootId);
    }
    return c.json({ success: true, message: pending ? 'تعليقك قيد المراجعة' : 'تم إضافة التعليق', data: memToApi(m, 0), needsModeration: pending }, 201);
  }

  try {
    const rootId = parent ? (((parent as CommentRow).rootId as number | null) ?? parent.id) : null;
    const depth = parent ? ((parent.depth ?? 0) + 1) : 0;
    const now = new Date();
    const inserted = await db.insert(comments).values({
      novelId, chapterNumber: chapterNumber ?? null,
      userId: writer.userId === 'local-dev' ? null : writer.userId,
      parentId: parent ? parent.id : null, rootId, depth,
      body, bodyHash: hash, status,
      createdAt: now, updatedAt: now,
    }).returning();
    const row = inserted[0];
    if (parent) {
      const ids = [parent.id, rootId].filter((x): x is number => x != null && x !== parent.id);
      const all = [parent.id, ...ids];
      for (const pid of [...new Set(all)]) {
        await db.update(comments).set({
          repliesCount: sql`${comments.repliesCount} + 1`,
          updatedAt: new Date(),
        }).where(eq(comments.id, pid));
      }
    }
    const lookup = new Map<string, { name: string; avatarUrl?: string }>();
    if (row.userId) lookup.set(row.userId, { name: writer.userName, avatarUrl: writer.avatarUrl });
    return c.json({
      success: true, message: pending ? 'تعليقك قيد المراجعة' : 'تم إضافة التعليق',
      data: toApi(row, authorOf(row.userId, lookup), 0), needsModeration: pending,
    }, 201);
  } catch (err) {
    console.error('[comments] db insert failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر إضافة التعليق' }, 500);
  }
});

// ---------- item routes (/api/v1/comments/:id) ----------

// PATCH /api/v1/comments/:id
commentsRouter.patch('/:id', prodGuard(requireAuth, rateLimit(30)), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: 'معرف غير صالح' }, 400);
  const parsed = editCommentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: 'حقول غير صالحة', issues: parsed.error.issues }, 400);
  const writer = await resolveWriter(c);
  if ('error' in writer) return writer.error;

  if (!isDbAvailable()) {
    const m = MEM.get(id);
    if (!m) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    if (writer.userId !== 'local-dev' && m.userId !== writer.userId) return c.json({ success: false, error: 'غير مسموح' }, 403);
    if (Date.now() - new Date(m.createdAt).getTime() > EDIT_WINDOW_MS) return c.json({ success: false, error: 'انتهت مهلة التعديل' }, 403);
    if (m.editCount >= MAX_EDITS) return c.json({ success: false, error: 'تم بلوغ حد التعديلات' }, 403);
    m.body = parsed.data.body; m.bodyHash = bodyHashHex(parsed.data.body.toLowerCase());
    m.editCount += 1; m.editedAt = new Date().toISOString(); m.updatedAt = m.editedAt;
    return c.json({ success: true, message: 'تم تعديل التعليق', data: memToApi(m, 0) });
  }
  try {
    const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    const row = rows[0];
    if (!row) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    if (writer.userId !== 'local-dev' && row.userId !== writer.userId) return c.json({ success: false, error: 'غير مسموح' }, 403);
    if (row.status === 'deleted') return c.json({ success: false, error: 'التعليق محذوف' }, 409);
    if (Date.now() - new Date(row.createdAt as unknown as string).getTime() > EDIT_WINDOW_MS) {
      return c.json({ success: false, error: 'انتهت مهلة التعديل' }, 403);
    }
    if ((row.editCount ?? 0) >= MAX_EDITS) return c.json({ success: false, error: 'تم بلوغ حد التعديلات' }, 403);
    await db.update(comments).set({
      body: parsed.data.body, bodyHash: bodyHashHex(parsed.data.body.toLowerCase()),
      editCount: sql`${comments.editCount} + 1`, editedAt: new Date(), updatedAt: new Date(),
    }).where(eq(comments.id, id));
    const updated = (await db.select().from(comments).where(eq(comments.id, id)).limit(1))[0];
    const lookup = new Map<string, { name: string; avatarUrl?: string }>();
    if (updated.userId) lookup.set(updated.userId, { name: writer.userName, avatarUrl: writer.avatarUrl });
    return c.json({ success: true, message: 'تم تعديل التعليق', data: toApi(updated, authorOf(updated.userId, lookup), 0) });
  } catch (err) {
    console.error('[comments] db edit failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر التعديل' }, 500);
  }
});

// DELETE /api/v1/comments/:id (soft)
commentsRouter.delete('/:id', prodGuard(requireAuth, rateLimit(30)), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: 'معرف غير صالح' }, 400);
  const writer = await resolveWriter(c);
  if ('error' in writer) return writer.error;

  if (!isDbAvailable()) {
    const m = MEM.get(id);
    if (!m) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    const own = writer.userId === 'local-dev' || m.userId === writer.userId;
    if (!own && !writer.isAdmin) return c.json({ success: false, error: 'غير مسموح' }, 403);
    if (m.status === 'deleted') return c.json({ success: true, message: 'تم حذف التعليق' });
    m.status = 'deleted'; m.deletedAt = new Date().toISOString();
    const bump = (pid: number | null) => {
      if (pid == null) return;
      const p = MEM.get(pid);
      if (p) p.repliesCount = Math.max(0, p.repliesCount - 1);
    };
    bump(m.parentId);
    if (m.rootId !== m.parentId) bump(m.rootId);
    return c.json({ success: true, message: 'تم حذف التعليق' });
  }
  try {
    const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    const row = rows[0];
    if (!row) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    const own = writer.userId !== 'local-dev' && row.userId === writer.userId;
    let allowed = own || writer.isAdmin;
    if (!allowed && writer.userId !== 'local-dev') {
      const mod = await requireNovelMod(c, row.novelId);
      allowed = mod !== null && 'caller' in mod;
    } else if (writer.userId === 'local-dev') {
      allowed = true;
    }
    if (!allowed) return c.json({ success: false, error: 'غير مسموح' }, 403);
    if (row.status === 'deleted') return c.json({ success: true, message: 'تم حذف التعليق' });
    await db.update(comments).set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() }).where(eq(comments.id, id));
    const pids = [row.parentId, row.rootId].filter((x): x is number => x != null);
    for (const pid of [...new Set(pids)]) {
      await db.update(comments).set({
        repliesCount: sql`GREATEST(0, ${comments.repliesCount} - 1)`,
        updatedAt: new Date(),
      }).where(eq(comments.id, pid));
    }
    if (writer.userId !== 'local-dev') {
      await db.insert(commentModLog).values({ commentId: id, action: 'delete', actorId: writer.userId });
    }
    return c.json({ success: true, message: 'تم حذف التعليق' });
  } catch (err) {
    console.error('[comments] db delete failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر الحذف' }, 500);
  }
});

// POST /api/v1/comments/:id/vote {value: 1|-1|0}
commentsRouter.post('/:id/vote', prodGuard(requireAuth, rateLimit(30)), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: 'معرف غير صالح' }, 400);
  const parsed = voteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: 'قيمة غير صالحة', issues: parsed.error.issues }, 400);
  const writer = await resolveWriter(c);
  if ('error' in writer) return writer.error;
  if (writer.userId === 'local-dev') return c.json({ success: false, error: 'سجل الدخول للتصويت' }, 401);

  if (!isDbAvailable()) {
    const m = MEM.get(id);
    if (!m || m.status !== 'visible') return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    if (m.userId === writer.userId) return c.json({ success: false, error: 'لا يمكن التصويت على تعليقك' }, 403);
    const key = `${id}:${writer.userId}`;
    const old = MEM_VOTES.get(key) ?? 0;
    const next = parsed.data.value;
    if (next === 0) MEM_VOTES.delete(key); else MEM_VOTES.set(key, next);
    m.likesCount += next - old;
    return c.json({ success: true, data: { commentId: `app_${id}`, score: m.likesCount, myVote: next } });
  }
  try {
    const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.status !== 'visible') return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    if (row.userId === writer.userId) return c.json({ success: false, error: 'لا يمكن التصويت على تعليقك' }, 403);
    const next = parsed.data.value;
    const existing = await db.select().from(commentVotes)
      .where(and(eq(commentVotes.commentId, id), eq(commentVotes.userId, writer.userId))).limit(1);
    const old = existing[0]?.value ?? 0;
    if (next === 0) {
      if (existing[0]) await db.delete(commentVotes).where(and(eq(commentVotes.commentId, id), eq(commentVotes.userId, writer.userId)));
    } else if (existing[0]) {
      await db.update(commentVotes).set({ value: next }).where(and(eq(commentVotes.commentId, id), eq(commentVotes.userId, writer.userId)));
    } else {
      await db.insert(commentVotes).values({ commentId: id, userId: writer.userId, value: next });
    }
    const delta = next - old;
    let score = (row.likesCount ?? 0) + delta;
    if (delta !== 0) {
      const updated = await db.update(comments).set({
        likesCount: sql`${comments.likesCount} + ${delta}`,
        updatedAt: new Date(),
      }).where(eq(comments.id, id)).returning();
      score = updated[0]?.likesCount ?? score;
    }
    return c.json({ success: true, data: { commentId: `app_${id}`, score, myVote: next } });
  } catch (err) {
    console.error('[comments] db vote failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر التصويت' }, 500);
  }
});

// POST /api/v1/comments/:id/report
commentsRouter.post('/:id/report', prodGuard(requireAuth, rateLimit(10)), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: 'معرف غير صالح' }, 400);
  const writer = await resolveWriter(c);
  if ('error' in writer) return writer.error;

  if (!isDbAvailable()) {
    const m = MEM.get(id);
    if (!m) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    m.reportsCount += 1;
    if (m.reportsCount >= REPORTS_TO_PENDING && m.status === 'visible') m.status = 'pending';
    return c.json({ success: true, message: 'تم الإبلاغ' });
  }
  try {
    const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!rows[0]) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    await db.update(comments).set({ reportsCount: sql`${comments.reportsCount} + 1`, updatedAt: new Date() }).where(eq(comments.id, id));
    const cur = (await db.select().from(comments).where(eq(comments.id, id)).limit(1))[0];
    if ((cur.reportsCount ?? 0) >= REPORTS_TO_PENDING && cur.status === 'visible') {
      await db.update(comments).set({ status: 'pending', updatedAt: new Date() }).where(eq(comments.id, id));
    }
    if (writer.userId !== 'local-dev') {
      await db.insert(commentModLog).values({ commentId: id, action: 'report', actorId: writer.userId });
    }
    return c.json({ success: true, message: 'تم الإبلاغ' });
  } catch (err) {
    console.error('[comments] db report failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر الإبلاغ' }, 500);
  }
});

async function modTransition(c: any, id: number, action: 'hide' | 'restore' | 'approve') {
  const parsed = modActionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: 'حقول غير صالحة' }, 400);
  const toStatus = action === 'restore' || action === 'approve' ? 'visible' : 'hidden';

  if (!isDbAvailable()) {
    const m = MEM.get(id);
    if (!m) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    if (m.status === 'deleted' && action !== 'approve') return c.json({ success: false, error: 'التعليق محذوف' }, 409);
    m.status = toStatus;
    return c.json({ success: true, message: 'تم', data: memToApi(m, 0) });
  }
  try {
    const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    const row = rows[0];
    if (!row) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    const mod = getEnv().syncOpen ? null : await requireNovelMod(c, row.novelId);
    if (mod && 'error' in mod) return mod.error;
    const actorId = getEnv().syncOpen ? null : (await getCaller(c)).row?.id ?? null;
    await db.update(comments).set({
      status: toStatus,
      decidedBy: actorId,
      decidedReason: parsed.data.reason ?? null,
      updatedAt: new Date(),
      deletedAt: toStatus === 'visible' ? null : row.deletedAt,
    }).where(eq(comments.id, id));
    if (actorId) await db.insert(commentModLog).values({ commentId: id, action, actorId, reason: parsed.data.reason ?? null });
    const updated = (await db.select().from(comments).where(eq(comments.id, id)).limit(1))[0];
    const lookup = new Map<string, { name: string; avatarUrl?: string }>();
    return c.json({ success: true, message: 'تم', data: toApi(updated, authorOf(updated.userId, lookup), 0) });
  } catch (err) {
    console.error('[comments] db mod failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر التنفيذ' }, 500);
  }
}

// POST /api/v1/comments/:id/hide|restore|approve
commentsRouter.post('/:id/hide', prodGuard(requireAuth), async (c) => modTransition(c, Number(c.req.param('id')), 'hide'));
commentsRouter.post('/:id/restore', prodGuard(requireAuth), async (c) => modTransition(c, Number(c.req.param('id')), 'restore'));
commentsRouter.post('/:id/approve', prodGuard(requireAuth), async (c) => modTransition(c, Number(c.req.param('id')), 'approve'));

// ---------- admin queue (/api/v1/admin/comments) ----------

adminCommentsRouter.get('/', prodGuard(requireAuth), async (c) => {
  const status = c.req.query('status') ?? 'pending';
  if (!['visible', 'pending', 'hidden', 'deleted'].includes(status)) return c.json({ success: false, error: 'حالة غير صالحة' }, 400);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  if (!getEnv().syncOpen) {
    const caller = await getCaller(c);
    if (!caller.row || !caller.isAdmin) return c.json({ success: false, error: 'غير مسموح' }, 403);
  }
  if (!isDbAvailable()) {
    const all = [...MEM.values()].filter((m) => m.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    return c.json({ success: true, total: all.length, data: all.map((m) => memToApi(m, 0)) });
  }
  try {
    const rows = await db.select().from(comments).where(eq(comments.status, status))
      .orderBy(desc(comments.createdAt)).limit(limit);
    const uids = [...new Set(rows.map((r) => r.userId).filter(Boolean))] as string[];
    const lookup = new Map<string, { name: string; avatarUrl?: string }>();
    if (uids.length) {
      const urows = await db.select().from(users).where(inArray(users.id, uids));
      for (const u of urows) lookup.set(u.id, { name: u.displayName || u.username || 'مستخدم', avatarUrl: u.avatarUrl ?? undefined });
    }
    return c.json({ success: true, total: rows.length, data: rows.map((r) => toApi(r, authorOf(r.userId, lookup), 0)) });
  } catch (err) {
    console.error('[comments] admin queue failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر التحميل' }, 500);
  }
});

// DELETE /api/v1/admin/comments/:id/hard (GDPR/abuse purge, admin only)
adminCommentsRouter.delete('/:id/hard', prodGuard(requireAuth), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ success: false, error: 'معرف غير صالح' }, 400);
  if (!getEnv().syncOpen) {
    const caller = await getCaller(c);
    if (!caller.row || !caller.isAdmin) return c.json({ success: false, error: 'غير مسموح' }, 403);
  }
  if (!isDbAvailable()) {
    if (!MEM.has(id)) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    MEM.delete(id);
    return c.json({ success: true, message: 'تم الحذف النهائي' });
  }
  try {
    const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!rows[0]) return c.json({ success: false, error: 'التعليق غير موجود' }, 404);
    await db.delete(comments).where(eq(comments.id, id));
    return c.json({ success: true, message: 'تم الحذف النهائي' });
  } catch (err) {
    console.error('[comments] hard delete failed', err);
    noteDbFailure();
    return c.json({ success: false, error: 'تعذر الحذف' }, 500);
  }
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app.js';
import {
  bodyHashHex, decodeCursor, encodeCursor, normalizeBody, shouldHoldForModeration,
} from './comments.js';

function openApp() {
  process.env.SYNC_OPEN = 'true';
  delete process.env.DATABASE_URL;
  return createApp();
}

describe('comments helpers (pure, no DB)', () => {
  it('cursor round-trips, rejects garbage', () => {
    const c = encodeCursor({ t: 1726400000000, i: 42 });
    expect(decodeCursor(c)).toEqual({ t: 1726400000000, i: 42 });
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
    expect(decodeCursor(encodeCursor({ t: 1, i: 2, s: 9 }))).toEqual({ t: 1, i: 2, s: 9 });
  });

  it('body hash is deterministic and input-sensitive', () => {
    expect(bodyHashHex('hello')).toBe(bodyHashHex('hello'));
    expect(bodyHashHex('hello')).not.toBe(bodyHashHex('hello!'));
  });

  it('normalizeBody strips controls and trims', () => {
    expect(normalizeBody('  hi\x00\x07 there  ')).toBe('hi there');
  });

  it('flags link spam and floods for moderation', () => {
    expect(shouldHoldForModeration('see http://a.com and https://b.com')).toBe(true);
    expect(shouldHoldForModeration('رأي جميل في الفصل')).toBe(false);
    expect(shouldHoldForModeration('a'.repeat(25))).toBe(true);
  });
});

describe('comments API (memory fallback, open mode)', () => {
  let app: ReturnType<typeof createApp>;
  const novelId = `test_novel_${Date.now()}`;

  beforeEach(() => {
    app = openApp();
  });

  it('full flow: post root + reply + list + replies + edit + vote-guard + delete', async () => {
    // post root
    const post = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'تعليق أول على الرواية' }),
    });
    expect(post.status).toBe(201);
    const posted: any = await post.json();
    expect(posted.success).toBe(true);
    expect(posted.data.id.startsWith('app_')).toBe(true);
    expect(posted.data.parentId).toBeNull();
    const rootId = posted.data.id.replace('app_', '');

    // list contains it
    const list = await app.request(`/api/v1/novels/${novelId}/comments?limit=10`);
    expect(list.status).toBe(200);
    const lbody: any = await list.json();
    expect(lbody.success).toBe(true);
    expect(lbody.total).toBeGreaterThanOrEqual(1);
    expect(lbody.data[0].id).toBe(posted.data.id);

    // reply
    const reply = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'رد على التعليق', parentId: Number(rootId) }),
    });
    expect(reply.status).toBe(201);
    const rbody: any = await reply.json();
    expect(rbody.data.parentId).toBe(posted.data.id);

    // replies list
    const reps = await app.request(`/api/v1/novels/${novelId}/comments/${rootId}/replies`);
    expect(reps.status).toBe(200);
    const repBody: any = await reps.json();
    expect(repBody.data.length).toBe(1);

    // duplicate blocked
    const dup = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'تعليق أول على الرواية' }),
    });
    expect(dup.status).toBe(409);

    // edit within window
    const edit = await app.request(`/api/v1/comments/${rootId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'تعليق معدل' }),
    });
    expect(edit.status).toBe(200);

    // vote requires login in open mode (local-dev has no user id)
    const vote = await app.request(`/api/v1/comments/${rootId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    });
    expect([401, 403]).toContain(vote.status);

    // delete (soft)
    const del = await app.request(`/api/v1/comments/${rootId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    // count
    const count = await app.request(`/api/v1/novels/${novelId}/comments/count`);
    expect(count.status).toBe(200);
    const cbody: any = await count.json();
    expect(cbody.success).toBe(true);
    expect(typeof cbody.data.total).toBe('number');
  });

  it('rejects invalid cursor and cross-novel parent', async () => {
    const bad = await app.request(`/api/v1/novels/${novelId}/comments?cursor=nope`);
    expect(bad.status).toBe(400);

    const other = `other_${Date.now()}`;
    const p1 = await app.request(`/api/v1/novels/${other}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'تعليق هناك' }),
    });
    const p1body: any = await p1.json();
    const foreignId = Number(String(p1body.data.id).replace('app_', ''));

    const cross = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'رد غريب', parentId: foreignId }),
    });
    expect(cross.status).toBe(400);
  });

  it('link spam lands in pending (needsModeration)', async () => {
    const res = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'زوروا http://spam.com و https://spam2.com الآن' }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.needsModeration).toBe(true);
    expect(body.data.status).toBe('pending');
  });

  it('chapter scope: default novel-only, ?chapter selects, reply inherits', async () => {
    const app = openApp();
    const novel = `ch_${Date.now()}`;
    const root = await (await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'جذر الفصل 72', chapterNumber: 72 }),
    })).json() as any;
    const wall: any = await (await app.request(`/api/v1/novels/${novel}/comments`)).json();
    expect(wall.data.some((c: any) => c.id === root.data.id)).toBe(false);
    const ch: any = await (await app.request(`/api/v1/novels/${novel}/comments?chapter=72`)).json();
    expect(ch.data.some((c: any) => c.id === root.data.id)).toBe(true);
    const rid = Number(String(root.data.id).replace('app_', ''));
    const rep = await (await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'رد موروث', parentId: rid }),
    })).json() as any;
    expect(rep.success).toBe(true);
    expect(rep.data.chapterNumber).toBe(72);
    const ch2: any = await (await app.request(`/api/v1/novels/${novel}/comments?chapter=72`)).json();
    expect(ch2.data[0].preview.length).toBeGreaterThanOrEqual(1);
    const bad = await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'رد مخالف', parentId: rid, chapterNumber: 5 }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).code).toBe('chapter_mismatch');
  });

  it('accepts both id formats; garbage yields invalid_id', async () => {
    const app = openApp();
    const novel = `ids_${Date.now()}`;
    const posted: any = await (await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'جذر للمعرفات' }),
    })).json();
    const bare = String(posted.data.id).replace('app_', '');
    for (const id of [bare, posted.data.id]) {
      const reps = await app.request(`/api/v1/novels/${novel}/comments/${id}/replies`);
      expect(reps.status).toBe(200);
      const edit = await app.request(`/api/v1/comments/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `تعديل ${id} ${Date.now()}` }),
      });
      expect(edit.status).toBe(200);
    }
    const bad = await app.request(`/api/v1/novels/${novel}/comments/app_abc/replies`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).code).toBe('invalid_id');
  });

  it('error bodies carry codes; replies total is true; previews capped at 2', async () => {
    const app = openApp();
    const novel = `tot_${Date.now()}`;
    const posted: any = await (await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'جذر العد' }),
    })).json();
    const rid = Number(String(posted.data.id).replace('app_', ''));
    const ts = Date.now();
    for (let i = 0; i < 5; i++) {
      await app.request(`/api/v1/novels/${novel}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `رد ${i} ${ts}`, parentId: rid }),
      });
    }
    const reps: any = await (await app.request(`/api/v1/novels/${novel}/comments/${rid}/replies?limit=2`)).json();
    expect(reps.total).toBe(5);
    expect(reps.data.length).toBe(2);
    const list: any = await (await app.request(`/api/v1/novels/${novel}/comments?limit=10`)).json();
    const mine = list.data.find((c: any) => c.id === posted.data.id);
    expect(mine.preview.length).toBeLessThanOrEqual(2);
    const dup = await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `رد 4 ${ts}`, parentId: rid }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).code).toBe('duplicate');
    const cur = await app.request(`/api/v1/novels/${novel}/comments?cursor=nope`);
    expect(((await cur.json()) as any).code).toBe('invalid_cursor');
  });

  it('preview skew: a root with many children does not starve later roots', async () => {
    const app = openApp();
    const novel = `skew_${Date.now()}`;
    const mk = (body: string) =>
      app.request(`/api/v1/novels/${novel}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
    const r1: any = await (await mk('skew root one')).json();
    const r2: any = await (await mk('skew root two')).json();
    const id1 = Number(String(r1.data.id).replace('app_', ''));
    const id2 = Number(String(r2.data.id).replace('app_', ''));
    const ts = Date.now();
    for (let i = 0; i < 10; i++) {
      await app.request(`/api/v1/novels/${novel}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `skew child ${i} ${ts}`, parentId: id1 }),
      });
    }
    await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `skew lone ${ts}`, parentId: id2 }),
    });
    const list: any = await (await app.request(`/api/v1/novels/${novel}/comments?limit=10`)).json();
    expect(list.success).toBe(true);
    const got1 = list.data.find((c: any) => c.id === r1.data.id);
    const got2 = list.data.find((c: any) => c.id === r2.data.id);
    expect(got1).toBeDefined();
    expect(got2).toBeDefined();
    expect(got1.preview.length).toBe(2);
    expect(got2.preview.length).toBe(1);
    expect(got2.preview[0].body).toBe(`skew lone ${ts}`);
    const times1 = got1.preview.map((k: any) => new Date(k.createdAt).getTime());
    expect(times1[0]).toBeLessThanOrEqual(times1[1]);
  });

  it('list cache header is public in anonymous open mode', async () => {
    const app = openApp();
    const res = await app.request(`/api/v1/novels/cache_${Date.now()}/comments`);
    expect(res.headers.get('cache-control')).toContain('public');
  });

  it('preview shows the NEWEST replies, rendered oldest to newest', async () => {
    const app = openApp();
    const novel = `prev_${Date.now()}`;
    const root: any = await (await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'root for preview order' }),
    })).json();
    const rid = Number(String(root.data.id).replace('app_', ''));
    // 3 replies: the preview cap is 2, so "first" must be pushed out.
    for (const label of ['r1', 'r2', 'r3']) {
      await app.request(`/api/v1/novels/${novel}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: label, parentId: rid }),
      });
    }
    const list: any = await (await app.request(`/api/v1/novels/${novel}/comments`)).json();
    const shown = list.data[0].preview.map((p: any) => p.body);
    // Newest 2 selected (r2, r3 — not r1), then ordered oldest→newest.
    expect(shown).toEqual(['r2', 'r3']);
  });

  it('preview carries the ancestor chain so a reply-to-a-reply can nest', async () => {
    // Mirrors the DB path's ancestor CTE (commentsPreview.postgres.test.ts
    // proves it against a real planner). The picked newest-2 rows here are
    // both grandchildren, so their parent is outside the window and must be
    // supplied — otherwise the client cannot nest them or name their target.
    const app = openApp();
    const novel = `anc_${Date.now()}`;
    const post = (body: string, parentId?: number) =>
      app.request(`/api/v1/novels/${novel}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parentId ? { body, parentId } : { body }),
      });
    const num = (id: string) => Number(String(id).replace('app_', ''));

    const root: any = await (await post('anc root')).json();
    const rid = num(root.data.id);
    const a: any = await (await post('anc a', rid)).json();
    const aid = num(a.data.id);
    const b: any = await (await post('anc b', aid)).json();
    void b;
    await post('anc c', aid);
    await post('anc d', aid);

    const list: any = await (await app.request(`/api/v1/novels/${novel}/comments`)).json();
    const preview = list.data[0].preview as any[];
    const ids = preview.map((p) => p.id);
    // The picked newest-2 are `c` and `d`; their parent `a` is outside that
    // window and must arrive as an ancestor, or both render as replies to the
    // root instead of to `a`. `b` is NOT an ancestor of either and is
    // correctly absent — the preview carries the chain, not the whole thread.
    expect(ids).toContain(a.data.id);
    expect(ids).not.toContain(b.data.id);
    // The root is the thread itself, never a member of its own preview.
    expect(ids).not.toContain(root.data.id);
    // Oldest-first, and the ancestor sits before the rows that need it.
    expect(ids[0]).toBe(a.data.id);
    expect(ids).toHaveLength(3);
  });

  it('watermark moves only when the thread changes, and is never cached', async () => {
    const app = openApp();
    const novel = `wm_${Date.now()}`;
    const wm = async () => {
      const res = await app.request(`/api/v1/novels/${novel}/comments/watermark`);
      expect(res.status).toBe(200);
      // A cached watermark would freeze live updates, so it must be no-store.
      expect(res.headers.get('cache-control')).toContain('no-store');
      return (await res.json() as any).data;
    };
    const empty = await wm();
    expect(empty.watermark).toBe('0');
    expect(empty.total).toBe(0);

    const posted: any = await (await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'first comment' }),
    })).json();
    const afterPost = await wm();
    expect(afterPost.watermark).not.toBe('0');
    expect(afterPost.total).toBe(1);

    // A read must not move the token (otherwise clients would refetch forever).
    expect((await wm()).watermark).toBe(afterPost.watermark);

    const rid = Number(String(posted.data.id).replace('app_', ''));
    await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'a reply', parentId: rid }),
    });
    const afterReply = await wm();
    expect(afterReply.watermark).not.toBe(afterPost.watermark);
    expect(afterReply.total).toBe(2);

    // chapter scope is isolated from the novel wall
    const scoped = await (await app.request(`/api/v1/novels/${novel}/comments/watermark?chapter=5`)).json();
    expect(scoped.data.watermark).toBe('0');
    const bad = await app.request(`/api/v1/novels/${novel}/comments/watermark?chapter=abc`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).code).toBe('invalid_query');
  });

  it('watermark moves when a HIDDEN low-id comment is approved', async () => {
    // The gap a max(created_at) token would miss: approving a comment whose id
    // is BELOW the newest visible id leaves max(id)/max(created_at) of the
    // visible set unchanged, so the token must key off updated_at instead.
    const app = openApp();
    const novel = `appr_${Date.now()}`;
    // Post 3 roots; a link-heavy body lands as 'pending' (not visible).
    const held: any = await (await app.request(`/api/v1/novels/${novel}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'see http://a.com and http://b.com now' }),
    })).json();
    expect(held.data.status).toBe('pending');
    for (const label of ['v1', 'v2', 'v3']) {
      await app.request(`/api/v1/novels/${novel}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: label }),
      });
    }
    const wm = async () => (await (await app.request(`/api/v1/novels/${novel}/comments/watermark`)).json() as any).data;
    const before = await wm();
    expect(before.total).toBe(3);

    // Approve the held comment (open mode: moderation is unauthenticated).
    const id = String(held.data.id).replace('app_', '');
    const approved = await app.request(`/api/v1/comments/${id}/approve`, { method: 'POST' });
    expect(approved.status).toBe(200);

    const after = await wm();
    // The count is recomputed every poll...
    expect(after.total).toBe(4);
    // ...and the token MUST move, or an open drawer never refetches to show
    // the newly approved comment.
    expect(after.watermark).not.toBe(before.watermark);
  });

  it('owner toggle closes posting (403 comments_closed) and reopens it', async () => {
    const app = openApp();
    const created: any = await (await app.request('/api/v1/novels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'رواية التبديل', author: 'كاتب', category: 'فانتازيا' }),
    })).json();
    expect(created.success).toBe(true);
    const novelId = created.data.id as string;
    expect(created.data.commentsEnabled).toBe(true);

    const close = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(close.status).toBe(200);
    expect(((await close.json()) as any).data.commentsEnabled).toBe(false);

    const detail: any = await (await app.request(`/api/v1/novels/${novelId}`)).json();
    expect(detail.data.commentsEnabled).toBe(false);

    const blocked = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'محاولة أثناء الإغلاق' }),
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as any).code).toBe('comments_closed');

    // Reads still work while closed.
    const list = await app.request(`/api/v1/novels/${novelId}/comments`);
    expect(list.status).toBe(200);

    const open = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(open.status).toBe(200);

    const post = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'تعليق بعد الفتح' }),
    });
    expect(post.status).toBe(201);

    const bad = await app.request(`/api/v1/novels/${novelId}/comments`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    const missing = await app.request('/api/v1/novels/no_such_novel_xyz/comments', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(missing.status).toBe(404);
  });
});

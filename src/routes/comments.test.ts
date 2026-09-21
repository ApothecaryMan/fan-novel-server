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

  it('list cache header is public in anonymous open mode', async () => {
    const app = openApp();
    const res = await app.request(`/api/v1/novels/cache_${Date.now()}/comments`);
    expect(res.headers.get('cache-control')).toContain('public');
  });
});

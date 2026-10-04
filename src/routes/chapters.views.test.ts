import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CHAPTERS_STORE, chaptersRouter, qualifiesForView } from './chapters.js';
import { NOVELS_STORE } from './novels.js';

describe('qualifiesForView', () => {
  it('requires real reading, not just opening', () => {
    expect(qualifiesForView(undefined, undefined)).toBe(false);
    expect(qualifiesForView(0, 0)).toBe(false);
    expect(qualifiesForView(14, 0.24)).toBe(false);
    expect(qualifiesForView(15, 0)).toBe(true);
    expect(qualifiesForView(0, 0.25)).toBe(true);
    expect(qualifiesForView(3, 0.9)).toBe(true);
  });
});

describe('POST /novels/:id/chapters/:n/view (memory fallback)', () => {
  const novelId = `views_test_${process.pid.toString(36)}`;
  const app = new Hono();
  app.route('/api/v1/novels', chaptersRouter);

  function seed() {
    const now = new Date().toISOString();
    if (!NOVELS_STORE.has(novelId)) {
      NOVELS_STORE.set(novelId, {
        id: novelId, title: 'Views Test', author: 'Tester', category: 'test',
        status: 'مستمرة', rating: 5, readersCount: '0', viewsCount: 0, totalChapters: 1,
        coverUrl: '', summary: '', tags: [], commentsEnabled: true, createdAt: now, updatedAt: now,
      });
    }
    if (!CHAPTERS_STORE.has(novelId)) {
      CHAPTERS_STORE.set(novelId, [
        { id: 900001, novelId, chapterNumber: 1, title: 'ch1', content: 'x', wordCount: 1, viewsCount: 0, createdAt: now },
      ]);
    }
    const ch = CHAPTERS_STORE.get(novelId)![0];
    ch.viewsCount = 0;
    NOVELS_STORE.get(novelId)!.viewsCount = 0;
  }

  async function postView(body: unknown, ip: string) {
    return app.request(`/api/v1/novels/${novelId}/chapters/1/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, 'user-agent': 'views-test' },
      body: JSON.stringify(body),
    });
  }

  it('rejects unqualified opens without counting', async () => {
    seed();
    const res = await postView({}, '10.9.0.1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, counted: false });
    expect(CHAPTERS_STORE.get(novelId)![0].viewsCount).toBe(0);
  });

  it('counts a qualified read once, then dedupes the immediate re-open', async () => {
    seed();
    const first = await postView({ readSeconds: 20, progress: 0.1 }, '10.9.0.2');
    expect(await first.json()).toMatchObject({ success: true, counted: true, data: { viewsCount: 1, totalViews: 1 } });
    const second = await postView({ readSeconds: 20, progress: 0.1 }, '10.9.0.2');
    expect(await second.json()).toMatchObject({ success: true, counted: false });
    expect(CHAPTERS_STORE.get(novelId)![0].viewsCount).toBe(1);
    expect(NOVELS_STORE.get(novelId)!.viewsCount).toBe(1);
  });

  it('exposes the counters on list and content reads', async () => {
    seed();
    await postView({ progress: 0.5 }, '10.9.0.3');
    const list = await app.request(`/api/v1/novels/${novelId}/chapters`, { headers: { 'x-forwarded-for': '10.9.0.3' } });
    const listJson = await list.json() as { data: Array<{ viewsCount: number }> };
    expect(listJson.data[0].viewsCount).toBe(1);
    const single = await app.request(`/api/v1/novels/${novelId}/chapters/1`, { headers: { 'x-forwarded-for': '10.9.0.3' } });
    const singleJson = await single.json() as { data: { viewsCount: number } };
    expect(singleJson.data.viewsCount).toBe(1);
  });
});

import { Hono } from 'hono';
import { NOVELS_STORE } from './novels.js';

// chaptersRouter: novel-scoped chapter routes (mounted under /api/v1/novels)
export const chaptersRouter = new Hono();
// chaptersTimelineRouter: chapter aggregation routes (mounted under /api/v1/chapters)
export const chaptersTimelineRouter = new Hono();

export interface ChapterData {
  id: number;
  novelId: string;
  chapterNumber: number;
  title: string;
  content: string;
  wordCount?: number;
  createdAt: string;
}

export interface ChapterTimelineItem {
  id: number;
  chapterNumber: number;
  title: string;
  wordCount?: number;
  createdAt: string;
  timestamp: number;
  dayOfWeek: number;
  dateStr: string;
  novel: {
    id: string;
    title: string;
    author: string;
    coverUrl: string;
    category: string;
    sourceId?: string;
  };
}

export interface NovelTimelineGroup {
  novelId: string;
  sourceId?: string;
  novelTitle: string;
  novelCover: string;
  novelAuthor: string;
  category: string;
  chapterCount: number;
  latestChapterNumber: number;
  latestChapterTitle: string;
  latestCreatedAt: string;
  chapters: Array<{
    id: number;
    chapterNumber: number;
    title: string;
    createdAt: string;
  }>;
}

// In-Memory Database store for live chapters
export const CHAPTERS_STORE: Map<string, ChapterData[]> = new Map();

// Helper to seed initial sample chapters if store is empty.
// NOTE: This is in-memory dev/demo data only. All data resets on server restart.
function ensureSeedData() {
  if (CHAPTERS_STORE.size > 0) return;

  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const twentyMinsAgo = new Date(now - 20 * 60 * 1000).toISOString();

  if (!NOVELS_STORE.has('1')) {
    NOVELS_STORE.set('1', {
      id: '1',
      title: 'سيد الكينونة الأبدية',
      author: 'جينغ شو',
      category: 'فانتازيا',
      status: 'مستمرة',
      rating: 4.8,
      readersCount: '12.4k',
      totalChapters: 46,
      coverUrl: '',
      summary: 'في عالم تتصادم فيه قوى السحر والداو...',
      tags: ['فانتازيا', 'مغامرات'],
      createdAt: twoHoursAgo,
      updatedAt: twentyMinsAgo
    });
  }

  // Seed sample chapters for novel "1" or default demo novels
  CHAPTERS_STORE.set('1', [
    {
      id: 101,
      novelId: '1',
      chapterNumber: 45,
      title: 'الفصل 45: استيقاظ التنين',
      content: 'محتوى الفصل التجريبي...',
      wordCount: 1540,
      createdAt: twoHoursAgo
    },
    {
      id: 102,
      novelId: '1',
      chapterNumber: 46,
      title: 'الفصل 46: كسر القيود',
      content: 'محتوى الفصل الثاني التجريبي...',
      wordCount: 1820,
      createdAt: twentyMinsAgo
    }
  ]);
}
ensureSeedData();

// POST /api/v1/chapters/timeline
chaptersTimelineRouter.post('/timeline', async (c) => {
  ensureSeedData();
  const body = await c.req.json().catch(() => ({}));
  const novelIds: string[] | undefined = body.novelIds;
  const period: 'today' | 'week' | 'custom' = body.period || 'today';
  const groupBy: 'novel' | 'day' | 'none' = body.groupBy || 'novel';
  const limit: number | undefined = body.limit ? Number(body.limit) : undefined;

  const now = Date.now();
  let since = body.since != null ? Number(body.since) : undefined;
  const until = body.until != null ? Number(body.until) : undefined;

  if (since === undefined) {
    if (period === 'week') {
      since = now - 7 * 24 * 60 * 60 * 1000;
    } else {
      // 'today' default: start of local day
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      since = startOfDay.getTime();
    }
  }

  const targetNovelIds = novelIds && Array.isArray(novelIds) && novelIds.length > 0
    ? new Set(novelIds.map(String))
    : null;

  const chaptersList: ChapterTimelineItem[] = [];

  for (const [novelId, chList] of CHAPTERS_STORE.entries()) {
    if (targetNovelIds && !targetNovelIds.has(novelId)) continue;
    const novel = NOVELS_STORE.get(novelId);

    for (const ch of chList) {
      const chTime = new Date(ch.createdAt).getTime();
      if (chTime >= since && (!until || chTime <= until)) {
        const d = new Date(chTime);
        chaptersList.push({
          id: ch.id,
          chapterNumber: ch.chapterNumber,
          title: ch.title,
          wordCount: ch.wordCount,
          createdAt: ch.createdAt,
          timestamp: chTime,
          dayOfWeek: d.getDay(),
          dateStr: d.toISOString().slice(0, 10),
          novel: {
            id: novelId,
            title: novel?.title || 'رواية بدون عنوان',
            author: novel?.author || 'غير معروف',
            coverUrl: novel?.coverUrl || '',
            category: novel?.category || 'عام',
            sourceId: novel?.sourceId
          }
        });
      }
    }
  }

  // Sort descending by timestamp (newest first)
  chaptersList.sort((a, b) => b.timestamp - a.timestamp);

  // 1. Group by Novel
  if (groupBy === 'novel') {
    const map = new Map<string, NovelTimelineGroup>();

    for (const item of chaptersList) {
      let group = map.get(item.novel.id);
      if (!group) {
        group = {
          novelId: item.novel.id,
          sourceId: item.novel.sourceId,
          novelTitle: item.novel.title,
          novelCover: item.novel.coverUrl,
          novelAuthor: item.novel.author,
          category: item.novel.category,
          chapterCount: 0,
          latestChapterNumber: item.chapterNumber,
          latestChapterTitle: item.title,
          latestCreatedAt: item.createdAt,
          chapters: []
        };
        map.set(item.novel.id, group);
      }
      group.chapterCount += 1;
      group.chapters.push({
        id: item.id,
        chapterNumber: item.chapterNumber,
        title: item.title,
        createdAt: item.createdAt
      });
    }

    const groups = Array.from(map.values());
    const finalGroups = limit ? groups.slice(0, limit) : groups;

    return c.json({
      success: true,
      total: finalGroups.length,
      period,
      data: finalGroups
    });
  }

  // 2. Group by Day (for Weekly Schedule)
  if (groupBy === 'day') {
    const map = new Map<string, ChapterTimelineItem[]>();
    for (const item of chaptersList) {
      const dayList = map.get(item.dateStr) || [];
      dayList.push(item);
      map.set(item.dateStr, dayList);
    }
    const daysData = Array.from(map.entries()).map(([dateStr, items]) => ({
      dateStr,
      dayOfWeek: items[0]?.dayOfWeek ?? 0,
      total: items.length,
      chapters: items
    }));

    return c.json({
      success: true,
      total: daysData.length,
      period,
      data: daysData
    });
  }

  // 3. Raw List
  const finalItems = limit ? chaptersList.slice(0, limit) : chaptersList;
  return c.json({
    success: true,
    total: finalItems.length,
    period,
    data: finalItems
  });
});

// GET /api/v1/chapters/today (convenience shortcut)
chaptersTimelineRouter.get('/today', (c) => {
  ensureSeedData();
  const novelIdsParam = c.req.query('novelIds');
  const novelIds = novelIdsParam ? novelIdsParam.split(',') : undefined;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const targetNovelIds = novelIds && novelIds.length > 0 ? new Set(novelIds.map(String)) : null;
  const list: ChapterTimelineItem[] = [];

  for (const [novelId, chList] of CHAPTERS_STORE.entries()) {
    if (targetNovelIds && !targetNovelIds.has(novelId)) continue;
    const novel = NOVELS_STORE.get(novelId);
    for (const ch of chList) {
      const chTime = new Date(ch.createdAt).getTime();
      if (chTime >= startOfDay.getTime()) {
        const d = new Date(chTime);
        list.push({
          id: ch.id,
          chapterNumber: ch.chapterNumber,
          title: ch.title,
          wordCount: ch.wordCount,
          createdAt: ch.createdAt,
          timestamp: chTime,
          dayOfWeek: d.getDay(),
          dateStr: d.toISOString().slice(0, 10),
          novel: {
            id: novelId,
            title: novel?.title || 'رواية',
            author: novel?.author || 'غير معروف',
            coverUrl: novel?.coverUrl || '',
            category: novel?.category || 'عام',
            sourceId: novel?.sourceId
          }
        });
      }
    }
  }

  return c.json({
    success: true,
    total: list.length,
    data: list
  });
});

// GET /api/v1/novels/:novelId/chapters
chaptersRouter.get('/:novelId/chapters', (c) => {
  const novelId = c.req.param('novelId');
  const chapters = CHAPTERS_STORE.get(novelId) || [];

  return c.json({
    success: true,
    total: chapters.length,
    data: chapters.map((ch) => ({
      id: ch.id,
      novelId: ch.novelId,
      chapterNumber: ch.chapterNumber,
      title: ch.title,
      wordCount: ch.wordCount,
      createdAt: ch.createdAt
    }))
  });
});

// GET /api/v1/novels/:novelId/chapters/:chapterNumber
chaptersRouter.get('/:novelId/chapters/:chapterNumber', (c) => {
  const { novelId, chapterNumber } = c.req.param();
  const num = parseInt(chapterNumber, 10);
  const chapters = CHAPTERS_STORE.get(novelId) || [];

  const chapter = chapters.find((ch) => ch.chapterNumber === num || ch.id === num);

  if (!chapter) {
    return c.json({ success: false, error: 'الفصل غير موجود' }, 404);
  }

  const nextChapter = chapters.find((ch) => ch.chapterNumber === num + 1);
  const prevChapter = chapters.find((ch) => ch.chapterNumber === num - 1);

  return c.json({
    success: true,
    data: {
      ...chapter,
      nextChapterId: nextChapter ? nextChapter.id : null,
      prevChapterId: prevChapter ? prevChapter.id : null,
      totalChapters: chapters.length
    }
  });
});

// POST /api/v1/novels/:novelId/chapters (Add chapter)
chaptersRouter.post('/:novelId/chapters', async (c) => {
  try {
    const novelId = c.req.param('novelId');
    const body = await c.req.json();

    if (!body.title || !body.content) {
      return c.json({ success: false, error: 'عنوان ومحتوى الفصل حقول مطلوبة' }, 400);
    }

    const currentList = CHAPTERS_STORE.get(novelId) || [];
    const chapterNumber = body.chapterNumber || currentList.length + 1;
    const wordCount = body.content.trim().split(/\s+/).length;

    const newChapter: ChapterData = {
      id: body.id || (currentList.length > 0 ? Math.max(...currentList.map(ch => ch.id)) + 1 : 1),
      novelId,
      chapterNumber,
      title: body.title,
      content: body.content,
      wordCount,
      createdAt: new Date().toISOString()
    };

    currentList.push(newChapter);
    CHAPTERS_STORE.set(novelId, currentList);

    return c.json({
      success: true,
      message: 'تم إضافة الفصل بنجاح',
      data: newChapter
    }, 201);
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'حدث خطأ أثناء إضافة الفصل' }, 500);
  }
});

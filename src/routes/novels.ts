import { Hono } from 'hono';

export const novelsRouter = new Hono();

export interface NovelData {
  id: string;
  sourceId?: string;
  title: string;
  originalTitle?: string;
  author: string;
  translator?: string;
  category: string;
  status: string;
  rating: number;
  readersCount: string;
  totalChapters: number;
  coverUrl: string;
  summary: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// In-Memory Database store for live operations
export const NOVELS_STORE: Map<string, NovelData> = new Map();

// GET /api/v1/novels
novelsRouter.get('/', (c) => {
  const category = c.req.query('category');
  const q = c.req.query('q')?.toLowerCase();

  let data = Array.from(NOVELS_STORE.values());

  if (category && category !== 'الكل') {
    data = data.filter((n) => n.category.includes(category) || n.tags?.includes(category));
  }

  if (q) {
    data = data.filter((n) =>
      n.title.toLowerCase().includes(q) ||
      n.author.toLowerCase().includes(q) ||
      n.category.toLowerCase().includes(q) ||
      n.tags?.some((t) => t.toLowerCase().includes(q))
    );
  }

  return c.json({
    success: true,
    total: data.length,
    data
  });
});

// GET /api/v1/novels/:id
novelsRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  const novel = NOVELS_STORE.get(id);

  if (!novel) {
    return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);
  }

  return c.json({ success: true, data: novel });
});

// POST /api/v1/novels (Add new novel)
novelsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json();
    
    if (!body.title || !body.author || !body.category) {
      return c.json({ success: false, error: 'العنوان والمؤلف والتصنيف حقول مطلوبة' }, 400);
    }

    const id = body.id || `novel_${Date.now()}`;
    const now = new Date().toISOString();

    const newNovel: NovelData = {
      id,
      title: body.title,
      originalTitle: body.originalTitle || '',
      author: body.author,
      translator: body.translator || '',
      category: body.category,
      status: body.status || 'مستمرة',
      rating: body.rating || 5.0,
      readersCount: body.readersCount || '0',
      totalChapters: body.totalChapters || 0,
      coverUrl: body.coverUrl || '',
      summary: body.summary || '',
      tags: Array.isArray(body.tags) ? body.tags : (body.tags ? body.tags.split(',').map((t: string) => t.trim()) : []),
      createdAt: now,
      updatedAt: now
    };

    NOVELS_STORE.set(id, newNovel);

    return c.json({
      success: true,
      message: 'تم إضافة الرواية بنجاح',
      data: newNovel
    }, 201);
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'حدث خطأ أثناء حفظ الرواية' }, 500);
  }
});

// PUT /api/v1/novels/:id (Update novel)
novelsRouter.put('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = NOVELS_STORE.get(id);

    if (!existing) {
      return c.json({ success: false, error: 'الرواية غير موجودة للتعديل' }, 404);
    }

    const body = await c.req.json();
    const now = new Date().toISOString();

    const updatedNovel: NovelData = {
      ...existing,
      title: body.title ?? existing.title,
      originalTitle: body.originalTitle ?? existing.originalTitle,
      author: body.author ?? existing.author,
      translator: body.translator ?? existing.translator,
      category: body.category ?? existing.category,
      status: body.status ?? existing.status,
      rating: body.rating ?? existing.rating,
      readersCount: body.readersCount ?? existing.readersCount,
      totalChapters: body.totalChapters ?? existing.totalChapters,
      coverUrl: body.coverUrl ?? existing.coverUrl,
      summary: body.summary ?? existing.summary,
      tags: Array.isArray(body.tags) ? body.tags : (body.tags ? body.tags.split(',').map((t: string) => t.trim()) : existing.tags),
      updatedAt: now
    };

    NOVELS_STORE.set(id, updatedNovel);

    return c.json({
      success: true,
      message: 'تم تعديل بيانات الرواية بنجاح',
      data: updatedNovel
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'حدث خطأ أثناء تعديل الرواية' }, 500);
  }
});

// DELETE /api/v1/novels/:id (Delete novel)
novelsRouter.delete('/:id', (c) => {
  const id = c.req.param('id');
  if (!NOVELS_STORE.has(id)) {
    return c.json({ success: false, error: 'الرواية غير موجودة' }, 404);
  }

  NOVELS_STORE.delete(id);
  return c.json({ success: true, message: 'تم حذف الرواية بنجاح' });
});

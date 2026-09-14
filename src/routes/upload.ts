import { Hono } from 'hono';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

export const uploadRouter = new Hono();

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads', 'covers');

// Ensure upload directory exists
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(console.error);

// POST /api/v1/upload/cover
uploadRouter.post('/cover', async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ success: false, error: 'لم يتم إرسال ملف صورة صالح' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    
    // Determine extension
    let ext = '.png';
    if (file.type === 'image/jpeg') ext = '.jpg';
    else if (file.type === 'image/webp') ext = '.webp';
    else if (file.type === 'image/gif') ext = '.gif';

    const filename = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    await fs.writeFile(filePath, buffer);

    // Build URL relative to server
    const serverUrl = `/uploads/covers/${filename}`;

    return c.json({
      success: true,
      message: 'تم رفع صورة الغلاف بنجاح',
      url: serverUrl,
      filename
    });
  } catch (error: any) {
    console.error('Upload Error:', error);
    return c.json({ success: false, error: error.message || 'فشل في رفع الصورة' }, 500);
  }
});

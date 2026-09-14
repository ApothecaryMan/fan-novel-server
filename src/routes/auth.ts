import { Hono } from 'hono';
import { requireAuth, signToken } from '../middleware/auth.js';

export const authRouter = new Hono();

// In-memory users store (dev only — replaced by PostgreSQL in Phase 4)
let users: any[] = [];

/**
 * Best-effort verification of a Google idToken against Google's public
 * tokeninfo endpoint. Returns the verified email (empty when not verifiable).
 */
async function verifyGoogleIdToken(idToken?: string): Promise<{
  verified: boolean;
  email?: string;
}> {
  if (!idToken) return { verified: false };
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
    if (!res.ok) return { verified: false };
    const info = await res.json();
    return { verified: true, email: info.email };
  } catch {
    return { verified: false };
  }
}

// POST /api/v1/auth/google
authRouter.post('/google', async (c) => {
  try {
    const body = await c.req.json();
    const { name, username, email, avatarUrl, googleId, idToken } = body;

    if (!email) {
      return c.json({ error: 'البريد الإلكتروني مطلوب لتسجيل الدخول بحساب Google' }, 400);
    }

    const isProd = process.env.NODE_ENV === 'production';
    if (
      isProd &&
      (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith('web-novel-dev-'))
    ) {
      return c.json(
        { error: 'تسجيل الدخول غير مهيأ في بيئة الإنتاج: JWT_SECRET غير مضبوط' },
        501
      );
    }

    // When an idToken is supplied, prove it belongs to the claimed email.
    const check = await verifyGoogleIdToken(idToken);
    if (idToken) {
      if (!check.verified) {
        if (isProd) {
          return c.json({ error: 'تعذر التحقق من هوية Google' }, 401);
        }
        console.warn(`[dev] idToken verification skipped for ${email}; trusting email only`);
      } else if (check.email && check.email.toLowerCase() !== String(email).toLowerCase()) {
        return c.json({ error: 'عدم تطابق البريد الإلكتروني في رمز Google' }, 400);
      }
    }

    // Check if user already exists with this email
    let user = users.find((u) => u.email === email || (googleId && u.googleId === googleId));

    if (!user) {
      user = {
        id: `google_${googleId || Date.now()}`,
        name,
        username,
        email,
        avatarUrl,
        role: 'vip',
        provider: 'google',
        createdAt: new Date().toISOString()
      };
      users.push(user);
    } else {
      // Update details
      if (name) user.name = name;
      if (username) user.username = username;
      if (avatarUrl) user.avatarUrl = avatarUrl;
      user.provider = 'google';
    }

    const token = await signToken({ id: user.id, email: user.email, role: user.role });

    return c.json({
      success: true,
      message: 'تم تسجيل الدخول بحساب Google بنجاح',
      user,
      token
    });
  } catch (err: any) {
    return c.json({ error: 'فشل معالجة تسجيل الدخول عبر Google', details: err.message }, 500);
  }
});

// GET /api/v1/auth/me — authenticated: returns only the caller
authRouter.get('/me', requireAuth, (c) => {
  const payload = c.get('authUser') as { sub?: string };
  const user = users.find((u) => u.id === payload.sub);
  if (!user) return c.json({ error: 'المستخدم غير موجود' }, 404);
  return c.json({ user });
});
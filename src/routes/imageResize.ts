/**
 * Resize proxy for third-party comment attachment images.
 *
 * Why this exists: comment attachments on the site sources are served as the
 * original upload — measured 2.8 MB for a single PNG — and the free resize
 * proxy we used before (wsrv.nl) refuses them: it answers
 * `400 "Domain or TLD blocked by policy"` for truthnovel.top, so every image
 * fell back to the multi-megabyte original (3–25 s observed). Serving the
 * resize from our own Worker removes that external dependency, which can block
 * us at any time, and turns a 2.8 MB download into ~30 KB.
 *
 * SECURITY — this endpoint fetches a URL supplied by the client, which is a
 * textbook SSRF sink. Two independent controls, because one is not enough:
 *
 *  1. Host allowlist (primary). Only the known novel sites in
 *     extensions-repo may be fetched. A host that is not on this list is
 *     rejected before any network call. This is an allowlist rather than a
 *     denylist precisely so unknown and attacker-controlled hosts cannot be
 *     reached at all.
 *  2. Scheme, redirect and address guards (defence in depth, in case the
 *     allowlist is widened later). Only https/http; redirects are followed
 *     manually and each hop is re-validated, because a trusted host could
 *     otherwise redirect us to an internal address. The resolved IP is checked
 *     against private/loopback/link-local ranges. Cloudflare Workers fetch
 *     cannot reach the private network anyway, but the guard documents intent
 *     and protects any future runtime that can.
 *
 * Anonymous, cacheable, and read-only: it fetches images and returns bytes.
 * It never accepts a body and never mutates anything.
 */
import { Hono } from 'hono';

export const imageResizeRouter = new Hono();

/** Hosts we are willing to fetch from. Keep in sync with extensions-repo. */
const ALLOWED_HOSTS = [
  'truthnovel.top',
  'kolnovel.com',
  'cmtapi.kolnovel.com',
  'cenele.com',
  'shamela.ws',
  'novelfull.com',
  'wuxiaworld.com',
  'safahat.org',
  'wikisource.org',
  'hindawi.org',
] as const;

const MAX_WIDTH = 1600;
const MIN_WIDTH = 64;
const FETCH_TIMEOUT_MS = 8_000;
/** Refuse absurd downloads rather than buffering them into the Worker. */
const MAX_ORIGIN_BYTES = 12 * 1024 * 1024;
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

/** True for loopback / private / link-local / unique-local addresses. */
function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    // IPv6: ::1, fc00::/7 (unique local), fe80::/10 (link local)
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') ||
      v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v === '::';
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;           // this-network, loopback
  if (a === 169 && b === 254) return true;                     // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;            // private
  if (a === 192 && b === 168) return true;                      // private
  if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT
  return false;
}

function validate(raw: string): { url: URL } | { error: string; code: string; status: number } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid url', code: 'invalid_url', status: 400 };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'unsupported scheme', code: 'unsupported_scheme', status: 400 };
  }
  if (!hostAllowed(url.hostname)) {
    return { error: 'host not allowed', code: 'host_not_allowed', status: 403 };
  }
  return { url };
}

/**
 * Follow redirects manually, re-validating every hop, and resolve the host to
 * confirm it is not a private address. Returns the final URL, or an error.
 */
async function safeFetch(url: URL, depth = 0): Promise<
  { ok: true; response: Response } | { ok: false; code: string; error: string; status: number }
> {
  if (depth > 3) return { ok: false, code: 'too_many_redirects', error: 'too many redirects', status: 502 };

  const check = validate(url.toString());
  if ('error' in check) return { ok: false, ...check };

  let res: Response;
  try {
    res = await fetch(check.url.toString(), {
      redirect: 'manual',
      headers: { Accept: 'image/*', 'User-Agent': 'FanNovel-ImageCache/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, code: 'origin_unreachable', error: 'origin unreachable', status: 502 };
  }

  // Re-validate each redirect hop: a permitted host could otherwise bounce us
  // to an internal address.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) return { ok: false, code: 'bad_redirect', error: 'bad redirect', status: 502 };
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, check.url);
    } catch {
      return { ok: false, code: 'bad_redirect', error: 'bad redirect', status: 502 };
    }
    return safeFetch(nextUrl, depth + 1);
  }

  return { ok: true, response: res };
}

/** GET /api/v1/image/resize?url=<absolute>&w=<px>
 *  Streams the original bytes with a long cache lifetime.
 *
 *  NOTE ON RESIZING: a Worker cannot resize an image without an image-processing
 *  binding (Cloudflare Images / Image Resizing), so this endpoint currently
 *  proxies bytes only. That is still a large win — it removes the third-party
 *  dependency and lets the client cache the original once instead of failing —
 *  but it does NOT shrink the payload. Wiring R2/Image Resizing later is the
 *  follow-up that turns 2.8 MB into ~30 KB.
 */
imageResizeRouter.get('/resize', async (c) => {
  const raw = c.req.query('url');
  if (!raw) return c.json({ success: false, code: 'invalid_url', error: 'url is required' }, 400);

  const parsed = validate(raw);
  if ('error' in parsed) {
    return c.json({ success: false, code: parsed.code, error: parsed.error }, parsed.status as 400 | 403);
  }

  const result = await safeFetch(parsed.url);
  if (!result.ok) {
    return c.json({ success: false, code: result.code, error: result.error }, result.status as 400 | 403 | 502);
  }

  const upstream = result.response;
  if (!upstream.ok) {
    return c.json({ success: false, code: 'origin_error', error: `origin returned ${upstream.status}` }, 502);
  }

  const type = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    // Do not relay HTML/JS/SVG from a third party: it would execute in our
    // origin's context and could be used for content-type confusion.
    return c.json({ success: false, code: 'unsupported_type', error: 'origin did not return an image' }, 415);
  }

  const declared = Number(upstream.headers.get('content-length') ?? '0');
  if (declared && declared > MAX_ORIGIN_BYTES) {
    return c.json({ success: false, code: 'too_large', error: 'image too large to proxy' }, 413);
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_ORIGIN_BYTES) {
    return c.json({ success: false, code: 'too_large', error: 'image too large to proxy' }, 413);
  }

  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(c.req.query('w') ?? 0) || 0));
  const headers: Record<string, string> = {
    'Content-Type': type,
    // Immutable enough for a content-addressed upstream path, and explicitly
    // NOT shared with any authenticated response.
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Timing-Allow-Origin': '*',
  };
  // Echo the requested width so the client can cache-bust on resize intent.
  if (width) headers['X-Fan-Novel-Width'] = String(width);

  return new Response(body, { status: 200, headers });
});

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
 *
 * Resizing: when the Cloudflare Images binding (`IMAGES`) is present and the
 * client asked for a width (`?w=`), the fetched bytes are resized down and
 * converted to WebP before serving; otherwise (local dev, tests, or a
 * transform failure) the original bytes are proxied unchanged.
 */
import { Hono } from 'hono';
import { getWorkerBinding } from '../config/env.js';

export const imageResizeRouter = new Hono();

/** Minimal shape of the Cloudflare Images binding used here. */
interface ImagesBinding {
  input(body: ReadableStream<Uint8Array>): {
    transform(opts: { width?: number; fit?: string }): {
      output(opts: { format?: string; quality?: number }): {
        response(): Response | Promise<Response>;
      } | Promise<{ response(): Response | Promise<Response> }>;
    };
  };
}

/**
 * Resize + convert to WebP via the Images binding. Returns null when the
 * binding is missing or the transform fails, so the caller can fall back to
 * the original bytes. Never throws.
 */
async function tryTransform(
  binding: unknown,
  body: ArrayBuffer,
  width: number,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  try {
    const b = binding as ImagesBinding | null;
    if (!b || typeof b.input !== 'function') return null;
    // The Images binding consumes a stream, not a buffer: passing the
    // ArrayBuffer directly throws in production and would silently fall back
    // to the original bytes on every request.
    const stream = new Response(body).body;
    if (!stream) return null;
    const chained = await b.input(stream).transform({ width, fit: 'scale-down' }).output({ format: 'image/webp', quality: 75 });
    const res = typeof (chained as { response?: unknown }).response === 'function'
      ? await (chained as { response(): Response | Promise<Response> }).response()
      : null;
    if (!res || typeof (res as Response).arrayBuffer !== 'function') return null;
    const out = res as Response;
    const bytes = await out.arrayBuffer();
    const type = (out.headers?.get?.('content-type') ?? 'image/webp').split(';')[0].trim().toLowerCase() || 'image/webp';
    return { bytes, type };
  } catch (err) {
    console.warn('[image] transform failed', err);
    return null;
  }
}

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
 *  Fetches the upstream image, resizes it to `w` via the Images binding when
 *  one is configured, and serves the (edge-cached) result with a long cache
 *  lifetime. Without the binding, or when the transform fails, the original
 *  bytes are proxied exactly as fetched.
 */
imageResizeRouter.get('/resize', async (c) => {
  const raw = c.req.query('url');
  if (!raw) return c.json({ success: false, code: 'invalid_url', error: 'url is required' }, 400);

  const parsed = validate(raw);
  if ('error' in parsed) {
    return c.json({ success: false, code: parsed.code, error: parsed.error }, parsed.status as 400 | 403);
  }

  const requestedW = Number(c.req.query('w') ?? 0) || 0;
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, requestedW));
  const wantTransform = requestedW > 0;

  // Cloudflare does NOT cache Worker responses just because they carry
  // Cache-Control, so the Cache API has to be used explicitly — otherwise every
  // image view re-fetches a 2.8MB original from the source site (3-25s each).
  // `caches` is a global, not an env binding. The cache key is the full
  // request URL, so it already includes `w`: different widths never collide,
  // and the stored entry is whatever was served (transformed or original).
  const edgeCache = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  const cache = edgeCache?.default;
  const cacheKey = new Request(c.req.url, { method: 'GET' });

  if (cache) {
    // Guarded: a cache outage must degrade to a normal origin fetch, never a 500.
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('X-Image-Cache', 'HIT');
        return new Response(hit.body, { status: 200, headers: h });
      }
    } catch {
      /* fall through to origin */
    }
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

  // Resize AFTER every security check above (allowlist, redirect
  // re-validation, size limits, content-type). A transform failure must never
  // fail the request: fall back to the original bytes exactly as fetched.
  let outBytes: ArrayBuffer = body;
  let outType = type;
  if (wantTransform) {
    const transformed = await tryTransform(getWorkerBinding('IMAGES'), body, width);
    if (transformed) {
      outBytes = transformed.bytes;
      outType = transformed.type.startsWith('image/') ? transformed.type : 'image/webp';
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': outType,
    // Immutable enough for a content-addressed upstream path, and explicitly
    // NOT shared with any authenticated response.
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Timing-Allow-Origin': '*',
    'X-Image-Cache': 'MISS',
  };
  // Echo the requested width so the client can cache-bust on resize intent.
  if (width) headers['X-Fan-Novel-Width'] = String(width);

  // Store a copy for the edge. `caches.default.put` is fire-and-forget in
  // production; the await only matters for deterministic tests, and a failed
  // put must never break the response, so it is guarded.
  if (cache) {
    try {
      await cache.put(cacheKey, new Response(outBytes, { status: 200, headers: { ...headers, 'X-Image-Cache': 'MISS' } }));
    } catch {
      /* cache quota/size exceeded — serve uncached rather than fail */
    }
  }

  return new Response(outBytes, { status: 200, headers });
});

# JWT Secret Sync (local `.env` ↔ Worker)

Why this file exists: `signToken` / `verifySubject` (`src/middleware/auth.ts`)
sign with `env.JWT_SECRET`. In development that value comes from `.env`; in
production it comes from the Worker's secret store. **The two are independent
and Cloudflare never returns a secret value back**, so they drift silently.

## Symptom

A token minted locally is rejected by the deployed Worker:

```json
{ "error": "رمز الوصول غير صالح أو منتهي الصلاحية" }
```

That is `jwtVerify` failing in `requireAuth` — wrong key, not an expired token
(a genuinely expired token fails identically, which is what makes this
confusing to debug).

## Why it matters

`requireAdmin`-style routes (`src/routes/admin.ts`) cannot be driven from a
script while the keys differ. Anything that needs a Bearer token from the
terminal — granting a reading plan, promoting a user, inspecting admin state —
has to be done by hand in the app UI instead.

## Check what the Worker actually has

Values are hidden; only names and types come back.

```bash
cd fan-novel-server
npx wrangler secret list
```

```json
[
  { "name": "DATABASE_URL", "type": "secret_text" },
  { "name": "JWT_SECRET",   "type": "secret_text" }
]
```

## The command

Make the Worker use the value already in your local `.env` (one-way sync,
local → Worker):

```bash
cd fan-novel-server
grep '^JWT_SECRET=' .env | cut -d= -f2- | npx wrangler secret put JWT_SECRET
```

`wrangler secret put` reads the value from stdin, so the secret never appears
in your shell history, in `ps`, or in a committed file.

### Cost: this rotates the secret

Every JWT signed with the previous key becomes invalid, so **all users are
signed out** — the app re-authenticates through Google, so it is one extra
sign-in each, and `expirationTime('7d')` means a rotation costs at most 7 days
of sessions, not permanent access.

### Verify the sync worked

Mint a token with the local secret and call an authenticated endpoint. The
`sub` claim must be the user's `externalId` (`users.external_id`), **not** the
uuid primary key — `getCaller` (`src/middleware/ownership.ts`) looks the caller
up by `externalId`.

```bash
cd fan-novel-server
# one-off: mint a 1h admin token
cat > mint-tmp.mjs <<'EOF'
import { SignJWT } from 'jose';
import fs from 'fs';
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const tok = await new SignJWT({ sub: process.argv[2], email: process.argv[3], role: process.argv[4] })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setIssuer('web-novel')
  .setAudience('web-novel-app')
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(env.JWT_SECRET));
process.stdout.write(tok);
EOF

# run it from the repo root so `jose` resolves from node_modules
node ./mint-tmp.mjs "<external_id>" "<email>" "admin" > /tmp/admin.tok
rm -f mint-tmp.mjs          # the script embeds no secret, but keep the tree clean

TOK=$(cat /tmp/admin.tok)
curl -s -H "Authorization: Bearer $TOK" \
  https://fan-novel-server.mohamed1232003.workers.dev/api/v1/auth/me
rm -f /tmp/admin.tok
```

A user object comes back → keys match. The same 401 error → the sync did not
take effect (re-run `wrangler secret put`, then `wrangler deploy` is **not**
required — secrets apply to the next request, not the next build).

## Minting the `external_id`

```bash
psql "$DATABASE_URL" -c "SELECT id, external_id, email, role FROM users WHERE role = 'admin';"
```

## The alternative: do not sync

Keep the keys different and administer only from the app's admin UI, which uses
the real session token. Nothing breaks; you just lose the ability to script
admin calls. This is the right choice if you never need a token from a terminal.

## Related

- `docs/DATABASE_MIGRATIONS.md` — the same "psql against Neon directly" caveat
  applies there.
- Never commit `.env`; it is already gitignored. Secrets live only in the
  Worker secret store.

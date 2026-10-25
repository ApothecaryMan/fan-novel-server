# Protection deploy checklist

Single dev, pre-release hard cutover.

## Deploy order
1. `fan-novel-server`: deploy Worker with `DECORATIONS` binding (`fan-novel-assets`), `COVERS`, `RELEASES`.
2. Cloudflare R2 `fan-novel-assets` public `r2.dev` OFF. Confirm direct `https://pub-.../fan_avatar/x.png` fails.
3. `Fan Novel`: ship client (Worker gateway only, no `r2.dev` in bundle).

## Verify
- `GET /api/v1/decorations/thumb?key=fan_avatar%2Fwater_frame_slow.png` 200 public, `Cache-Control: public, max-age=3600`.
- `GET /api/v1/decorations/sign` without token 401; with token 200, `expiresIn<=300`.
- `GET /api/v1/decorations/file` with fresh sig 200 private; replay after expiry 401.
- `POST /api/v1/upload/image` anonymous in prod 401.
- Prod CORS: unknown Origin gets no `Access-Control-Allow-Origin: *`.
- Visitor sheets (comments, leaderboard) show frames/effects via gateway; guest sees thumbs, no token needed.
- `wrangler secret list` shows `JWT_SECRET,DATABASE_URL`; `CORS_ORIGIN` not `*` in prod.
- Rate flood on `/sign` observes 429; normal sheet opens stay under limit.

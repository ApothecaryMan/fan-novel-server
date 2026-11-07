export const CONTACT_EMAIL = 'mohamedrezk.ph@gmail.com';
export const EFFECTIVE_DATE = '7 November 2026';
export const APP_NAME = 'Fan Novel';
export const ANDROID_PACKAGE = 'com.webnovel.reader';
export const PUBLISHER = "Apothecary's Team";

export function renderLegalPage(title: string, arHtml: string, enHtml: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — ${APP_NAME}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", Tahoma, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; line-height: 1.7; background: #fff; color: #1a1a1a; }
h1 { font-size: 1.6rem; line-height: 1.4; }
h2 { font-size: 1.15rem; margin-top: 1.8em; }
p, li { font-size: 1rem; }
ul { padding-inline-start: 1.4em; }
.meta { color: #555; font-size: 0.9rem; }
a { color: #0b5fff; }
hr { margin: 2.5em 0; border: 0; border-top: 1px solid #ccc; }
@media (prefers-color-scheme: dark) {
  body { background: #121212; color: #e8e8e8; }
  .meta { color: #aaa; }
  a { color: #8ab4ff; }
  hr { border-top-color: #444; }
}
</style>
</head>
<body>
<main>${arHtml}</main>
<hr />
<section lang="en" dir="ltr">${enHtml}</section>
</body>
</html>`;
}

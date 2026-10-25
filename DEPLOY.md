# SC Case Alerts — Deployment Guide (Cloudflare Pages)

A small web app that watches the Supreme Court of India's live display board and alerts you
(sound, vibration, pop-up notification) as your case gets close. No build step and no npm
dependencies: static files in `public/`, three small Cloudflare Pages Functions in `functions/`.

## How it fits together

| Path | What it does |
|---|---|
| `/` (`public/`) | The app. Polls `/api/board` every 10 s and `/api/coram` every 5 min. Cases are saved in the browser. |
| `/api/board` (`functions/api/board.js`) | Fetches `cdb.sci.gov.in` (JSON), normalizes it. Edge-cached for `CACHE_TTL_SECONDS`. Courts 21/22 are returned as `RC1`/`RC2` (Registrar Courts). |
| `/api/coram` (`functions/api/coram.js`) | Scrapes the bench (judges) from `wdb.sci.gov.in` (HTML). Edge-cached 5 min. |
| `/healthz` (`functions/healthz.js`) | Returns `{"ok":true}`. |
| `functions/_middleware.js` | Optional password for the whole site (see `AUTH_USER` / `AUTH_PASS`). |

**Important limit:** alerts only work while the page is open (another tab is fine). Browsers may
slow down checks in background tabs, and a locked phone may pause the page; the app offers a
"Keep screen on" switch where the browser supports it. On iPhone/iPad, notifications only work
after "Add to Home Screen". There is no server-side push.

---

## Deploy

1. Push this repository to GitHub/GitLab.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick the repo.
3. Build settings:
   - **Framework preset**: None
   - **Build command**: *(leave empty)*
   - **Build output directory**: `public`
4. **Save and Deploy**. The `functions/` folder at the repo root is picked up automatically.

### Environment variables (Settings → Variables)

| Variable | Default | Purpose |
|---|---|---|
| `COURTS_CSV` | `1,…,17,21,22` | Courts requested from SCI |
| `CACHE_TTL_SECONDS` | `8` | Edge cache for `/api/board` |
| `AUTH_USER` + `AUTH_PASS` | *(unset = open)* | Set **both** to password-protect the whole site. `/healthz`, the manifest, icons and `sw.js` stay open. |

After changing variables, redeploy (Deployments → Retry deployment).

### Verify

- [ ] Home page loads, "Live · checked at …" appears under the header
- [ ] `/api/board` returns JSON with a `courts` object
- [ ] `/healthz` returns `{"ok":true}`
- [ ] Add a case, press **Test my alerts**: you hear beeps and see notifications
- [ ] On a phone, "Add to Home Screen" installs the app

---

## Local development

Needs a recent Node.js (tests were run with Node 22.22; older versions may not load the `.js` modules without a `package.json`).

```bash
npx wrangler pages dev public      # http://localhost:8788 (reads [vars] from wrangler.toml)
node --test                        # unit tests in tests/
```

For a local password, create `.dev.vars` (git-ignored):

```
AUTH_USER=test
AUTH_PASS=test
```

## When you change the app

- Shell files (`index.html`, `app.js`, `logic.js`, `style.css`, icons) are cached by the service
  worker. **Bump `CACHE_NAME` in `public/sw.js`** whenever you change them; the page itself is
  fetched network-first, so new deploys show up on the next load.
- Logic that decides a case's status lives in `public/logic.js` and is covered by `tests/logic.test.mjs`.
- The SCI parsers (`parseSequence`, `extractCourtLinks`, `parseCoramFromDetail`) are written against
  formats seen so far; if SCI changes its pages, start with `tests/board.test.mjs` / `tests/coram.test.mjs`.

## Troubleshooting

| Issue | Fix |
|---|---|
| "Court board is not responding" | `cdb.sci.gov.in` is down or slow; `/api/board` returns 502/500. Check `COURTS_CSV`. |
| Bench (judges) missing | `/api/coram` could not read `wdb.sci.gov.in`; the rest of the app still works. |
| Password prompt never appears | Set **both** `AUTH_USER` and `AUTH_PASS`, then redeploy. |
| No notifications | The Alerts box shows the exact state and how to fix it (allow in browser settings; on iPhone add to Home Screen first). |
| No sound | Browsers allow sound only after one tap on the page; check the Sound switch is on. |
| Old version after deploy | Reload once; if it persists, bump `CACHE_NAME` in `public/sw.js`. |

## Files

```
functions/
  _middleware.js        optional site password
  api/board.js          /api/board
  api/coram.js          /api/coram
  healthz.js            /healthz
public/
  index.html  style.css  app.js  logic.js  sw.js  manifest.webmanifest  icons/
tests/                  node --test
wrangler.toml           local dev vars
```

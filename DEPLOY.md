# SC Case Alert System — Cloudflare Pages Deployment Guide

## What Changed from Express → Cloudflare Pages

| Component | Express (original) | Cloudflare Pages |
|---|---|---|
| Static files | `express.static('public')` | Served automatically from `public/` |
| API `/api/board` | Express route in `server.js` | `functions/api/board.js` (Pages Function) |
| Caching | In-memory JS variable | Cloudflare Edge Cache API |
| Auth | `Buffer.from(token, 'base64')` | `atob(token)` (Workers-compatible) |
| Env vars | `.env` file + `dotenv` | Cloudflare dashboard (Settings → Variables) |
| Runtime | Node.js 18+ | Cloudflare Workers (V8 isolate) |

**No npm dependencies needed** — the Pages Function is pure JavaScript.

---

## Prerequisites

- A free Cloudflare account (https://dash.cloudflare.com/sign-up)
- Git installed locally
- Node.js 18+ (only needed for local testing with Wrangler)

---

## Step-by-Step Deployment

### STEP 1 — Push to GitHub/GitLab

```bash
cd sc-deploy
git init
git add .
git commit -m "Initial: SC Case Alerts for Cloudflare Pages"
git remote add origin https://github.com/YOUR_USERNAME/sc-case-alerts.git
git push -u origin main
```

### STEP 2 — Create a Cloudflare Pages Project

1. Go to https://dash.cloudflare.com
2. Left sidebar → **Workers & Pages**
3. Click **Create**
4. Tab: **Pages** → **Connect to Git**
5. Authorize GitHub/GitLab if prompted
6. Select your **sc-case-alerts** repository
7. Configure build settings:
   - **Project name**: `sc-case-alerts` (this becomes your subdomain)
   - **Production branch**: `main`
   - **Framework preset**: `None`
   - **Build command**: *(leave empty — no build step needed)*
   - **Build output directory**: `public`
8. Click **Save and Deploy**

### STEP 3 — Set Environment Variables

After the first deploy:

1. Go to your Pages project in the dashboard
2. **Settings** → **Environment Variables**
3. Add these variables for **Production** (and optionally Preview):

| Variable | Value | Required? |
|---|---|---|
| `COURTS_CSV` | `1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,21,22` | Optional (has default) |
| `CACHE_TTL_SECONDS` | `8` | Optional (has default) |
| `AUTH_USER` | your-username | Optional (skip = open access) |
| `AUTH_PASS` | your-password | Optional (skip = open access) |

4. Click **Save**
5. Go to **Deployments** → click **⟳ Retry deployment** on the latest deployment (so it picks up the new vars)

### STEP 4 — Add Your Custom Icons (Optional)

Replace the placeholder icons:
- `public/icons/icon-192.png` (192×192 px)
- `public/icons/icon-512.png` (512×512 px)

Commit and push — Cloudflare auto-deploys on every push.

### STEP 5 — Verify

Your app is now live at:
```
https://sc-case-alerts.pages.dev
```

Test these:
- [ ] Homepage loads with the ticker and court tiles
- [ ] `/api/board` returns JSON data from SCI
- [ ] `/healthz` returns `{"ok":true}`
- [ ] Notifications work (click Test after entering a matter)
- [ ] PWA install prompt appears on mobile

---

## Optional: Custom Domain

1. Pages project → **Custom Domains**
2. Click **Set up a custom domain**
3. Enter your domain (e.g., `alerts.yourdomain.com`)
4. Cloudflare auto-provisions SSL (takes ~2 minutes)

---

## Optional: Local Development

```bash
# Install Wrangler (Cloudflare's CLI)
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Run locally (serves public/ and functions/)
npx wrangler pages dev public

# App runs at http://localhost:8788
```

For auth testing locally, create `.dev.vars`:
```
AUTH_USER=test
AUTH_PASS=test
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `/api/board` returns 502 | Check if `cdb.sci.gov.in` is accessible; verify COURTS_CSV value |
| Auth not working | Ensure both AUTH_USER and AUTH_PASS are set; redeploy after adding vars |
| Notifications don't fire | Allow notifications in browser; click any button first (audio policy) |
| Stale data | Cache TTL is 8s by default; hard-refresh or wait |
| Functions not running | Verify `functions/` directory is at repo root (not inside `public/`) |
| "Build output directory" error | Must be set to `public` (not `.` or `dist`) |

---

## File Structure Reference

```
sc-case-alerts/
├── functions/            ← Cloudflare Pages Functions (API)
│   ├── api/
│   │   └── board.js      ← /api/board endpoint
│   └── healthz.js        ← /healthz endpoint
├── public/               ← Static site (served as root)
│   ├── icons/
│   │   ├── icon-192.png
│   │   └── icon-512.png
│   ├── app.js
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── style.css
│   └── sw.js
├── .gitignore
└── wrangler.toml         ← Local dev config
```

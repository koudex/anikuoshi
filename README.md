# AniKuoshi — Anime Streaming PWA

<div align="center">

**空** · A mobile-first anime streaming Progressive Web App with a hidden, fully interactive API playground — built directly on top of **AniKotoAPI**.

Server-rendered (EJS + htmx) · 8 color themes · embed-first playback · watch-progress sync · installable · offline-aware

</div>

---

## ⚡ What is this?

AniKuoshi is a complete streaming site + REST API in **one Express server**:

| Layer | What you get |
|---|---|
| **Web app** (`/`) | Home with spotlight hero & lazy rows, browse with filters, search with live suggestions, anime details (episodes/seasons/related/recommendations), full player, schedule, A–Z list, history, settings |
| **REST API** (`/api/*`) | The original AniKotoAPI v2 — 38 endpoints, untouched behavior, all documented |
| **Hidden docs** (`/docs`) | Docs + playground in one — every endpoint documented **and** executable in-page. No nav links, `noindex`, exists only at the URL |

The client never scrapes anything: **all resolution happens server-side** and the browser receives rendered HTML / htmx fragments only.

## 🚀 Quick Start

```bash
npm install
npm start            # → http://localhost:4444
```

No database, no build step, no API keys required.

## 📺 Playback

- **Embed-first**: the player uses the upstream **megaplay embed** in an iframe — no m3u8 proxying, no CORS hassle.
- **Multi-server**: all sub/dub servers resolved server-side; switching servers re-resolves via htmx without a full page load.
- **Resume**: saved positions are passed to the embed via `?time=&unix=` — you continue exactly where you stopped.
- **Skip data**: upstream intro/outro timestamps power the Skip Intro/Outro buttons (keyboard `I` / `O`), with optional auto-skip.
- **Toggles**: Auto-next · Autoplay · Auto-skip intro/outro — persisted per device, defaults editable in Settings.
- **Schedule**: next-episode countdown is pulled live from the watch page.

## 🔄 Progress-watch sync

Every ~12s of viewing (and on tab hide / page exit, via `sendBeacon`) the player posts progress to `/fragments/progress`, keyed by an **anonymous httpOnly device cookie**. History shows resume cards on Home, `/history`, and the anime page ("Resume EP N"). No accounts, no tracking.

## 🎨 Themes

Midnight (default dark) · Carbon (OLED) · Ocean · Nebula · Sunset · Sakura · Matcha · Paper.
Theme is rendered server-side from a cookie — **zero flash of wrong theme**. Cycle with `T` or pick in Settings.

## ⌨️ Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus search |
| `N` / `P` | Next / previous episode (player) |
| `S` | Jump to servers panel |
| `E` | Toggle episodes drawer |
| `I` / `O` | Skip intro / outro |
| `T` | Cycle theme |
| `?` | Shortcut help |
| `Esc` | Close dialogs |

## 📱 PWA

Installable (Settings → *Install AniKuoshi app* or the browser install prompt). Service worker: static assets cache-first, pages network-first with offline fallback, fragments stale-while-revalidate, `/api/*` always live. Includes maskable icons, app shortcuts (Browse / Schedule / History) and an offline page.

## 🔒 Security model

- **SSR-only rendering** — scrapers, tokens and resolution logic never reach the client; the only third-party URL exposed is the final iframe `src`.
- **Strict CSP** — `script-src 'self'` (zero inline scripts, htmx vendored locally), `frame-src https:` for embed players, no `unsafe-eval`.
- **Input validation** — slugs, episode numbers, tokens and device ids are regex-validated before touching the scraper layer; progress payloads are length- and type-capped.
- **Rate limiting** — global API limiter (100/min/IP default) + a dedicated limiter on progress writes.
- **Anti-abuse fragments** — fragment endpoints check `Sec-Fetch-Site` / `HX-Request` headers.
- **Anonymous history** — no accounts; device ids are random 256-bit values in httpOnly cookies; JSON store capped (5k devices × 200 entries, 120-day TTL) in `data/`.

## 🛡️ Unblock notes (free)

Metadata endpoints scrape HTML and work out of the box. Streaming/AJAX endpoints can be blocked when running from datacenter IPs. Free fixes:

1. **Mirrors** — automatic failover across 5 domains (built in).
2. **FlareSolverr** (free, self-hosted) — `docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr` then set `FLARESOLVERR_URL=http://localhost:8191`. Check readiness at `/api/proxy/status`.
3. ScraperAPI (paid) — optional, set `SCRAPER_API_KEY`.

If a stream is still blocked, the player shows a clear explanation with a retry button instead of failing silently.

## 🗂️ Project layout

```
anikuoshi/
├── server.js                 # Express entry — API + web + PWA in one
├── src/                      # AniKotoAPI v2 engine (scrapers, cache, mirrors, proxies)
├── web/
│   ├── web.routes.js         # pages, htmx fragments, progress API, hidden /docs
│   ├── services/             # extractor orchestration → page models
│   └── store/history.store.js# device-keyed watch-progress store (JSON file)
├── views/                    # EJS templates (layout, pages, partials, docs)
├── public/
│   ├── css/anikuoshi.css     # design system + 8 themes
│   ├── js/                   # app, player, settings, docs playground
│   ├── htmx.min.js           # vendored (no CDN)
│   ├── manifest.webmanifest  # PWA manifest
│   └── sw.js                 # service worker
└── data/                     # auto-created — watch history store (gitignored)
```

## ⚙️ Configuration (`.env`)

See `.env.example` — port, rate limits, cache TTL, mirrors, proxies. All optional; sane defaults included.

## 📖 API

All 38 endpoints are documented **and live-executable** at `/docs` (hidden route). Machine-readable OpenAPI: `/api/openapi`. Health: `/api/health`.

## 🙏 Credits

- **[AniKotoAPI](https://github.com/Shineii86/AniKotoAPI)** by **Shinei Nouzen** — the entire API engine (MIT). AniKuoshi's web layer is built directly on it.
- All anime data, images and content belong to their respective owners. Educational purposes only — run your own instance, respect your local laws.

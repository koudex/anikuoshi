/*
 * AniKuoshi — web/web.routes.js
 * ------------------------------------------------------------------
 * All server-rendered pages + htmx fragment endpoints of the AniKuoshi PWA.
 *
 * Security model:
 *  - Everything is resolved server-side; the browser only ever receives
 *    HTML (pages) or HTML fragments (htmx). No upstream scraping URLs,
 *    tokens or API shapes are exposed except the final embed src.
 *  - Every route parameter is strictly validated before use.
 *  - Device history is keyed by an httpOnly, sameSite=lax cookie.
 *  - /docs is noindexed and intentionally not linked anywhere.
 */
import express from "express";
import crypto from "crypto";
import {
  getSpotlightModel, getListModel, getSearchModel, getSuggestions,
  getBrowseModel, getAzListModel, getScheduleModel, getAnimeModel,
  getWatchModel, resolveStream, getMapperServers, FILTER_OPTIONS, cleanSlug,
} from "./services/anikuoshi.service.js";
import * as history from "./store/history.store.js";

// ══════════════════════════════════════════════════════════════
// CONSTANTS + VALIDATION HELPERS
// ══════════════════════════════════════════════════════════════

export const THEMES = [
  { id: "midnight", name: "Midnight",  mode: "dark",  swatch: ["#0b0e14", "#7c5cff"] },
  { id: "carbon",   name: "Carbon",    mode: "dark",  swatch: ["#000000", "#4ade80"] },
  { id: "ocean",    name: "Ocean",     mode: "dark",  swatch: ["#071a2b", "#22d3ee"] },
  { id: "nebula",   name: "Nebula",    mode: "dark",  swatch: ["#120b1e", "#f472b6"] },
  { id: "sunset",   name: "Sunset",    mode: "dark",  swatch: ["#1a0f0d", "#fb923c"] },
  { id: "sakura",   name: "Sakura",    mode: "light", swatch: ["#fff5f7", "#f43f8e"] },
  { id: "matcha",   name: "Matcha",    mode: "light", swatch: ["#f4f9f1", "#3f9142"] },
  { id: "paper",    name: "Paper",     mode: "light", swatch: ["#fafaf7", "#b45309"] },
];

const THEME_IDS = THEMES.map(t => t.id);
const SLUG_RE = /^[a-z0-9-]{1,140}$/;
const NUM_RE = /^\d{1,6}$/;

const validSlug = (s) => typeof s === "string" && SLUG_RE.test(s);
const validEp = (e) => NUM_RE.test(String(e));
const toPage = (p) => {
  const n = parseInt(p, 10);
  return Number.isFinite(n) && n >= 1 && n <= 2000 ? n : 1;
};

const RES = {
  azLetters: ["0-9", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "other"],
  listKeys: ["trending", "top-ten", "most-popular", "new-release", "recently-updated", "upcoming", "completed", "top-rankings"],
};

/** Sanitize an upstream string for safe HTML attribute/text interpolation. */
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Render a page view into the site layout (tiny dependency-free layout engine). */
const renderPage = (res, view, data = {}, status = 200) => {
  res.status(status).render(view, { ...data, layout: false }, (err, body) => {
    if (err) {
      console.error("[AK-VIEW]", view, err.message);
      return res.status(500).send("<h1>Something went wrong rendering this page.</h1>");
    }
    res.render("layout", { ...data, body, layout: false }, (err2, html) => {
      if (err2) {
        console.error("[AK-LAYOUT]", err2.message);
        return res.status(500).send("<h1>Something went wrong rendering this page.</h1>");
      }
      res.status(status).send(html);
    });
  });
};


// ══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════════════

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 24 * 3600 * 1000 };

/**
 * Assigns the anonymous device cookie + theme cookie locals.
 * The theme cookie is intentionally NOT httpOnly so no extra roundtrip
 * is needed; it only holds a theme id (no security value).
 */
const deviceAndTheme = (req, res, next) => {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map(c => {
      const i = c.indexOf("=");
      return i > 0 ? [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())] : ["", ""];
    })
  );
  req.deviceId = cookies.ak_device || "";
  if (!history.isValidDeviceId(req.deviceId)) {
    req.deviceId = history.newDeviceId();
    res.setHeader("Set-Cookie", `ak_device=${req.deviceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 3600}`);
  }
  req.theme = THEME_IDS.includes(cookies.ak_theme) ? cookies.ak_theme : "midnight";
  res.locals.theme = req.theme;
  res.locals.deviceId = req.deviceId;
  next();
};

/** Basic guard for htmx fragment endpoints: same-origin-ish requests only. */
const fragmentGuard = (req, res, next) => {
  const secFetchSite = req.headers["sec-fetch-site"];
  const isHx = req.headers["hx-request"] === "true";
  // Browsers send sec-fetch-site; non-browser clients allowed only with HX header
  if (secFetchSite && !["same-origin", "same-site", "none"].includes(secFetchSite)) {
    return res.status(403).send("Forbidden");
  }
  if (!isHx && secFetchSite === "cross-site") return res.status(403).send("Forbidden");
  next();
};

/** Tiny in-memory rate limiter for the progress endpoint. */
const progressHits = new Map();
const progressRateLimit = (req, res, next) => {
  const now = Date.now();
  const key = req.deviceId;
  const arr = (progressHits.get(key) || []).filter(t => now - t < 60000);
  arr.push(now);
  progressHits.set(key, arr);
  if (arr.length > 90) return res.status(429).send("Slow down");
  next();
};

// ══════════════════════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════════════════════

export const createWebRoutes = (app) => {
  app.use(deviceAndTheme);

  const router = express.Router();

  // ---------- PAGES ----------

  router.get("/", async (req, res) => {
    const [spotlight, continueWatching] = await Promise.all([
      getSpotlightModel(),
      Promise.resolve(history.getHistory(req.deviceId).slice(0, 12)),
    ]);
    renderPage(res, "pages/home", {
      title: "AniKuoshi — Watch Anime Online, Free and in HD",
      spotlight: spotlight.error ? [] : spotlight,
      spotlightError: !!spotlight.error,
      continueWatching,
      layout: "layout",
    });
  });

  router.get("/browse", async (req, res) => {
    const filters = {
      genre: FILTER_OPTIONS.genres.includes(req.query.genre) ? req.query.genre : "",
      status: FILTER_OPTIONS.statuses.includes(req.query.status) ? req.query.status : "",
      year: /^(19|20)\d{2}s?$/.test(String(req.query.year)) ? req.query.year : "",
      sort: FILTER_OPTIONS.sorts.includes(req.query.sort) ? req.query.sort : "default",
    };
    const page = toPage(req.query.page);
    if (req.headers["hx-request"] === "true") {
      const model = await getBrowseModel(filters, page);
      return res.render("partials/grid-page", {
        data: model.data || [], totalPages: model.totalPages || 1,
        currentPage: model.currentPage || 1, error: model.error,
        basePath: "/browse", query: filters, layout: false,
      });
    }
    renderPage(res, "pages/browse", {
      title: "Browse Anime — AniKuoshi",
      filters, page, options: FILTER_OPTIONS, layout: "layout",
    });
  });

  router.get("/search", async (req, res) => {
    const q = String(req.query.q || "").slice(0, 100).trim();
    const page = toPage(req.query.page);
    if (req.headers["hx-request"] === "true") {
      const model = await getSearchModel(q, page);
      return res.render("partials/grid-page", {
        data: model.data || [], totalPages: model.totalPages || 1,
        currentPage: model.currentPage || 1, error: model.error,
        basePath: "/search", query: { q }, layout: false,
      });
    }
    renderPage(res, "pages/search", {
      title: q ? `Search: ${q} — AniKuoshi` : "Search — AniKuoshi",
      q, page, layout: "layout",
    });
  });

  router.get("/anime/:slug", async (req, res) => {
    if (!validSlug(req.params.slug)) return renderPage(res, "pages/error", { title: "Bad request", code: 400, message: "Invalid anime id." }, 400);
    const model = await getAnimeModel(req.params.slug);
    if (model.error) {
      return renderPage(res, "pages/error", { title: "Not found", code: 404, message: "We couldn't find that anime." }, 404);
    }
    renderPage(res, "pages/anime", {
      title: `${model.info.title} — AniKuoshi`,
      model, layout: "layout",
      resume: history.getEntry(req.deviceId, req.params.slug),
    });
  });

  router.get("/watch/:slug/:ep?", async (req, res) => {
    const slug = String(req.params.slug || "");
    if (!validSlug(slug)) return renderPage(res, "pages/error", { title: "Bad request", code: 400, message: "Invalid anime id." }, 400);
    const ep = validEp(req.params.ep || 1) ? parseInt(req.params.ep, 10) : 1;
    const model = await getWatchModel(slug, ep);
    if (model.error) {
      return renderPage(res, "pages/error", { title: "Not found", code: 404, message: "Episode unavailable. Try another server or episode." }, 404);
    }
    renderPage(res, "pages/watch", {
      title: `Watch ${model.title} Ep ${model.episodeNumber} — AniKuoshi`,
      model, layout: "layout",
      saved: history.getEntry(req.deviceId, slug),
    });
  });

  router.get("/history", (req, res) => {
    renderPage(res, "pages/history", { title: "Continue Watching — AniKuoshi", layout: "layout" });
  });

  router.get("/settings", (req, res) => {
    renderPage(res, "pages/settings", {
      title: "Settings — AniKuoshi",
      themes: THEMES, currentTheme: req.theme, layout: "layout",
    });
  });

  router.get("/schedule", async (req, res) => {
    // today in UTC+8-ish default; the upstream uses US-ish weekly layout keyed by date
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() + i * 86400000);
      days.push(d.toISOString().slice(0, 10));
    }
    const selected = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? req.query.date : days[0];
    renderPage(res, "pages/schedule", {
      title: "Schedule — AniKuoshi", days, selected, layout: "layout",
    });
  });

  router.get("/offline", (req, res) => {
    res.render("pages/offline", { title: "Offline — AniKuoshi", layout: false });
  });

  router.get("/az-list", (req, res) => {
    renderPage(res, "pages/azlist", { title: "A–Z List — AniKuoshi", letters: RES.azLetters, layout: "layout" });
  });

  router.get("/az-list/:letter", async (req, res) => {
    const letter = /^[0-9A-Za-z-]{1,6}$/.test(req.params.letter) ? req.params.letter : "A";
    const page = toPage(req.query.page);
    if (req.headers["hx-request"] === "true") {
      const model = await getAzListModel(letter, page);
      return res.render("partials/grid-page", {
        data: model.data || [], totalPages: model.totalPages || 1,
        currentPage: model.currentPage || 1, error: model.error,
        basePath: `/az-list/${letter}`, query: {}, layout: false,
      });
    }
    renderPage(res, "pages/azlist-letter", {
      title: `A-Z: ${letter} — AniKuoshi`, letter, page, letters: RES.azLetters, layout: "layout",
    });
  });

  // ---------- FRAGMENTS (htmx) ----------

  const frag = express.Router();
  frag.use(fragmentGuard);

  // lazy home rows
  frag.get("/home-section/:key", async (req, res) => {
    const key = RES.listKeys.includes(req.params.key) ? req.params.key : null;
    if (!key) return res.status(404).send("");
    const page = toPage(req.query.page);
    const model = await getListModel(key, page);
    res.render("partials/row-items", {
      key, data: model.data || [], error: model.error, layout: false,
    });
  });

  // search suggestions dropdown
  frag.get("/suggest", async (req, res) => {
    const q = String(req.query.q || "").slice(0, 80);
    const items = await getSuggestions(q);
    res.render("partials/suggest-items", { items, q, layout: false });
  });

  // schedule day fragment
  frag.get("/schedule-day", async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? req.query.date : null;
    if (!date) return res.status(400).send("");
    const model = await getScheduleModel(date);
    res.render("partials/schedule-day", {
      date, items: model.error ? [] : model, error: model.error, layout: false,
    });
  });

  // episode list chunk (player drawer + anime page tabs)
  frag.get("/episodes/:slug", async (req, res) => {
    if (!validSlug(req.params.slug)) return res.status(400).send("");
    const page = toPage(req.query.page);
    const per = 100;
    const model = await getAnimeModel(req.params.slug);
    const eps = model.error ? [] : model.episodes;
    const totalPages = Math.max(1, Math.ceil(eps.length / per));
    const chunk = eps.slice((page - 1) * per, page * per);
    res.render("partials/episode-items", {
      slug: req.params.slug, chunk, page, totalPages, total: eps.length,
      currentEp: toPage(req.query.current) || 0, layout: false,
    });
  });

  // stream resolver fragment — server switch / episode switch inside player
  frag.get("/stream", async (req, res) => {
    const slug = validSlug(req.query.slug) ? req.query.slug : "";
    const linkId = String(req.query.linkId || "");
    const ep = validEp(req.query.ep || 1) ? parseInt(req.query.ep, 10) : 1;
    if (!slug) return res.status(400).send("Missing slug");
    let stream;
    if (linkId) {
      stream = await resolveStream(linkId, slug);
    } else {
      // re-resolve default for a new episode
      const model = await getWatchModel(slug, ep);
      stream = model.stream || { error: model.error || "No stream" };
    }
    res.render("partials/stream-data", { stream, slug, ep, layout: false });
  });

  // history fragment
  frag.get("/history-list", (req, res) => {
    const items = history.getHistory(req.deviceId);
    res.render("partials/history-items", { items, layout: false });
  });

  // save progress (called by player beacon + explicit flush)
  frag.post("/progress", progressRateLimit, (req, res) => {
    const b = req.body || {};
    const ok = history.saveProgress(req.deviceId, {
      slug: String(b.slug || ""),
      ep: b.ep,
      position: b.position,
      duration: b.duration,
      title: typeof b.title === "string" ? b.title : "",
      poster: typeof b.poster === "string" ? b.poster : "",
      epTitle: typeof b.epTitle === "string" ? b.epTitle : "",
    });
    res.status(ok ? 204 : 400).end();
  });

  frag.post("/history/remove", (req, res) => {
    history.removeEntry(req.deviceId, String((req.body || {}).slug || ""));
    const items = history.getHistory(req.deviceId);
    res.render("partials/history-items", { items, layout: false });
  });

  frag.post("/history/clear", (req, res) => {
    history.clearHistory(req.deviceId);
    res.render("partials/history-items", { items: [], layout: false });
  });

  app.use("/fragments", frag);

  // ---------- HIDDEN DOCS (not linked anywhere, noindex) ----------
  // NOTE: kept out of `frag` on purpose — direct URL access, any client.
  app.use("/docs", (req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  }, express.Router().get("/", (req, res) => {
    res.render("docs/playground", { title: "AniKotoAPI — Docs & Playground", layout: false });
  }));

  app.use("/", router);

  // ---------- FINAL 404 (web pages render HTML, unknown /api paths stay JSON) ----------
  app.use((req, res) => {
    if (req.headers["hx-request"] === "true") {
      return res.status(404).send('<div class="empty">Not found</div>');
    }
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ success: false, message: "Endpoint not found" });
    }
    renderPage(res, "pages/404", { title: "404 — AniKuoshi" }, 404);
  });
};

export { esc };
// ══════════════════════════════════════════════════════════════ END

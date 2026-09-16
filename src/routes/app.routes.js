/**
 * ============================================================
 *  APIKuoshi — src/routes/app.routes.js
 * ============================================================
 *  Serves the Anikuoshi PWA build (static + SPA fallback).
 *
 *  Resolution order for the dist folder:
 *    1. ANIKUOSHI_DIST env (absolute or relative to project root)
 *    2. <project root>/anikuoshi-dist   (drop the built folder here)
 *    3. <project root>/anikuoshi/dist   (sibling checkout, dev style)
 *
 *  If none exists the router yields and the API keeps its JSON
 *  landing page — zero behavior change without the PWA.
 * ============================================================
 */
import { Router as expressRouter } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

export function findAnikuoshiDist() {
  const candidates = [];
  if (process.env.ANIKUOSHI_DIST) candidates.push(path.resolve(ROOT, process.env.ANIKUOSHI_DIST));
  candidates.push(path.join(ROOT, "anikuoshi-dist"));
  candidates.push(path.join(ROOT, "anikuoshi", "dist"));
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "index.html"))) return c;
    } catch { /* skip */ }
  }
  return null;
}

const router = expressRouter();

router.use((req, res, next) => {
  // never swallow API paths — /api 404s stay JSON via the API error handler
  if (req.path.startsWith("/api/")) return next();
  const dist = findAnikuoshiDist();
  if (!dist) return next(); // no PWA installed — API behaves as before

  const urlPath = decodeURIComponent((req.path === "/" ? "/index.html" : req.path).split("?")[0]);
  const candidate = path.normalize(path.join(dist, urlPath));
  if (!candidate.startsWith(dist)) return next();

  let filePath = fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
  let isAsset = false;

  if (!filePath) {
    // hashed assets must not be SPA-fallbacked — let 404 happen for them
    if (/^\/assets\//.test(urlPath) || /\.(js|css|png|svg|jpg|webp|woff2?|ico|json)$/.test(urlPath)) {
      return res.status(404).json({ success: false, api: "APIKuoshi", message: "Asset not found in the Anikuoshi build." });
    }
    filePath = path.join(dist, "index.html"); // SPA fallback (hash router)
  } else {
    isAsset = true;
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".txt": "text/plain; charset=utf-8",
  };
  const isHashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path.basename(filePath));
  res.setHeader("Content-Type", types[ext] || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (ext === ".html" || ext === ".webmanifest") res.setHeader("Cache-Control", "no-cache");
  else if (isHashed) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  else res.setHeader("Cache-Control", "public, max-age=3600");

  if (req.method === "HEAD") return res.status(200).end();
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

export default router;

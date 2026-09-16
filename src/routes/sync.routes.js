/**
 * ============================================================
 *  APIKuoshi — src/routes/sync.routes.js
 * ============================================================
 *  JSON document sync for the Anikuoshi PWA (no accounts).
 *
 *  The PWA stores progress / lists / history / favorites locally
 *  and mirrors them here as ONE JSON document. Identity = sync
 *  code (e.g. KUOSHI-7F3A) sent as the X-Sync-Token header — the
 *  code itself is never stored, only its SHA-256 prefix, so the
 *  store file leaks nothing usable.
 *
 *  Endpoints (all JSON, armor-compatible via X-Armor: 1):
 *    GET    /api/sync   -> { success, rev, doc|null, updatedAt }
 *    PUT    /api/sync   -> { success, rev }   body { rev, doc }
 *                      -> 409 { success:false, conflict:true, rev, doc }
 *    DELETE /api/sync   -> { success }        (wipes that code's copy)
 *
 *  Enable with SYNC_TOKEN (any non-empty string acts as a valid
 *  code — devices must send it verbatim). Multiple codes are fine;
 *  each gets its own file under data/sync/.
 * ============================================================
 */
import { Router as expressRouter } from "express";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SYNC_DATA_DIR || path.resolve(__dirname, "../../data/sync");
const MAX_BYTES = parseInt(process.env.SYNC_MAX_BYTES || String(4 * 1024 * 1024), 10) || 4 * 1024 * 1024;

export const syncEnabled = () => Boolean(process.env.SYNC_TOKEN && process.env.SYNC_TOKEN.trim());

const router = expressRouter();

// ---- storage helpers -------------------------------------------------

function codeDir(token) {
  const hash = crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
  return path.join(DATA_DIR, hash);
}

function storePath(token) {
  return path.join(codeDir(token), "doc.json");
}

async function readStore(token) {
  try {
    const raw = await fsp.readFile(storePath(token), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.rev != null) return parsed;
    return { rev: 0, doc: null, updatedAt: null };
  } catch {
    return { rev: 0, doc: null, updatedAt: null };
  }
}

async function writeStore(token, store) {
  const dir = codeDir(token);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `doc.json.tmp-${Date.now()}`);
  await fsp.writeFile(tmp, JSON.stringify(store), "utf8");
  await fsp.rename(tmp, storePath(token));
}

// ---- middleware: gate + auth -----------------------------------------

function gate(req, res, next) {
  if (!syncEnabled()) {
    return res.status(501).json({
      success: false,
      api: "APIKuoshi",
      message: "Sync is disabled. Set SYNC_TOKEN in .env to the sync code you want devices to use, then restart.",
    });
  }
  const token = req.get("X-Sync-Token") || "";
  if (!token || token !== process.env.SYNC_TOKEN.trim()) {
    return res.status(401).json({
      success: false,
      api: "APIKuoshi",
      message: "Missing or wrong sync code (X-Sync-Token header).",
    });
  }
  next();
}

router.use(gate);

// ---- routes ----------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const store = await readStore(req.get("X-Sync-Token"));
    res.json({
      success: true,
      api: "APIKuoshi",
      rev: store.rev,
      doc: store.doc ?? null,
      updatedAt: store.updatedAt ?? null,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const token = req.get("X-Sync-Token");
    const body = req.body || {};
    const rev = Number(body.rev);
    const doc = body.doc;

    if (!Number.isFinite(rev) || rev < 0) {
      return res.status(400).json({ success: false, api: "APIKuoshi", message: "Body must be { rev: <number>, doc: <object> }." });
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return res.status(400).json({ success: false, api: "APIKuoshi", message: "Missing or invalid doc object." });
    }

    const store = await readStore(token);
    if (store.rev !== rev) {
      // optimistic concurrency: someone else pushed meanwhile
      return res.status(409).json({
        success: false,
        api: "APIKuoshi",
        conflict: true,
        rev: store.rev,
        doc: store.doc ?? null,
        updatedAt: store.updatedAt ?? null,
        message: `Rev conflict: server at ${store.rev}, client sent ${rev}. Merge and retry.`,
      });
    }

    const serialized = JSON.stringify({ rev: rev + 1, doc, updatedAt: Date.now() });
    if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
      return res.status(413).json({
        success: false,
        api: "APIKuoshi",
        message: `Sync doc too large (>${Math.round(MAX_BYTES / 1024)} KB). Trim history or raise SYNC_MAX_BYTES.`,
      });
    }

    const nextStore = { rev: rev + 1, doc, updatedAt: Date.now() };
    await writeStore(token, nextStore);
    res.json({ success: true, api: "APIKuoshi", rev: nextStore.rev });
  } catch (err) {
    next(err);
  }
});

router.delete("/", async (req, res, next) => {
  try {
    const dir = codeDir(req.get("X-Sync-Token"));
    await fsp.rm(dir, { recursive: true, force: true });
    res.json({ success: true, api: "APIKuoshi" });
  } catch (err) {
    next(err);
  }
});

// request bodies can exceed the default 100kb app limit for big histories
export default { router, jsonLimit: "6mb", maxBytes: MAX_BYTES };

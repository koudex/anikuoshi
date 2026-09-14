/*
 * AniKuoshi — web/store/history.store.js
 * ------------------------------------------------------------------
 * Zero-dependency watch-progress + history store, keyed by an anonymous
 * device id (httpOnly cookie set by the web routes).
 *
 *  - In-memory Map with debounced persistence to data/history.json
 *  - Per-device entry cap + global device cap + 120-day TTL pruning
 *  - Atomic-ish writes (tmp file + rename), never blocks the event loop
 *
 * Shape per device:
 * {
 *   "entries": {
 *     "<slug>": {
 *       slug, title, poster, ep, epTitle,
 *       position (seconds), duration (seconds), updatedAt
 *     }, ...
 *   },
 *   "updatedAt": 1690000000000
 * }
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "history.json");

const MAX_DEVICES = 5000;          // total devices tracked
const MAX_ENTRIES_PER_DEVICE = 200; // per-device history cap
const TTL_MS = 120 * 24 * 3600 * 1000; // 120 days
const SAVE_DEBOUNCE_MS = 1500;

const store = new Map();
let dirty = false;
let saveTimer = null;
let loaded = false;

// ══════════════════════════════════════════════════════════════
// PERSISTENCE
// ══════════════════════════════════════════════════════════════

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      const now = Date.now();
      for (const [deviceId, device] of Object.entries(raw || {})) {
        if (!device || typeof device !== "object") continue;
        // TTL pruning on load
        const entries = {};
        for (const [slug, entry] of Object.entries(device.entries || {})) {
          if (entry && now - (entry.updatedAt || 0) < TTL_MS) entries[slug] = entry;
        }
        if (Object.keys(entries).length > 0) {
          store.set(deviceId, { entries, updatedAt: device.updatedAt || now });
        }
      }
      console.log(`[AK-STORE] Loaded ${store.size} device history records`);
    }
  } catch (error) {
    console.error("[AK-STORE] Load failed:", error.message);
  }
}

function persist() {
  if (!dirty) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Cap devices (drop oldest-updated)
    while (store.size > MAX_DEVICES) {
      let oldestKey = null, oldestVal = Infinity;
      for (const [k, v] of store.entries()) {
        if ((v.updatedAt || 0) < oldestVal) { oldestVal = v.updatedAt || 0; oldestKey = k; }
      }
      if (oldestKey) store.delete(oldestKey); else break;
    }
    const out = {};
    for (const [k, v] of store.entries()) out[k] = v;
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, DATA_FILE);
    dirty = false;
  } catch (error) {
    console.error("[AK-STORE] Persist failed:", error.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, SAVE_DEBOUNCE_MS);
}

// Flush on shutdown
process.on("SIGTERM", () => { persist(); });
process.on("SIGINT", () => { persist(); });
process.on("exit", () => { persist(); });

// ══════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════

/** Create a new anonymous device id (32 hex chars). */
export const newDeviceId = () => crypto.randomBytes(16).toString("hex");

/** Validate an existing device id cookie value. */
export const isValidDeviceId = (id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);

/** Get all history entries for a device, newest first. */
export const getHistory = (deviceId) => {
  load();
  const device = store.get(deviceId);
  if (!device) return [];
  return Object.values(device.entries)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};

/** Get one entry (for resume position). */
export const getEntry = (deviceId, slug) => {
  load();
  return store.get(deviceId)?.entries?.[slug] || null;
};

/**
 * Upsert a watch-progress entry.
 * @returns {boolean} true when stored
 */
export const saveProgress = (deviceId, payload) => {
  load();
  const { slug, ep, position, duration, title, poster, epTitle } = payload;

  if (!isValidDeviceId(deviceId)) return false;
  if (typeof slug !== "string" || !/^[a-z0-9-]{1,120}$/.test(slug)) return false;
  const epNum = Math.min(99999, Math.max(0, parseInt(ep, 10) || 0));
  if (!title || typeof title !== "string" || title.length > 220) return false;

  const device = store.get(deviceId) || { entries: {}, updatedAt: 0 };
  const prev = device.entries[slug] || {};
  const now = Date.now();

  device.entries[slug] = {
    slug,
    title: title.slice(0, 220),
    poster: typeof poster === "string" ? poster.slice(0, 500) : "",
    ep: epNum,
    epTitle: typeof epTitle === "string" ? epTitle.slice(0, 220) : "",
    position: Math.min(60 * 60 * 12, Math.max(0, parseInt(position, 10) || 0)),
    duration: Math.min(60 * 60 * 12, Math.max(0, parseInt(duration, 10) || 0)),
    updatedAt: now,
  };

  // Cap entries per device (drop oldest)
  const keys = Object.keys(device.entries);
  if (keys.length > MAX_ENTRIES_PER_DEVICE) {
    keys
      .sort((a, b) => (device.entries[a].updatedAt || 0) - (device.entries[b].updatedAt || 0))
      .slice(0, keys.length - MAX_ENTRIES_PER_DEVICE)
      .forEach(k => delete device.entries[k]);
  }

  device.updatedAt = now;
  store.set(deviceId, device);
  scheduleSave();
  return true;
};

/** Remove one entry. */
export const removeEntry = (deviceId, slug) => {
  load();
  const device = store.get(deviceId);
  if (!device?.entries?.[slug]) return false;
  delete device.entries[slug];
  device.updatedAt = Date.now();
  store.set(deviceId, device);
  scheduleSave();
  return true;
};

/** Clear a device's whole history. */
export const clearHistory = (deviceId) => {
  load();
  if (!store.has(deviceId)) return false;
  store.set(deviceId, { entries: {}, updatedAt: Date.now() });
  scheduleSave();
  return true;
};

/** Stats for the status endpoint. */
export const getStoreStats = () => {
  load();
  let entries = 0;
  for (const d of store.values()) entries += Object.keys(d.entries || {}).length;
  return { devices: store.size, entries };
};

// ══════════════════════════════════════════════════════════════ END

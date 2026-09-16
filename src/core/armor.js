/**
 * ============================================================
 *  APIKuoshi — src/core/armor.js
 * ============================================================
 *  Optional response armor for privacy-conscious clients (the
 *  Anikuoshi PWA). When ARMOR_SECRET is set, any JSON response
 *  for requests carrying `X-Armor: 1` is wrapped in an
 *  AES-256-GCM envelope:
 *
 *      { _armor: "aes-256-gcm", iv: "<b64>", ct: "<b64>" }
 *
 *  ct = ciphertext || GCM auth tag (WebCrypto-compatible).
 *  Key = SHA-256("anikuoshi-armor:" + ARMOR_SECRET) — the same
 *  derivation the PWA performs in src/lib/crypto.ts.
 *
 *  Honest threat model: this defeats casual Network-tab sniffing
 *  (titles, providers and stream URLs travel as ciphertext). It
 *  is NOT DRM — a determined user can extract the secret from
 *  the PWA bundle. Real access control stays server-side.
 * ============================================================
 */
import crypto from "crypto";

export function armorEnabled() {
  return Boolean(process.env.ARMOR_SECRET && process.env.ARMOR_SECRET.trim());
}

function armorKey() {
  return crypto.createHash("sha256").update(`anikuoshi-armor:${process.env.ARMOR_SECRET.trim()}`).digest();
}

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

function encryptValue(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", armorKey(), iv);
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    _armor: "aes-256-gcm",
    iv: b64(iv),
    ct: b64(Buffer.concat([ct, tag])),
  };
}

/**
 * Express middleware. Installs BEFORE the routers. For requests with
 * `X-Armor: 1` (and armor enabled) it transparently re-wraps every
 * res.json() payload. Non-JSON responses (HLS proxy, video, subtitle)
 * flow through untouched because they don't call res.json().
 */
export function armorMiddleware(req, res, next) {
  if (!armorEnabled()) return next();
  if (String(req.get("X-Armor") || "") !== "1") return next();

  const originalJson = res.json.bind(res);
  res.json = (value) => {
    try {
      res.setHeader("X-Armor", "1");
      return originalJson(encryptValue(value));
    } catch (err) {
      // never break the API because of armor — fall back to plaintext
      console.error("[APIKUOSHI][armor] encryption failed, responding plaintext:", err.message);
      res.removeHeader("X-Armor");
      return originalJson(value);
    }
  };
  next();
}

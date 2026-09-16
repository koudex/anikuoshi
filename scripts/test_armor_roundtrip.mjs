/**
 * Verify kuoshiapi armor ↔ Anikuoshi crypto.ts compatibility:
 * server encrypts (node crypto, ct||tag), client derivation must decrypt
 * (WebCrypto AES-GCM, key = SHA-256("anikuoshi-armor:" + secret)).
 */
const crypto = await import("crypto");
const SECRET = "test-secret-123";

const resp = await fetch("http://localhost:6969/api/suggestions?keyword=frieren", { headers: { "X-Armor": "1" } });
const env = await resp.json();
if (!env._armor) throw new Error("not armored: " + JSON.stringify(env).slice(0, 100));

// --- client-side mirror of src/lib/crypto.ts ---
const keyBits = crypto.createHash("sha256").update(`anikuoshi-armor:${SECRET}`).digest();
const key = await crypto.webcrypto.subtle.importKey("raw", keyBits, "AES-GCM", false, ["decrypt"]);
const iv = Buffer.from(env.iv, "base64");
const ct = Buffer.from(env.ct, "base64");
const plain = await crypto.webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
const json = JSON.parse(new TextDecoder().decode(plain));
console.log("ARMOR DECRYPT OK:", json.success === true, "suggestions:", json.suggestions?.length ?? 0);
if (json.success !== true) process.exit(1);

import { createCipheriv, randomBytes } from "node:crypto";

/// PushCloud's end-to-end encryption, sender half.
///
/// Base64( IV(12) || ciphertext || GCM tag(16) ), AES-256-GCM, per field
/// independently. See worker/src/lib/e2ee.ts, which is the same format read
/// from the other end, and docs/superpowers/specs/2026-07-28-e2ee-design.md.
///
/// The key is 64 hex characters, generated in the panel and copied to each
/// device and sender. The server never holds it and cannot read any of this,
/// which is the entire point: a hook's messages are shell commands, and shell
/// commands are the most sensitive text this product ever carries.
///
/// What this does NOT cover, and the README says so: the answer coming back.
/// A tapped button is an id, and a typed reply travels as plaintext, because
/// only the four outbound text fields are encrypted. Do not put a secret in a
/// reply and expect it to be sealed.
export function parseKey(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error("an encryption key is 64 hex characters, from Settings in the panel");
  }
  return Buffer.from(hex.trim(), "hex");
}

export function seal(plaintext, key) {
  // 12 bytes is GCM's native IV size, and a fresh one per field per message: a
  // repeated IV under the same key is the one mistake AES-GCM does not forgive.
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64");
}

/// Seals the fields of a send that the wire format covers, and leaves the rest.
///
/// `actions` are deliberately not encrypted: the button labels have to stay
/// readable so iOS can register the notification category without the key,
/// which would otherwise make the most delicate part of the extension depend on
/// a key being present. Ours are "Approve" and "Deny", which give nothing away.
export function sealBody(body, keyHex) {
  if (!keyHex) return body;
  const key = parseKey(keyHex);
  const out = { ...body, encrypted: true };
  for (const field of ["title", "message", "url", "url_title"]) {
    if (out[field] != null) out[field] = seal(out[field], key);
  }
  return out;
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { seal, sealBody, parseKey } from "../src/seal.mjs";

const KEY = "0123456789abcdef".repeat(4);

/// The worker's shape check, from worker/src/lib/e2ee.ts. Copied rather than
/// imported because that file is TypeScript inside the Worker build; if the two
/// ever disagree, an encrypted push arrives as permanent garbage on the phone.
function looksSealed(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = (value.length / 4) * 3 - padding;
  return Number.isInteger(value.length / 4) && bytes >= 12 + 16;
}

/// A device's half of the wire format: IV(12) || ciphertext || tag(16).
function open(b64, keyHex) {
  const raw = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
}

describe("seal", () => {
  test("produces something the worker will accept", () => {
    assert.ok(looksSealed(seal("git push --force origin main", parseKey(KEY))));
  });

  test("a phone holding the key gets the command back", () => {
    const sealed = seal("rm -rf /", parseKey(KEY));
    assert.equal(open(sealed, KEY), "rm -rf /");
  });

  test("the wrong key cannot open it", () => {
    const sealed = seal("secret", parseKey(KEY));
    assert.throws(() => open(sealed, "f".repeat(64)));
  });

  test("the same text twice does not produce the same bytes", () => {
    // A fresh IV per field per message. A repeated IV under one key is the
    // mistake GCM does not forgive, and it would also leak that two commands
    // were identical.
    const k = parseKey(KEY);
    assert.notEqual(seal("ls", k), seal("ls", k));
  });

  test("empty text still seals to a valid field", () => {
    assert.ok(looksSealed(seal("", parseKey(KEY))));
  });
});

describe("parseKey", () => {
  test("rejects anything that is not 64 hex characters", () => {
    for (const bad of ["", "abc", "g".repeat(64), "a".repeat(63), null, 12345]) {
      assert.throws(() => parseKey(bad), /64 hex/);
    }
  });

  test("tolerates surrounding whitespace, because people paste", () => {
    assert.equal(parseKey(` ${KEY}\n`).length, 32);
  });
});

describe("sealBody", () => {
  test("without a key, the body is untouched and unflagged", () => {
    const body = { title: "t", message: "m" };
    assert.deepEqual(sealBody(body, null), body);
    assert.equal(sealBody(body, null).encrypted, undefined);
  });

  test("with a key, the text fields are sealed and the flag is set", () => {
    const out = sealBody({ title: "dev-laptop", message: "whoami" }, KEY);
    assert.equal(out.encrypted, true);
    assert.equal(open(out.title, KEY), "dev-laptop");
    assert.equal(open(out.message, KEY), "whoami");
  });

  test("actions stay readable", () => {
    // iOS registers the notification category from these labels before any key
    // is available. Encrypting them would break the buttons, not protect them.
    const actions = [{ id: "allow", label: "Approve", type: "button" }];
    assert.deepEqual(sealBody({ message: "m", actions }, KEY).actions, actions);
  });

  test("priority and the rest of the envelope are left alone", () => {
    const out = sealBody({ message: "m", priority: 1, expires_in: 3600 }, KEY);
    assert.equal(out.priority, 1);
    assert.equal(out.expires_in, 3600);
  });

  test("absent fields are not invented", () => {
    const out = sealBody({ message: "m" }, KEY);
    assert.equal("title" in out, false);
    assert.equal("url" in out, false);
  });

  test("a bad key fails loudly rather than sending plaintext", () => {
    // The dangerous failure would be falling back to an unencrypted send while
    // the user believes their commands are sealed.
    assert.throws(() => sealBody({ message: "m" }, "not-a-key"), /64 hex/);
  });
});

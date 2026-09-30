import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { BIN_FILES, binDir, installBin, hookCommand, onPath } from "../src/install.mjs";
import { waitForAnswer } from "../src/api.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const tmpHome = () => mkdtempSync(join(tmpdir(), "pushcloud-home-"));

describe("installBin", () => {
  test("ships the hook and every module it imports", () => {
    assert.deepEqual(BIN_FILES, ["pushcloud-hook.mjs", "api.mjs", "config.mjs", "seal.mjs", "agents.mjs", "sessions.mjs"]);
  });

  test("binDir is ~/.pushcloud/bin", () => {
    assert.equal(binDir("/h"), join("/h", ".pushcloud", "bin"));
  });

  test("writes every file and returns the hook path", () => {
    const home = tmpHome();
    const hook = installBin(home);
    assert.equal(hook, join(home, ".pushcloud", "bin", "pushcloud-hook.mjs"));
    for (const f of BIN_FILES) {
      assert.equal(
        readFileSync(join(binDir(home), f), "utf8"),
        readFileSync(join(SRC, f), "utf8"),
        `${f} should be a copy of src/${f}`
      );
    }
    assert.equal(statSync(binDir(home)).mode & 0o777, 0o755);
  });

  test("a second call overwrites what the first wrote", () => {
    const home = tmpHome();
    installBin(home);
    // Stand-in for an older version left behind by a previous install.
    writeFileSync(join(binDir(home), "api.mjs"), "// stale\n");
    installBin(home);
    assert.equal(
      readFileSync(join(binDir(home), "api.mjs"), "utf8"),
      readFileSync(join(SRC, "api.mjs"), "utf8")
    );
  });

  test("the copied hook runs on its own, away from the package", async () => {
    // The whole point: the hook must not reach back into the npx cache.
    const home = tmpHome();
    const hook = installBin(home);
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [hook, "notify"], {
      input: "{}",
      env: { ...process.env, HOME: home, PUSHCLOUD_CONFIG: join(home, "nope.json") },
    });
    assert.doesNotMatch(String(r.stderr), /ERR_MODULE_NOT_FOUND|Cannot find module/);
  });
});

describe("hookCommand", () => {
  test("quotes the stable path", () => {
    assert.equal(hookCommand("/h"), `node "${join("/h", ".pushcloud", "bin", "pushcloud-hook.mjs")}"`);
  });
});

describe("onPath", () => {
  test("finds an executable, ignores a plain file and a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "pushcloud-path-"));
    writeFileSync(join(dir, "yes"), "#!/bin/sh\n");
    chmodSync(join(dir, "yes"), 0o755);
    writeFileSync(join(dir, "plain"), "");
    chmodSync(join(dir, "plain"), 0o644);
    mkdirSync(join(dir, "adir"));
    const env = { PATH: ["/nonexistent", dir].join(delimiter) };
    assert.equal(onPath("yes", env), true);
    assert.equal(onPath("plain", env), false);
    assert.equal(onPath("adir", env), false);
    assert.equal(onPath("missing", env), false);
    assert.equal(onPath("yes", {}), false);
  });
});

describe("waitForAnswer credentials", () => {
  let server;
  let origin;
  let seen = [];
  let interaction = { status: "responded", response: JSON.stringify({ action_id: "allow" }) };

  before(async () => {
    server = createServer((req, res) => {
      seen.push({ path: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ interaction }));
    });
    await new Promise((r) => server.listen(0, r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test("a token alone is enough to wait", async () => {
    seen = [];
    const answer = await waitForAnswer({ api: origin, token: "pca_x" }, "i1", 5);
    assert.equal(seen[0].auth, "Bearer pca_x");
    assert.equal(seen[0].path, "/v1/interactions/i1/wait?timeout=5");
    assert.deepEqual(answer, { action_id: "allow" });
  });

  test("the key is used when there is one", async () => {
    seen = [];
    await waitForAnswer({ api: origin, token: "pca_x", key: "pck_y" }, "i1", 5);
    assert.equal(seen[0].auth, "Bearer pck_y");
  });

  test("an expired question with a default counts as answered", async () => {
    interaction = { status: "expired", default_applied: true, response: JSON.stringify({ action_id: "deny" }) };
    assert.deepEqual(await waitForAnswer({ api: origin, token: "pca_x" }, "i1", 5), { action_id: "deny" });
  });

  test("expired without a default, or still pending, is no answer", async () => {
    interaction = { status: "expired", default_applied: false, response: null };
    assert.equal(await waitForAnswer({ api: origin, token: "pca_x" }, "i1", 5), null);
    interaction = { status: "pending", default_applied: false, response: null };
    assert.equal(await waitForAnswer({ api: origin, token: "pca_x" }, "i1", 5), null);
  });
});

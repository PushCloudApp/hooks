import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SETUP = fileURLToPath(new URL("../src/setup.mjs", import.meta.url));

let api;
let seen = [];

before(async () => {
  const server = createServer(async (req, res) => {
    const body = await new Promise((r) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => r(raw));
    });
    seen.push({ path: req.url, auth: req.headers.authorization, body });

    // The key is checked against the interactions list, the token against a
    // send. A bad key must fail the first and not the second.
    if (req.url.startsWith("/v1/interactions?")) {
      const ok = req.headers.authorization === "Bearer pck_good";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(ok ? { interactions: [] } : { error: { code: "UNAUTHORIZED" } }));
    }
    if (req.url.startsWith("/v1/messages")) {
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: { id: "m1" }, interaction_id: "i1" }));
    }
    if (req.url.includes("/wait")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          interaction: { status: "responded", response: JSON.stringify({ action_id: "allow" }) },
        })
      );
    }
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "FORBIDDEN" } }));
  });
  await new Promise((r) => server.listen(0, r));
  api = { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
});

after(() => api.close());

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SETUP, ...args], {
      env: { ...process.env, PUSHCLOUD_API: api.origin, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ out, err, code }));
  });
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "pushcloud-setup-"));
  return { dir, settings: join(dir, "settings.json"), config: join(dir, "config.json") };
}

const good = (w, extra = []) => [
  "setup",
  "--token",
  "pca_good",
  "--key",
  "pck_good",
  "--claude-settings",
  w.settings,
  "--config",
  w.config,
  ...extra,
];

describe("pushcloud setup", () => {
  test("writes the config, the hooks, and proves the loop", async () => {
    const w = workspace();
    seen = [];
    const { out, code } = await run(good(w));
    assert.equal(code, 0, out);

    const config = JSON.parse(readFileSync(w.config, "utf8"));
    assert.equal(config.token, "pca_good");
    assert.equal(config.key, "pck_good");

    const settings = JSON.parse(readFileSync(w.settings, "utf8"));
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /pushcloud-hook\.mjs ask$/);

    // The test question is the point of the last step: a setup that writes
    // files and never proves a phone can answer is a setup that fails silently.
    assert.ok(seen.some((r) => r.path.includes("/wait")), "should have waited on an answer");
    assert.match(out, /Done\. Your agent can reach you\./);
  });

  test("credentials are written readable only by the user", async () => {
    const w = workspace();
    await run(good(w, ["--no-test"]));
    // 0o777 masks off the file-type bits. An API key readable by every process
    // on a shared machine is the sort of thing nobody checks twice.
    assert.equal(statSync(w.config).mode & 0o777, 0o600);
  });

  test("a bad key stops before anything is written", async () => {
    const w = workspace();
    const { code, err } = await run([
      "setup",
      "--token",
      "pca_good",
      "--key",
      "pck_wrong",
      "--claude-settings",
      w.settings,
      "--config",
      w.config,
    ]);
    assert.equal(code, 1);
    assert.match(err, /refused/);
    // Nothing half-written: no config, and no hooks in a file that would then
    // fire on every tool call with credentials that do not work.
    assert.equal(existsSync(w.config), false);
    assert.equal(existsSync(w.settings), false);
  });

  test("a token that is not a token is caught", async () => {
    const w = workspace();
    const { code, err } = await run([
      "setup",
      "--token",
      "hunter2",
      "--key",
      "pck_good",
      "--claude-settings",
      w.settings,
      "--config",
      w.config,
    ]);
    assert.equal(code, 1);
    assert.match(err, /application token/);
  });

  test("an existing settings file is backed up before the first write", async () => {
    const w = workspace();
    writeFileSync(w.settings, JSON.stringify({ model: "opus" }));
    await run(good(w, ["--no-test"]));

    assert.deepEqual(JSON.parse(readFileSync(`${w.settings}.pushcloud-backup`, "utf8")), {
      model: "opus",
    });
    assert.equal(JSON.parse(readFileSync(w.settings, "utf8")).model, "opus");
  });

  test("the backup is not overwritten on a second run", async () => {
    const w = workspace();
    writeFileSync(w.settings, JSON.stringify({ model: "original" }));
    await run(good(w, ["--no-test"]));
    await run(good(w, ["--no-test"]));
    // Still the file as it was before this tool ever touched it, not the
    // output of the first run.
    assert.equal(
      JSON.parse(readFileSync(`${w.settings}.pushcloud-backup`, "utf8")).model,
      "original"
    );
  });

  test("refuses to write over a settings file it cannot parse", async () => {
    const w = workspace();
    writeFileSync(w.settings, "{ this is not json");
    const { code, err } = await run(good(w, ["--no-test"]));
    assert.equal(code, 1);
    assert.match(err, /not valid JSON/);
    assert.equal(readFileSync(w.settings, "utf8"), "{ this is not json");
  });

  test("--matcher decides which tools ask", async () => {
    const w = workspace();
    await run(good(w, ["--no-test", "--matcher", "Bash|Write"]));
    const settings = JSON.parse(readFileSync(w.settings, "utf8"));
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash|Write");
  });

  test("remove takes the hooks back out", async () => {
    const w = workspace();
    writeFileSync(w.settings, JSON.stringify({ model: "opus" }));
    await run(good(w, ["--no-test"]));
    const { code } = await run(["remove", "--claude-settings", w.settings]);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(w.settings, "utf8")), { model: "opus" });
  });

  test("without a terminal it says so rather than hanging", async () => {
    const w = workspace();
    const { code, err } = await run(["setup", "--config", w.config, "--claude-settings", w.settings]);
    assert.equal(code, 1);
    assert.match(err, /--token and --key/);
  });
});

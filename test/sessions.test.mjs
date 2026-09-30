import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionsPath, readCache, writeCache, MAX_CACHED, titleFor } from "../src/sessions.mjs";

const HOOK = fileURLToPath(new URL("../src/pushcloud-hook.mjs", import.meta.url));
const tmpHome = () => mkdtempSync(join(tmpdir(), "pushcloud-sessions-"));

/// A stand-in `/v1/sessions`. `plan.status` forces an error code; `plan.hang`
/// accepts the request and never answers. Every request is recorded.
async function fakeApi(plan = {}) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const raw = await new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b));
    });
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    if (plan.hang) return; // never answers
    const status = typeof plan.status === "function" ? plan.status(req) : plan.status;
    if (status && status >= 400) {
      res.writeHead(status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { code: status === 409 ? "SESSION_ENDED" : "BOOM", message: "x" } }));
    }
    if (req.method === "POST") {
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ session: { id: plan.sesId ?? "ses_new", status: "working" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    const body = seen.at(-1).body ?? {};
    return res.end(JSON.stringify({ session: { id: req.url.split("/").pop(), status: body.status } }));
  });
  await new Promise((r) => server.listen(0, r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

function runEvent(event, payload, { home, origin, token = "pca_x" }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env, HOME: home, PUSHCLOUD_CONFIG: join(home, "nope.json"), PUSHCLOUD_API: origin };
    delete env.PUSHCLOUD_TOKEN;
    delete env.PUSHCLOUD_KEY;
    if (token) env.PUSHCLOUD_TOKEN = token;
    const child = spawn(process.execPath, [HOOK, "--event", event], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ out, err, code, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const START = { session_id: "abc123", cwd: "/Users/me/dev/thing", hook_event_name: "SessionStart", source: "startup" };
const cachePath = (home) => join(home, ".pushcloud", "sessions.json");
const cacheOf = (home) => JSON.parse(readFileSync(cachePath(home), "utf8"));

describe("SessionStart", () => {
  test("posts a session with external_id cc-<id> and caches its id", async () => {
    const home = tmpHome();
    const api = await fakeApi({ sesId: "ses_1" });
    const r = await runEvent("session-start", START, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.equal(r.out, "", "a session hook prints nothing");
    assert.equal(api.seen.length, 1);
    const [req] = api.seen;
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/sessions");
    assert.equal(req.auth, "Bearer pca_x");
    assert.deepEqual(req.body, {
      title: "Claude Code in thing",
      agent: "claude-code",
      project: "thing",
      external_id: "cc-abc123",
    });
    assert.deepEqual(cacheOf(home), { "cc-abc123": "ses_1" });
    assert.equal(statSync(cachePath(home)).mode & 0o777, 0o600);
  });

  test("a prompt, when present, is the title, clipped to 200 characters", async () => {
    const home = tmpHome();
    const api = await fakeApi();
    await runEvent("session-start", { ...START, prompt: "x".repeat(250) }, { home, origin: api.origin });
    api.close();
    assert.equal(api.seen[0].body.title, "x".repeat(200));
  });

  test("with no token it does nothing and exits 0", async () => {
    const home = tmpHome();
    const api = await fakeApi();
    const r = await runEvent("session-start", START, { home, origin: api.origin, token: null });
    api.close();
    assert.equal(r.code, 0);
    assert.equal(api.seen.length, 0);
  });
});

describe("Notification and Stop", () => {
  const seed = (home, map) => {
    mkdirSync(join(home, ".pushcloud"), { recursive: true });
    writeFileSync(cachePath(home), JSON.stringify(map));
  };

  test("Notification PATCHes the cached session to waiting", async () => {
    const home = tmpHome();
    seed(home, { "cc-abc123": "ses_1" });
    const api = await fakeApi();
    const r = await runEvent("notification", { ...START, hook_event_name: "Notification", message: "hi" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.equal(api.seen.length, 1);
    assert.equal(api.seen[0].method, "PATCH");
    assert.equal(api.seen[0].path, "/v1/sessions/ses_1");
    assert.equal(api.seen[0].auth, "Bearer pca_x");
    assert.deepEqual(api.seen[0].body, { status: "waiting" });
    assert.deepEqual(cacheOf(home), { "cc-abc123": "ses_1" });
  });

  test("Stop PATCHes done and drops the cache entry", async () => {
    const home = tmpHome();
    seed(home, { "cc-other": "ses_0", "cc-abc123": "ses_1" });
    const api = await fakeApi();
    const r = await runEvent("stop", { ...START, hook_event_name: "Stop" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.equal(api.seen.length, 1);
    assert.equal(api.seen[0].method, "PATCH");
    assert.equal(api.seen[0].path, "/v1/sessions/ses_1");
    assert.deepEqual(api.seen[0].body, { status: "done" });
    assert.deepEqual(cacheOf(home), { "cc-other": "ses_0" });
  });

  test("a cache miss re-POSTs with the same external_id, then PATCHes", async () => {
    const home = tmpHome();
    const api = await fakeApi({ sesId: "ses_replayed" });
    const r = await runEvent("notification", { ...START, hook_event_name: "Notification" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.deepEqual(api.seen.map((s) => `${s.method} ${s.path}`), ["POST /v1/sessions", "PATCH /v1/sessions/ses_replayed"]);
    assert.equal(api.seen[0].body.external_id, "cc-abc123");
    assert.deepEqual(api.seen[1].body, { status: "waiting" });
    assert.deepEqual(cacheOf(home), { "cc-abc123": "ses_replayed" });
  });

  test("a 409 SESSION_ENDED is ignored", async () => {
    const home = tmpHome();
    seed(home, { "cc-abc123": "ses_1" });
    const api = await fakeApi({ status: 409 });
    const r = await runEvent("stop", { ...START, hook_event_name: "Stop" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.equal(r.err, "");
    assert.deepEqual(cacheOf(home), {});
  });
});

describe("fails open", () => {
  for (const event of ["session-start", "notification", "stop"]) {
    test(`${event}: a 500 exits 0, silently`, async () => {
      const home = tmpHome();
      const api = await fakeApi({ status: 500 });
      const r = await runEvent(event, START, { home, origin: api.origin });
      api.close();
      assert.equal(r.code, 0);
      assert.equal(r.out, "");
      assert.equal(r.err, "");
    });

    test(`${event}: a server that hangs exits 0 within 4 s`, async () => {
      const home = tmpHome();
      const api = await fakeApi({ hang: true });
      const r = await runEvent(event, START, { home, origin: api.origin });
      api.close();
      assert.equal(r.code, 0);
      assert.equal(r.out, "");
      assert.ok(r.ms < 4000, `took ${r.ms} ms`);
    });
  }

  test("nothing listening at all exits 0", async () => {
    const home = tmpHome();
    const r = await runEvent("session-start", START, { home, origin: "http://127.0.0.1:1" });
    assert.equal(r.code, 0);
    assert.equal(r.err, "");
  });

  test("a corrupt cache file is treated as empty", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".pushcloud"), { recursive: true });
    writeFileSync(cachePath(home), "{not json");
    const api = await fakeApi({ sesId: "ses_2" });
    const r = await runEvent("session-start", START, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.deepEqual(cacheOf(home), { "cc-abc123": "ses_2" });
  });
});

describe("the cache", () => {
  test("lives at ~/.pushcloud/sessions.json", () => {
    assert.equal(sessionsPath("/h"), join("/h", ".pushcloud", "sessions.json"));
  });

  test(`keeps at most ${200} entries, dropping the oldest`, () => {
    assert.equal(MAX_CACHED, 200);
    const home = tmpHome();
    const path = sessionsPath(home);
    const map = {};
    for (let i = 0; i < 205; i++) map[`cc-${i}`] = `ses_${i}`;
    writeCache(map, path);
    const kept = readCache(path);
    assert.equal(Object.keys(kept).length, 200);
    assert.equal(kept["cc-0"], undefined);
    assert.equal(kept["cc-4"], undefined);
    assert.equal(kept["cc-5"], "ses_5");
    assert.equal(kept["cc-204"], "ses_204");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("a missing file reads as empty", () => {
    const home = tmpHome();
    assert.deepEqual(readCache(sessionsPath(home)), {});
    assert.equal(existsSync(sessionsPath(home)), false);
  });
});

describe("titleFor", () => {
  test("names the project, or falls back without one", () => {
    assert.equal(titleFor({ cwd: "/a/b/proj" }), "Claude Code in proj");
    assert.equal(titleFor({}), "Claude Code");
    assert.equal(titleFor({ cwd: "/x", prompt: "  fix the build  " }), "fix the build");
  });
});

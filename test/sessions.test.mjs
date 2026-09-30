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
    if (req.method === "GET" && plan.failedReason !== undefined) {
      res.writeHead(200, { "Content-Type": "application/json" });
      const id = req.url.split("/").pop();
      return res.end(JSON.stringify({ session: { id, status: "failed", failed_reason: plan.failedReason, steps: [] } }));
    }
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

  test("project is clipped to 80 characters", async () => {
    const home = tmpHome();
    const api = await fakeApi({});
    await runEvent("session-start", { ...START, cwd: `/work/${"p".repeat(120)}` }, { home, origin: api.origin });
    api.close();
    assert.equal(api.seen[0].body.project, "p".repeat(80));
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

describe("the turn and session-end events", () => {
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

  test("Stop PATCHes waiting and keeps the session (it fires every turn)", async () => {
    const home = tmpHome();
    seed(home, { "cc-other": "ses_0", "cc-abc123": "ses_1" });
    const api = await fakeApi();
    const r = await runEvent("stop", { ...START, hook_event_name: "Stop" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.deepEqual(api.seen.map((s) => `${s.method} ${s.path}`), ["PATCH /v1/sessions/ses_1"]);
    assert.deepEqual(api.seen[0].body, { status: "waiting" });
    assert.deepEqual(cacheOf(home), { "cc-other": "ses_0", "cc-abc123": "ses_1" });
  });

  test("UserPromptSubmit PATCHes the session back to working", async () => {
    const home = tmpHome();
    seed(home, { "cc-abc123": "ses_1" });
    const api = await fakeApi();
    const r = await runEvent("user-prompt-submit", { ...START, hook_event_name: "UserPromptSubmit", prompt: "go" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.deepEqual(api.seen.map((s) => `${s.method} ${s.path}`), ["PATCH /v1/sessions/ses_1"]);
    assert.deepEqual(api.seen[0].body, { status: "working" });
  });

  test("SessionEnd PATCHes done and drops the cache entry", async () => {
    const home = tmpHome();
    seed(home, { "cc-other": "ses_0", "cc-abc123": "ses_1" });
    const api = await fakeApi();
    const r = await runEvent("session-end", { ...START, hook_event_name: "SessionEnd", reason: "exit" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.deepEqual(api.seen.map((s) => `${s.method} ${s.path}`), ["PATCH /v1/sessions/ses_1"]);
    assert.deepEqual(api.seen[0].body, { status: "done" });
    assert.deepEqual(cacheOf(home), { "cc-other": "ses_0" });
  });

  test("SessionEnd with no cached session sends nothing (no session opened just to end it)", async () => {
    const home = tmpHome();
    const api = await fakeApi();
    const r = await runEvent("session-end", { ...START, hook_event_name: "SessionEnd" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.equal(api.seen.length, 0);
  });

  test("a three-turn session is one PushCloud session: one POST, no done until SessionEnd", async () => {
    const home = tmpHome();
    const api = await fakeApi({ sesId: "ses_one" });
    const opts = { home, origin: api.origin };
    await runEvent("session-start", START, opts);
    for (let turn = 0; turn < 3; turn++) {
      await runEvent("user-prompt-submit", { ...START, hook_event_name: "UserPromptSubmit" }, opts);
      await runEvent("stop", { ...START, hook_event_name: "Stop" }, opts);
    }
    await runEvent("session-end", { ...START, hook_event_name: "SessionEnd" }, opts);
    api.close();
    const posts = api.seen.filter((s) => s.method === "POST");
    assert.equal(posts.length, 1, JSON.stringify(api.seen));
    assert.equal(posts[0].path, "/v1/sessions");
    const statuses = api.seen.filter((s) => s.method === "PATCH").map((s) => s.body.status);
    assert.deepEqual(statuses, ["working", "waiting", "working", "waiting", "working", "waiting", "done"]);
  });

  test("Stop falls back to one plain push when the session can't be reported", async () => {
    const home = tmpHome();
    seed(home, { "cc-abc123": "ses_1" });
    const api = await fakeApi({ status: (req) => (req.url.startsWith("/v1/sessions") ? 500 : 0) });
    const r = await runEvent("stop", { ...START, hook_event_name: "Stop" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.deepEqual(api.seen.map((s) => `${s.method} ${s.path}`), ["PATCH /v1/sessions/ses_1", "POST /v1/messages"]);
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

  test("a 409 with some other code is not an ended session: nothing tombstoned", async () => {
    const home = tmpHome();
    seed(home, { "cc-abc123": "ses_1" });
    const server = createServer((req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "SOMETHING_ELSE", message: "x" } }));
      req.resume();
    });
    await new Promise((r) => server.listen(0, r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await runEvent("user-prompt-submit", { ...START, hook_event_name: "UserPromptSubmit" }, { home, origin });
    server.closeAllConnections?.();
    server.close();
    assert.deepEqual(cacheOf(home), { "cc-abc123": "ses_1" });
  });

  test("a 409 SESSION_ENDED (dismissed on the phone) is quiet, and the session stays dismissed", async () => {
    const home = tmpHome();
    seed(home, { "cc-abc123": "ses_1" });
    const api = await fakeApi({ status: (req) => (req.method === "PATCH" ? 409 : 0), failedReason: "dismissed" });
    const r = await runEvent("stop", { ...START, hook_event_name: "Stop" }, { home, origin: api.origin });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.equal(r.err, "");
    // No fallback push for a session the person dismissed, and no new session on
    // the next turn either.
    await runEvent("user-prompt-submit", { ...START, hook_event_name: "UserPromptSubmit" }, { home, origin: api.origin });
    await runEvent("stop", { ...START, hook_event_name: "Stop" }, { home, origin: api.origin });
    api.close();
    assert.deepEqual(api.seen.map((s) => `${s.method} ${s.path}`), ["PATCH /v1/sessions/ses_1", "GET /v1/sessions/ses_1"]);
  });

  test("a 409 on a session swept as stale (idle > 24 h) opens a fresh one rather than going silent", async () => {
    const home = tmpHome();
    seed(home, { "cc-abc123": "ses_1" });
    const api = await fakeApi({
      status: (req) => (req.method === "PATCH" && req.url.endsWith("/ses_1") ? 409 : 0),
      failedReason: "stale",
      sesId: "ses_2",
    });
    const r = await runEvent("stop", { ...START, hook_event_name: "Stop" }, { home, origin: api.origin });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    await runEvent("stop", { ...START, hook_event_name: "Stop" }, { home, origin: api.origin });
    api.close();
    assert.deepEqual(api.seen.map((s) => `${s.method} ${s.path}`), [
      "PATCH /v1/sessions/ses_1",
      "GET /v1/sessions/ses_1",
      "POST /v1/sessions",
      "PATCH /v1/sessions/ses_2",
      "PATCH /v1/sessions/ses_2",
    ]);
    assert.equal(api.seen[2].body.external_id, "cc-abc123");
    assert.deepEqual(cacheOf(home), { "cc-abc123": "ses_2" });
  });

  test("session-end on a stale-swept session forgets it without reopening", async () => {
    const home = tmpHome();
    seed(home, { "cc-abc123": "ses_1" });
    const api = await fakeApi({ status: (req) => (req.method === "PATCH" ? 409 : 0), failedReason: "stale" });
    const r = await runEvent("session-end", { ...START, hook_event_name: "SessionEnd" }, { home, origin: api.origin });
    api.close();
    assert.equal(r.code, 0);
    assert.ok(!api.seen.some((s) => s.method === "POST"), "never opens a session just to end it");
    assert.deepEqual(cacheOf(home), {});
  });
});

describe("fails open", () => {
  for (const event of ["session-start", "user-prompt-submit", "notification", "stop", "session-end"]) {
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

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../src/pushcloud-hook.mjs", import.meta.url));

/// A stand-in PushCloud. `plan` decides what the wait returns; every request it
/// receives is recorded so a test can assert on what the hook actually sent.
async function fakeApi(plan) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const body = await new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => resolve(raw));
    });
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });

    if (plan.status && plan.status >= 400) {
      res.writeHead(plan.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "NOPE" } }));
    }
    res.writeHead(req.url.startsWith("/v1/messages") ? 201 : 200, {
      "Content-Type": "application/json",
    });
    if (req.url.startsWith("/v1/messages")) {
      return res.end(
        JSON.stringify({ message: { id: "m1" }, ...(plan.noQuestion ? {} : { interaction_id: "i1" }) })
      );
    }
    return res.end(JSON.stringify({ interaction: plan.interaction }));
  });
  await new Promise((r) => server.listen(0, r));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

function run(mode, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, mode], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ out, err, code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const verdict = (out) => JSON.parse(out).hookSpecificOutput;

const BASH = {
  tool_name: "Bash",
  tool_input: { command: "git push --force origin main" },
  cwd: "/Users/someone/dev/thing",
};

describe("ask", () => {
  test("an approved question allows the tool call", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ action_id: "allow" }) },
    });
    const { out } = await run("ask", BASH, { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" });
    api.close();
    assert.equal(verdict(out).permissionDecision, "allow");
  });

  test("a denied question denies it", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ action_id: "deny" }) },
    });
    const { out } = await run("ask", BASH, { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" });
    api.close();
    assert.equal(verdict(out).permissionDecision, "deny");
  });

  test("a typed reply denies, and hands the words to Claude", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ text: "rebase instead" }) },
    });
    const { out } = await run("ask", BASH, { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" });
    api.close();
    assert.equal(verdict(out).permissionDecision, "deny");
    assert.match(verdict(out).permissionDecisionReason, /rebase instead/);
  });

  // The rest of this block is the same assertion over and over on purpose. Every
  // way this hook can fail must land on `ask`, which is the behaviour the user
  // had before they installed it. An `allow` nobody tapped is the one outcome
  // that would make this tool dangerous.
  test("a timeout falls through to the local prompt", async () => {
    const api = await fakeApi({ interaction: { status: "pending", response: null } });
    const { out } = await run("ask", BASH, { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" });
    api.close();
    assert.equal(verdict(out).permissionDecision, "ask");
  });

  test("a server error falls through", async () => {
    const api = await fakeApi({ status: 500 });
    const { out } = await run("ask", BASH, { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" });
    api.close();
    assert.equal(verdict(out).permissionDecision, "ask");
  });

  test("an unreachable server falls through", async () => {
    // Port 1 with nothing on it: the connection is refused immediately.
    const { out } = await run("ask", BASH, {
      PUSHCLOUD_API: "http://127.0.0.1:1",
      PUSHCLOUD_KEY: "pck_x",
      PUSHCLOUD_TOKEN: "pca_x",
    });
    assert.equal(verdict(out).permissionDecision, "ask");
  });

  test("no credentials configured falls through", async () => {
    const { out } = await run("ask", BASH, { PUSHCLOUD_KEY: "", PUSHCLOUD_TOKEN: "" });
    assert.equal(verdict(out).permissionDecision, "ask");
  });

  test("a key without an application token falls through", async () => {
    // The two credentials are not interchangeable: sending needs the pca_
    // token, and going ahead with only half of them would send nothing and
    // wait on nothing while looking like it worked.
    const { out } = await run("ask", BASH, { PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "" });
    assert.equal(verdict(out).permissionDecision, "ask");
  });

  test("an unreadable answer falls through rather than guessing", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ action_id: "maybe" }) },
    });
    const { out } = await run("ask", BASH, { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" });
    api.close();
    assert.equal(verdict(out).permissionDecision, "ask");
  });

  test("a message with no question attached falls through", async () => {
    const api = await fakeApi({ noQuestion: true });
    const { out } = await run("ask", BASH, { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" });
    api.close();
    assert.equal(verdict(out).permissionDecision, "ask");
  });

  test("garbage on stdin falls through", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ action_id: "allow" }) },
    });
    const child = spawn(process.execPath, [HOOK, "ask"], {
      env: { ...process.env, PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.end("not json at all");
    await new Promise((r) => child.on("close", r));
    api.close();
    // It still asks the phone (there is nothing unsafe about that), but the
    // point is that it does not crash and leave Claude Code with no verdict.
    assert.ok(["allow", "ask"].includes(verdict(out).permissionDecision));
  });
});

describe("what lands on the lock screen", () => {
  test("a bash command is the message, and the project is the title", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ action_id: "allow" }) },
    });
    await run("ask", BASH, {
      PUSHCLOUD_API: api.origin,
      PUSHCLOUD_KEY: "pck_x",
      PUSHCLOUD_TOKEN: "pca_x",
      PUSHCLOUD_MACHINE: "dev-laptop",
    });
    api.close();
    const send = JSON.parse(api.seen.find((r) => r.path === "/v1/messages").body);
    assert.equal(send.message, "git push --force origin main");
    assert.equal(send.title, "dev-laptop · thing");
    assert.equal(send.priority, 1);
    // A reply action alongside the buttons, or the server rejects a typed
    // answer and the hook's own reply branch can never be reached.
    assert.deepEqual(
      send.actions.map((a) => `${a.id}:${a.type}`),
      ["allow:button", "deny:button", "reason:reply"]
    );
  });

  test("a long command is truncated rather than sent whole", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ action_id: "allow" }) },
    });
    await run(
      "ask",
      { tool_name: "Bash", tool_input: { command: "x".repeat(5000) }, cwd: "/tmp/p" },
      { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" }
    );
    api.close();
    const send = JSON.parse(api.seen.find((r) => r.path === "/v1/messages").body);
    assert.ok(send.message.length < 400, `message was ${send.message.length} chars`);
    assert.ok(send.message.endsWith("..."));
  });

  test("a file tool leads with the path", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ action_id: "allow" }) },
    });
    await run(
      "ask",
      { tool_name: "Write", tool_input: { file_path: "/etc/hosts" }, cwd: "/tmp/p" },
      { PUSHCLOUD_API: api.origin, PUSHCLOUD_KEY: "pck_x", PUSHCLOUD_TOKEN: "pca_x" }
    );
    api.close();
    const send = JSON.parse(api.seen.find((r) => r.path === "/v1/messages").body);
    assert.equal(send.message, "Write /etc/hosts");
  });

  test("the wait is authenticated and carries the id the send returned", async () => {
    const api = await fakeApi({
      interaction: { status: "responded", response: JSON.stringify({ action_id: "allow" }) },
    });
    await run("ask", BASH, {
      PUSHCLOUD_API: api.origin,
      PUSHCLOUD_KEY: "pck_secret",
      PUSHCLOUD_TOKEN: "pca_sender",
      PUSHCLOUD_WAIT_SECONDS: "30",
    });
    api.close();
    const wait = api.seen.find((r) => r.path.startsWith("/v1/interactions"));
    assert.equal(wait.path, "/v1/interactions/i1/wait?timeout=30");
    assert.equal(wait.auth, "Bearer pck_secret");
    // And the send went out as the application, not as the account key.
    assert.equal(api.seen.find((r) => r.path === "/v1/messages").auth, "Bearer pca_sender");
  });
});

describe("notify", () => {
  test("sends a plain message and decides nothing", async () => {
    const api = await fakeApi({});
    const { out } = await run("notify", { message: "Run finished" }, {
      PUSHCLOUD_API: api.origin,
      PUSHCLOUD_KEY: "pck_x",
      PUSHCLOUD_TOKEN: "pca_x",
    });
    api.close();
    // No verdict on stdout: a Stop hook that printed a permission decision would
    // be Claude Code's input for something it never asked about.
    assert.equal(out, "");
    const send = JSON.parse(api.seen[0].body);
    assert.equal(send.message, "Run finished");
    assert.equal(api.seen.length, 1, "must not wait on anything");
  });

  test("stays silent when the server is down", async () => {
    const { out, err, code } = await run("notify", { message: "x" }, {
      PUSHCLOUD_API: "http://127.0.0.1:1",
      PUSHCLOUD_KEY: "pck_x",
      PUSHCLOUD_TOKEN: "pca_x",
    });
    assert.equal(out, "");
    assert.equal(err, "");
    assert.equal(code, 0);
  });
});

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SETUP = fileURLToPath(new URL("../src/setup.mjs", import.meta.url));

const CONNECTED = (origin) => ({
  status: "connected",
  agent: "claude-code",
  mcp: { url: `${origin}/mcp`, headers: { Authorization: "Bearer pcm_0123456789abcdef0123456789abcdef01234567" } },
  application: { id: "app_1", name: "Claude Code", token: "pca_paired" },
  connection: { id: "conn_1", label: "test-box" },
  api: origin,
});

/// What the stub answers, per path. Each entry is a function (req, body) returning
/// `{ status, json }` or the string "drop" to kill the socket without a response.
let script;
/// Every request the stub saw.
let seen;
let api;

const json = (status, body) => ({ status, json: body });
const claimOk = () => json(202, { claim_id: "pair_1", claim_secret: "pcs_secret", expires_in: 300, interval: 0 });
const err = (status, code, message = code) => json(status, { error: { code, message } });

/// Answers from a queue, repeating the last one.
const queue = (...answers) => {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)]();
};

before(async () => {
  const server = createServer(async (req, res) => {
    const body = await new Promise((r) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => r(raw));
    });
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
    const route = req.url.startsWith("/v1/pairings/claim/wait")
      ? "wait"
      : req.url.startsWith("/v1/pairings/claim")
        ? "claim"
        : req.url.startsWith("/v1/messages")
          ? "messages"
          : req.url.includes("/wait")
            ? "answer"
            : "other";
    const answer = script[route]?.(req, body) ?? err(404, "NOT_FOUND");
    if (answer === "drop") return req.socket.destroy();
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer.json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  api = { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
});

after(() => api.close());

beforeEach(() => {
  seen = [];
  script = {
    claim: claimOk,
    wait: queue(
      () => json(200, { status: "awaiting_confirmation" }),
      () => json(200, { status: "awaiting_confirmation" }),
      () => json(200, CONNECTED(api.origin))
    ),
    messages: () => json(201, { message: { id: "m1" }, interaction_id: "i1" }),
    answer: () =>
      json(200, { interaction: { status: "responded", response: JSON.stringify({ action_id: "allow" }) } }),
  };
});

/// A fresh home, and a PATH holding only a stub `claude` that records its argv.
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "pushcloud-pair-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pushcloud-pair-bin-"));
  const argv = join(bin, "argv.txt");
  // One JSON array per call, so the argv boundaries survive.
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`
  );
  chmodSync(join(bin, "claude"), 0o755);
  return { home, bin, argv };
}

const argvCalls = (box) =>
  existsSync(box.argv) ? readFileSync(box.argv, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

function run(args, box) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SETUP, ...args], {
      // Built from nothing, so a PUSHCLOUD_* in the developer's shell cannot leak in.
      env: { HOME: box.home, PATH: box.bin, PUSHCLOUD_API: api.origin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ out, err, all: out + err, code }));
  });
}

const pushcloudDir = (box) => join(box.home, ".pushcloud");
const nothingWritten = (box) => {
  assert.equal(existsSync(pushcloudDir(box)), false, "nothing under ~/.pushcloud");
  assert.equal(existsSync(join(box.home, ".claude")), false, "nothing under ~/.claude");
};
const claims = () => seen.filter((r) => r.path.startsWith("/v1/pairings/claim") && !r.path.includes("/wait"));

describe("pushcloud pair", () => {
  test("claim, two waits, connected: config, hooks, test question, done", async () => {
    const box = sandbox();
    const { code, out, all } = await run(["pair", "482913", "--machine", "test-box"], box);
    assert.equal(code, 0, all);

    const configPath = join(pushcloudDir(box), "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.token, "pca_paired");
    assert.equal(config.machine, "test-box");
    assert.equal(config.api, api.origin);
    assert.equal("key" in config, false, "no pck_ key is saved");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    // The claim response carries no agent, so the confirm line cannot name one.
    assert.match(out, /Confirm on your phone: Connect an agent on test-box\?/);
    assert.match(out, /Done\. Start a new Claude Code session \(or run \/mcp\) to load the PushCloud tools\./);

    // The wait loop ran three times with the claim secret, and never re-posted the claim.
    const waits = seen.filter((r) => r.path.startsWith("/v1/pairings/claim/wait"));
    assert.equal(waits.length, 3);
    assert.ok(waits.every((r) => r.method === "POST" && r.auth === "Bearer pcs_secret"));
    assert.ok(waits.every((r) => r.path.includes("wait=25")));
    assert.equal(claims().length, 1);

    // The test question goes out with the app token and is waited on with it.
    const sent = seen.find((r) => r.path.startsWith("/v1/messages"));
    assert.equal(sent.auth, "Bearer pca_paired");
    const body = JSON.parse(sent.body);
    assert.equal(body.title, "test-box · setup");
    assert.equal(body.message, "This is PushCloud asking. Tap Approve to finish setting up.");
    const answered = seen.find((r) => r.path.startsWith("/v1/interactions/i1/wait"));
    assert.equal(answered.auth, "Bearer pca_paired");

    // Hooks installed and pointing at ~/.pushcloud/bin; the skill beside them.
    const hook = join(pushcloudDir(box), "bin", "pushcloud-hook.mjs");
    assert.ok(existsSync(hook));
    const settings = JSON.parse(readFileSync(join(box.home, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.startsWith(`node "${hook}"`));
    assert.ok(existsSync(join(box.home, ".claude", "skills", "pushcloud", "SKILL.md")));

    // The MCP server registered through the stub `claude`: remove, then add.
    const mcp = CONNECTED(api.origin).mcp;
    assert.deepEqual(argvCalls(box), [
      ["mcp", "remove", "pushcloud", "--scope", "user"],
      ["mcp", "add", "--transport", "http", "--scope", "user", "pushcloud", mcp.url, "--header", `Authorization: ${mcp.headers.Authorization}`],
    ]);
  });

  test("the test question failing after setup is written: noted, exit 0", async () => {
    const box = sandbox();
    script.messages = () => err(500, "BOOM");
    const { code, all } = await run(["pair", "482913", "--machine", "test-box"], box);
    assert.equal(code, 0, all);
    assert.ok(existsSync(join(pushcloudDir(box), "config.json")));
    assert.match(all, /setup is written/i);
    assert.match(all, /Done\./);
  });

  test("no claude on PATH: the add command is printed and nothing is run", async () => {
    const box = sandbox();
    rmSync(join(box.bin, "claude"));
    const { code, out, all } = await run(["pair", "482913", "--no-test"], box);
    assert.equal(code, 0, all);
    const mcp = CONNECTED(api.origin).mcp;
    assert.ok(
      out.includes(`claude mcp add --transport http --scope user pushcloud ${mcp.url} --header "Authorization: ${mcp.headers.Authorization}"`),
      out
    );
    assert.deepEqual(argvCalls(box), []);
  });

  test("a Cursor pairing writes ~/.cursor/mcp.json and hooks.json, and no Claude settings", async () => {
    const box = sandbox();
    script.wait = () => json(200, { ...CONNECTED(api.origin), agent: "cursor" });
    const { code, all } = await run(["pair", "482913", "--no-test"], box);
    assert.equal(code, 0, all);
    const mcp = JSON.parse(readFileSync(join(box.home, ".cursor", "mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers.pushcloud, CONNECTED(api.origin).mcp);
    assert.ok(existsSync(join(box.home, ".cursor", "hooks.json")));
    assert.equal(existsSync(join(box.home, ".claude")), false);
    assert.deepEqual(argvCalls(box), []);
  });

  test("names the agent in the confirm line when the claim does", async () => {
    const box = sandbox();
    script.claim = () => json(202, { ...claimOk().json, agent: "cursor" });
    const { out } = await run(["pair", "482913", "--machine", "test-box", "--no-test"], box);
    assert.match(out, /Confirm on your phone: Connect Cursor on test-box\?/);
  });

  test("the claim body carries the code, the machine and the client", async () => {
    const box = sandbox();
    await run(["pair", "482 913", "--machine", "test-box", "--no-test"], box);
    assert.deepEqual(JSON.parse(claims()[0].body), {
      code: "482913",
      machine: "test-box",
      client: "pushcloud-cli/0.2.0",
    });
  });

  test("the machine defaults to the hostname", async () => {
    const box = sandbox();
    await run(["pair", "482913", "--no-test"], box);
    assert.equal(JSON.parse(claims()[0].body).machine, hostname());
  });

  test("404 on the claim: the invalid message, exit 1, nothing written", async () => {
    const box = sandbox();
    script.claim = () => err(404, "PAIRING_CODE_INVALID");
    const { code, all } = await run(["pair", "482913"], box);
    assert.equal(code, 1);
    assert.match(all, /That code isn't valid or has expired\. Get a new one on your phone\./);
    nothingWritten(box);
  });

  test("409 on the claim: the used message", async () => {
    const box = sandbox();
    script.claim = () => err(409, "PAIRING_CODE_USED");
    const { code, all } = await run(["pair", "482913"], box);
    assert.equal(code, 1);
    assert.match(all, /That code was used by two machines, so it was cancelled\. Get a new one on your phone\./);
    nothingWritten(box);
  });

  test("a dropped connection on the claim: the network message and exactly one claim", async () => {
    const box = sandbox();
    script.claim = () => "drop";
    const { code, all } = await run(["pair", "482913"], box);
    assert.equal(code, 1);
    assert.match(all, /Couldn't reach PushCloud\. Get a new code on your phone and try again\./);
    // A retry would be a second claim, and a second claim burns the code.
    assert.equal(claims().length, 1);
    nothingWritten(box);
  });

  test("403 on the wait: the denied message, nothing written", async () => {
    const box = sandbox();
    script.wait = () => err(403, "PAIRING_DENIED");
    const { code, all } = await run(["pair", "482913"], box);
    assert.equal(code, 1);
    assert.match(all, /Cancelled on your phone\. Nothing was changed on this machine\./);
    nothingWritten(box);
  });

  test("410 PAIRING_EXPIRED on the wait: the expired message", async () => {
    const box = sandbox();
    script.wait = queue(() => json(200, { status: "awaiting_confirmation" }), () => err(410, "PAIRING_EXPIRED"));
    const { code, all } = await run(["pair", "482913"], box);
    assert.equal(code, 1);
    assert.match(all, /The code expired before it was confirmed\. Get a new one on your phone\./);
    nothingWritten(box);
  });

  test("409 on the wait: the used message", async () => {
    const box = sandbox();
    script.wait = () => err(409, "PAIRING_CODE_USED");
    const { code, all } = await run(["pair", "482913"], box);
    assert.equal(code, 1);
    assert.match(all, /That code was used by two machines, so it was cancelled\. Get a new one on your phone\./);
    nothingWritten(box);
  });

  test("a dropped connection during the wait is retried, without a second claim", async () => {
    const box = sandbox();
    script.wait = queue(
      () => "drop",
      () => json(200, { status: "awaiting_confirmation" }),
      () => json(200, CONNECTED(api.origin))
    );
    const { code, all } = await run(["pair", "482913", "--no-test"], box);
    assert.equal(code, 0, all);
    assert.equal(claims().length, 1);
    assert.equal(JSON.parse(readFileSync(join(pushcloudDir(box), "config.json"), "utf8")).token, "pca_paired");
  });

  test("--no-test sends no /v1/messages", async () => {
    const box = sandbox();
    const { code, all } = await run(["pair", "482913", "--no-test"], box);
    assert.equal(code, 0, all);
    assert.equal(seen.filter((r) => r.path.startsWith("/v1/messages")).length, 0);
    assert.match(all, /Done\. Start a new Claude Code session/);
  });

  test("--config, --claude-settings and --skills-dir apply", async () => {
    const box = sandbox();
    const dir = mkdtempSync(join(tmpdir(), "pushcloud-pair-ws-"));
    const config = join(dir, "config.json");
    const settings = join(dir, "settings.json");
    const skills = join(dir, "skills");
    const { code, all } = await run(
      ["pair", "482913", "--no-test", "--config", config, "--claude-settings", settings, "--skills-dir", skills],
      box
    );
    assert.equal(code, 0, all);
    assert.equal(JSON.parse(readFileSync(config, "utf8")).token, "pca_paired");
    assert.ok(JSON.parse(readFileSync(settings, "utf8")).hooks.PreToolUse);
    assert.ok(existsSync(join(skills, "pushcloud", "SKILL.md")));
    assert.equal(existsSync(join(box.home, ".claude")), false);
  });

  test("an existing encryption key survives the pairing", async () => {
    const box = sandbox();
    mkdirSync(pushcloudDir(box), { recursive: true });
    const e2ee = "ab".repeat(32);
    writeFileSync(join(pushcloudDir(box), "config.json"), JSON.stringify({ e2ee_key: e2ee, key: "pck_old" }));
    const { code, all } = await run(["pair", "482913", "--no-test"], box);
    assert.equal(code, 0, all);
    const config = JSON.parse(readFileSync(join(pushcloudDir(box), "config.json"), "utf8"));
    assert.equal(config.e2ee_key, e2ee);
    assert.equal("key" in config, false);
  });

  test("no code: a usage line, exit 1, nothing sent", async () => {
    const box = sandbox();
    const { code, all } = await run(["pair"], box);
    assert.equal(code, 1);
    assert.match(all, /pushcloud pair <code>/);
    assert.equal(seen.length, 0);
  });
});

describe("pair.mjs", () => {
  test("CLIENT comes from package.json and AGENT_ID maps the server's slugs", async () => {
    const { CLIENT, AGENT_ID } = await import("../src/pair.mjs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(CLIENT, `pushcloud-cli/${pkg.version}`);
    assert.equal(CLIENT, "pushcloud-cli/0.2.0");
    assert.deepEqual(AGENT_ID, { "claude-code": "claude", codex: "codex", cursor: "cursor", other: null });
  });

  test("waitConnected stops when its signal aborts", async () => {
    const { waitConnected, PairError } = await import("../src/pair.mjs");
    script.wait = () => json(200, { status: "awaiting_confirmation" });
    const ac = new AbortController();
    let ticks = 0;
    const p = waitConnected(api.origin, "pcs_secret", {
      interval: 0.05,
      signal: ac.signal,
      onTick: () => {
        if (++ticks === 2) ac.abort();
      },
    });
    await assert.rejects(p, (e) => e instanceof PairError && e.kind === "cancelled");
  });

  test("claim never retries: a 500 is one request and a network error", async () => {
    const { claim, PairError } = await import("../src/pair.mjs");
    script.claim = () => err(500, "INTERNAL");
    await assert.rejects(claim(api.origin, { code: "482913", machine: "m" }), (e) => e instanceof PairError && e.kind === "network");
    assert.equal(claims().length, 1);
  });

  test("claim maps 429 to rate_limited", async () => {
    const { claim, PairError } = await import("../src/pair.mjs");
    script.claim = () => err(429, "RATE_LIMITED", "Too many pairing attempts; retry in 5 minutes");
    await assert.rejects(claim(api.origin, { code: "482913", machine: "m" }), (e) => e instanceof PairError && e.kind === "rate_limited");
  });

  test("waitConnected maps 410 PAIRING_COLLECTED to collected", async () => {
    const { waitConnected, PairError } = await import("../src/pair.mjs");
    script.wait = () => err(410, "PAIRING_COLLECTED");
    await assert.rejects(
      waitConnected(api.origin, "pcs_secret", { interval: 0 }),
      (e) => e instanceof PairError && e.kind === "collected"
    );
  });
});

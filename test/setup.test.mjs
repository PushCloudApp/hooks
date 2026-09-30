import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const SETUP = fileURLToPath(new URL("../src/setup.mjs", import.meta.url));
const PACKAGE = fileURLToPath(new URL("../", import.meta.url));

/// A home directory with a ~/.claude in it, so Claude Code is detected, and
/// nothing a test does can reach the real one.
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "pushcloud-home-"));
  mkdirSync(join(home, ".claude"));
  return home;
}
const sharedHome = tempHome();

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
      // A token the server will not let wait on its own question.
      if (req.headers.authorization === "Bearer pca_nowait") {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
      }
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
      env: { ...process.env, HOME: sharedHome, PUSHCLOUD_API: api.origin, ...env },
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
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /pushcloud-hook\.mjs" ask --agent claude$/);

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

  test("the hook command points at ~/.pushcloud/bin, never the npx cache", async () => {
    const w = workspace();
    const home = tempHome();
    const { code, out, err } = await run(good(w, ["--no-test"]), { HOME: home });
    assert.equal(code, 0, out + err);
    const bin = join(home, ".pushcloud", "bin");
    const settings = JSON.parse(readFileSync(w.settings, "utf8"));
    const commands = [
      ...settings.hooks.PreToolUse.flatMap((e) => e.hooks),
      ...(settings.hooks.Stop ?? []).flatMap((e) => e.hooks),
    ].map((h) => h.command);
    assert.ok(commands.length > 0);
    for (const c of commands) {
      assert.ok(c.startsWith(`node "${join(bin, "pushcloud-hook.mjs")}"`), c);
      assert.doesNotMatch(c, /_npx/);
      assert.ok(!c.includes(PACKAGE), `${c} should not point into the package`);
    }
    assert.ok(existsSync(join(bin, "pushcloud-hook.mjs")));
  });

  test("remove deletes ~/.pushcloud/bin", async () => {
    const w = workspace();
    const home = tempHome();
    await run(good(w, ["--no-test"]), { HOME: home });
    assert.ok(existsSync(join(home, ".pushcloud", "bin")));
    const { code } = await run(["remove", "--claude-settings", w.settings], { HOME: home });
    assert.equal(code, 0);
    assert.equal(existsSync(join(home, ".pushcloud", "bin")), false);
  });

  test("remove unregisters the MCP server when claude is on PATH", async () => {
    const w = workspace();
    const home = tempHome();
    const stubs = mkdtempSync(join(tmpdir(), "pushcloud-stub-"));
    const argvFile = join(stubs, "argv.txt");
    writeFileSync(join(stubs, "claude"), `#!/bin/sh\necho "$@" >> "${argvFile}"\nexit 1\n`);
    chmodSync(join(stubs, "claude"), 0o755);
    const { code } = await run(["remove", "--claude-settings", w.settings], {
      HOME: home,
      PATH: `${stubs}${delimiter}${process.env.PATH}`,
    });
    // The stub exits 1: a failed unregister must not fail the uninstall.
    assert.equal(code, 0);
    assert.equal(readFileSync(argvFile, "utf8").trim(), "mcp remove pushcloud --scope user");
  });

  test("remove also strips the pushcloud entry from Codex and Cursor configs", async () => {
    const w = workspace();
    const home = tempHome();
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'model = "o3"\n\n[mcp_servers.pushcloud]\nurl = "u"\nhttp_headers = { Authorization = "Bearer pcm_x" }\n'
    );
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { pushcloud: { url: "u" }, keep: { url: "k" } } })
    );
    const { code } = await run(["remove", "--claude-settings", w.settings], { HOME: home });
    assert.equal(code, 0);
    assert.doesNotMatch(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /pushcloud|pcm_/);
    assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /model = "o3"/);
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers, { keep: { url: "k" } });
  });

  test("without a terminal it says so rather than hanging", async () => {
    const w = workspace();
    const { code, err } = await run(["setup", "--config", w.config, "--claude-settings", w.settings]);
    assert.equal(code, 1);
    assert.match(err, /--token/);
  });
});

describe("token-only setup", () => {
  const tokenOnly = (w, token, extra = []) => [
    "setup",
    "--token",
    token,
    "--claude-settings",
    w.settings,
    "--config",
    w.config,
    ...extra,
  ];

  test("a token that can wait needs no key, and none is written", async () => {
    const w = workspace();
    seen = [];
    const { out, err, code } = await run(tokenOnly(w, "pca_good"));
    assert.equal(code, 0, out + err);
    const config = JSON.parse(readFileSync(w.config, "utf8"));
    assert.equal(config.token, "pca_good");
    assert.ok(!("key" in config) || config.key == null);
    assert.ok(seen.some((r) => r.path.includes("/wait?timeout=1") && r.auth === "Bearer pca_good"));
    assert.ok(!seen.some((r) => r.path.startsWith("/v1/interactions?")), "no key check");
    assert.match(out, /Done\. Your agent can reach you\./);
  });

  test("a token the server refuses to wait with falls back to a key", async () => {
    const w = workspace();
    seen = [];
    const { out, err, code } = await run(tokenOnly(w, "pca_nowait", ["--key", "pck_good"]));
    assert.equal(code, 0, out + err);
    assert.equal(JSON.parse(readFileSync(w.config, "utf8")).key, "pck_good");
    assert.ok(seen.some((r) => r.path.includes("/wait?timeout=1") && r.auth === "Bearer pca_nowait"));
  });

  test("a refused token and no key stops without writing", async () => {
    const w = workspace();
    const { code, err } = await run(tokenOnly(w, "pca_nowait"));
    assert.equal(code, 1);
    assert.match(err, /--key/);
    assert.equal(existsSync(w.config), false);
    assert.equal(existsSync(w.settings), false);
  });
});

describe("package", () => {
  test("help lists pair first", async () => {
    const { out } = await run(["help"]);
    const lines = out.split("\n");
    const usage = lines.find((l) => l.startsWith("usage:"));
    assert.match(usage, /<pair\|setup/);
    const cmds = lines.filter((l) => /^  (pair|setup|remove|test)\b/.test(l));
    assert.match(cmds[0], /^  pair/);
  });

  test("version is 0.2.0 with no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
    assert.equal(pkg.version, "0.2.0");
    assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  });
});

describe("the skill", () => {
  test("is installed alongside the hooks", async () => {
    const w = workspace();
    const skills = join(w.dir, "skills");
    await run(good(w, ["--no-test", "--skills-dir", skills]));

    const skill = readFileSync(join(skills, "pushcloud", "SKILL.md"), "utf8");
    // The frontmatter is what makes it a skill rather than a stray markdown file:
    // without a description the agent has nothing to match against.
    assert.match(skill, /^---\n/);
    assert.match(skill, /^name: pushcloud$/m);
    assert.match(skill, /^description: .+/m);
  });

  test("remove takes it away again", async () => {
    const w = workspace();
    const skills = join(w.dir, "skills");
    await run(good(w, ["--no-test", "--skills-dir", skills]));
    await run(["remove", "--claude-settings", w.settings, "--skills-dir", skills]);
    assert.equal(existsSync(join(skills, "pushcloud", "SKILL.md")), false);
  });

  test("a skills directory that cannot be written does not fail the setup", async () => {
    // The hooks are the part that has to work. A skill that could not be copied
    // is a worse outcome than no skill, only if it takes the install down with it.
    const w = workspace();
    const { code } = await run(good(w, ["--no-test", "--skills-dir", "/proc/nope/nowhere"]));
    assert.equal(code, 0);
    assert.ok(existsSync(w.settings));
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAgent, upsertCodexToml, mergeCursorMcp } from "../src/mcp-config.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const URL_ = "https://pushcloud.app/mcp";
const AUTH = "Bearer pcm_0123456789abcdef0123456789abcdef01234567";
const PAYLOAD = {
  status: "connected",
  agent: "claude-code",
  mcp: { url: URL_, headers: { Authorization: AUTH } },
  application: { id: "app_1", name: "Claude Code", token: "pca_paired" },
  api: "https://pushcloud.app",
};

/// A fresh home, and a bin directory holding stub executables for `names`.
function box(names = []) {
  const home = mkdtempSync(join(tmpdir(), "pushcloud-mcp-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pushcloud-mcp-bin-"));
  for (const n of names) {
    writeFileSync(join(bin, n), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, n), 0o755);
  }
  return { home, env: { PATH: bin } };
}

/// A `run` that records every call and answers from `answer(cmd, args)`.
function recorder(answer = () => ({ status: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return answer(cmd, args);
  };
  return { calls, run };
}

function sayer() {
  const lines = [];
  return { lines, say: (s = "") => lines.push(s), text: () => lines.join("\n") };
}

const CLAUDE_ADD = ["mcp", "add", "--transport", "http", "--scope", "user", "pushcloud", URL_, "--header", `Authorization: ${AUTH}`];
const CLAUDE_COMMAND = `claude mcp add --transport http --scope user pushcloud ${URL_} --header "Authorization: ${AUTH}"`;

describe("upsertCodexToml", () => {
  test("before -> after, byte for byte", () => {
    const out = upsertCodexToml(fixture("codex-config.before.toml"), { url: URL_, authorization: AUTH });
    assert.equal(out, fixture("codex-config.after.toml"));
  });

  test("the other server and the top-level model survive", () => {
    const out = upsertCodexToml(fixture("codex-config.before.toml"), { url: URL_, authorization: AUTH });
    assert.match(out, /^model = "gpt-5-codex"$/m);
    assert.match(out, /^\[mcp_servers\.other\]\ncommand = "npx"\nargs = \["-y", "other-mcp"\]$/m);
    assert.doesNotMatch(out, /pcm_old|old\.example|startup_timeout_sec/);
  });

  test("running it twice gives the same text", () => {
    const once = upsertCodexToml(fixture("codex-config.before.toml"), { url: URL_, authorization: AUTH });
    assert.equal(upsertCodexToml(once, { url: URL_, authorization: AUTH }), once);
  });

  test("an empty file gets just the block", () => {
    assert.equal(
      upsertCodexToml("", { url: URL_, authorization: AUTH }),
      `[mcp_servers.pushcloud]\nurl = "${URL_}"\nhttp_headers = { Authorization = "${AUTH}" }\n`
    );
  });

  test("a quoted table name is still ours, and a lookalike name is not", () => {
    const text = `[mcp_servers."pushcloud"]\nurl = "x"\n\n[mcp_servers.pushcloud2]\nurl = "y"\n`;
    const out = upsertCodexToml(text, { url: URL_, authorization: AUTH });
    assert.doesNotMatch(out, /url = "x"/);
    assert.match(out, /\[mcp_servers\.pushcloud2\]\nurl = "y"/);
  });

  test("strings are escaped", () => {
    const out = upsertCodexToml("", { url: 'https://a/"b\\', authorization: AUTH });
    assert.match(out, /url = "https:\/\/a\/\\"b\\\\"/);
  });
});

describe("mergeCursorMcp", () => {
  test("keeps other servers and replaces only pushcloud", () => {
    const before = {
      mcpServers: { other: { command: "x" }, pushcloud: { url: "old", headers: { Authorization: "old" } } },
      extra: true,
    };
    const out = mergeCursorMcp(before, { url: URL_, headers: { Authorization: AUTH } });
    assert.deepEqual(out, {
      mcpServers: { other: { command: "x" }, pushcloud: { url: URL_, headers: { Authorization: AUTH } } },
      extra: true,
    });
    assert.equal(before.mcpServers.pushcloud.url, "old", "the input is not mutated");
  });

  test("an empty file gets an mcpServers object", () => {
    assert.deepEqual(mergeCursorMcp({}, { url: URL_, headers: { Authorization: AUTH } }), {
      mcpServers: { pushcloud: { url: URL_, headers: { Authorization: AUTH } } },
    });
  });
});

describe("configureAgent: Claude Code", () => {
  test("claude on PATH: remove, then add, with the exact argv", async () => {
    const b = box(["claude"]);
    const { calls, run } = recorder();
    const s = sayer();
    await configureAgent("claude-code", PAYLOAD, { home: b.home, env: b.env, say: s.say, run });
    assert.deepEqual(calls, [
      ["claude", "mcp", "remove", "pushcloud", "--scope", "user"],
      ["claude", ...CLAUDE_ADD],
    ]);
    assert.doesNotMatch(s.text(), /claude mcp add/, "nothing left for the user to run");
    const settings = JSON.parse(readFileSync(join(b.home, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(".pushcloud/bin/pushcloud-hook.mjs"));
  });

  test("a failing remove is ignored", async () => {
    const b = box(["claude"]);
    const { calls, run } = recorder((cmd, args) => ({ status: args[1] === "remove" ? 1 : 0, stdout: "", stderr: "" }));
    await configureAgent("claude-code", PAYLOAD, { home: b.home, env: b.env, say: () => {}, run });
    assert.equal(calls.length, 2);
  });

  test("a failing add prints the command instead", async () => {
    const b = box(["claude"]);
    const { run } = recorder((cmd, args) => ({ status: args[1] === "add" ? 1 : 0, stdout: "", stderr: "boom" }));
    const s = sayer();
    await configureAgent("claude-code", PAYLOAD, { home: b.home, env: b.env, say: s.say, run });
    assert.ok(s.text().includes(CLAUDE_COMMAND), s.text());
  });

  test("no claude on PATH: the command is printed and nothing is run", async () => {
    const b = box([]);
    const { calls, run } = recorder();
    const s = sayer();
    await configureAgent("claude-code", PAYLOAD, { home: b.home, env: b.env, say: s.say, run });
    assert.deepEqual(calls, []);
    assert.ok(s.text().includes(CLAUDE_COMMAND), s.text());
    assert.ok(existsSync(join(b.home, ".claude", "settings.json")), "the hooks are still written");
  });

  test("--claude-settings moves the hooks file", async () => {
    const b = box([]);
    const path = join(b.home, "elsewhere", "settings.json");
    await configureAgent("claude-code", PAYLOAD, { home: b.home, env: b.env, claudeSettings: path, say: () => {}, run: recorder().run });
    assert.ok(JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse);
    assert.equal(existsSync(join(b.home, ".claude")), false);
  });

  test("a broken settings.json stops before anything is run or written", async () => {
    const b = box(["claude"]);
    mkdirSync(join(b.home, ".claude"));
    writeFileSync(join(b.home, ".claude", "settings.json"), "{ nope");
    const { calls, run } = recorder();
    await assert.rejects(
      configureAgent("claude-code", PAYLOAD, { home: b.home, env: b.env, say: () => {}, run }),
      /is not valid JSON/
    );
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(join(b.home, ".claude", "settings.json"), "utf8"), "{ nope");
  });
});

describe("configureAgent: Codex", () => {
  const codexPayload = { ...PAYLOAD, agent: "codex" };

  test("a Codex whose `mcp add` takes no header: config.toml and the PermissionRequest hook", async () => {
    const b = box(["codex"]);
    const { calls, run } = recorder((cmd, args) => ({
      status: 0,
      stdout: "Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)\n      --bearer-token-env-var <ENV_VAR>\n",
      stderr: "",
    }));
    mkdirSync(join(b.home, ".codex"));
    writeFileSync(join(b.home, ".codex", "config.toml"), 'model = "o3"\n');
    await configureAgent("codex", codexPayload, { home: b.home, env: b.env, say: () => {}, run });
    assert.deepEqual(calls, [["codex", "mcp", "add", "--help"]]);
    assert.equal(
      readFileSync(join(b.home, ".codex", "config.toml"), "utf8"),
      `model = "o3"\n\n[mcp_servers.pushcloud]\nurl = "${URL_}"\nhttp_headers = { Authorization = "${AUTH}" }\n`
    );
    const hooks = JSON.parse(readFileSync(join(b.home, ".codex", "hooks.json"), "utf8"));
    assert.ok(hooks.hooks.PermissionRequest[0].hooks[0].command.includes("ask --agent codex"));
  });

  test("no codex on PATH: config.toml is written anyway", async () => {
    const b = box([]);
    const { calls, run } = recorder();
    await configureAgent("codex", codexPayload, { home: b.home, env: b.env, say: () => {}, run });
    assert.deepEqual(calls, []);
    assert.match(readFileSync(join(b.home, ".codex", "config.toml"), "utf8"), /^\[mcp_servers\.pushcloud\]$/m);
  });

  test("a Codex that can add a header: `codex mcp add`, and no TOML edit", async () => {
    const b = box(["codex"]);
    const { calls, run } = recorder((cmd, args) => ({
      status: 0,
      stdout: args.includes("--help") ? "      --url <URL>\n      --header <KEY: VALUE>\n" : "",
      stderr: "",
    }));
    await configureAgent("codex", codexPayload, { home: b.home, env: b.env, say: () => {}, run });
    assert.deepEqual(calls, [
      ["codex", "mcp", "add", "--help"],
      ["codex", "mcp", "remove", "pushcloud"],
      ["codex", "mcp", "add", "pushcloud", "--url", URL_, "--header", `Authorization: ${AUTH}`],
    ]);
    assert.equal(existsSync(join(b.home, ".codex", "config.toml")), false);
    assert.ok(existsSync(join(b.home, ".codex", "hooks.json")));
  });

  test("if that `codex mcp add` fails, the TOML is written instead", async () => {
    const b = box(["codex"]);
    const { run } = recorder((cmd, args) => ({
      status: args[1] === "add" && !args.includes("--help") ? 2 : 0,
      stdout: args.includes("--help") ? "--url <URL>\n--header <H>\n" : "",
      stderr: "",
    }));
    await configureAgent("codex", codexPayload, { home: b.home, env: b.env, say: () => {}, run });
    assert.match(readFileSync(join(b.home, ".codex", "config.toml"), "utf8"), /Authorization = "Bearer pcm_/);
  });
});

describe("configureAgent: Cursor", () => {
  const cursorPayload = { ...PAYLOAD, agent: "cursor" };

  test("mcp.json merged, a one-time backup, and the beforeShellExecution hook", async () => {
    const b = box([]);
    const dir = join(b.home, ".cursor");
    mkdirSync(dir);
    const mcp = join(dir, "mcp.json");
    const original = JSON.stringify({ mcpServers: { other: { command: "x" } } });
    writeFileSync(mcp, original);

    await configureAgent("cursor", cursorPayload, { home: b.home, env: b.env, say: () => {}, run: recorder().run });
    const written = JSON.parse(readFileSync(mcp, "utf8"));
    assert.deepEqual(written.mcpServers, {
      other: { command: "x" },
      pushcloud: { url: URL_, headers: { Authorization: AUTH } },
    });
    assert.equal(readFileSync(`${mcp}.pushcloud-backup`, "utf8"), original);

    // A second run keeps the first backup: the file as it was before we touched it.
    await configureAgent("cursor", cursorPayload, { home: b.home, env: b.env, say: () => {}, run: recorder().run });
    assert.equal(readFileSync(`${mcp}.pushcloud-backup`, "utf8"), original);

    const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.beforeShellExecution.length, 1);
    assert.ok(hooks.hooks.beforeShellExecution[0].command.includes("ask --agent cursor"));
  });

  test("a broken mcp.json stops with the not-valid-JSON error and writes nothing", async () => {
    const b = box([]);
    const dir = join(b.home, ".cursor");
    mkdirSync(dir);
    writeFileSync(join(dir, "mcp.json"), "{ broken");
    await assert.rejects(
      configureAgent("cursor", cursorPayload, { home: b.home, env: b.env, say: () => {}, run: recorder().run }),
      /mcp\.json is not valid JSON/
    );
    assert.deepEqual(readdirSync(dir), ["mcp.json"]);
    assert.equal(readFileSync(join(dir, "mcp.json"), "utf8"), "{ broken");
  });
});

describe("configureAgent: Other", () => {
  test("prints the URL, the header and a pca_ send example, and writes nothing", async () => {
    const b = box(["claude", "codex"]);
    const { calls, run } = recorder();
    const s = sayer();
    await configureAgent("other", { ...PAYLOAD, agent: "other" }, { home: b.home, env: b.env, say: s.say, run });
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(b.home), []);
    const text = s.text();
    assert.ok(text.includes(URL_), text);
    assert.ok(text.includes(`Authorization: ${AUTH}`), text);
    assert.ok(text.includes("https://pushcloud.app/v1/messages"), text);
    assert.ok(text.includes("Authorization: Bearer pca_paired"), text);
  });
});

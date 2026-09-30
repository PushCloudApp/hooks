// Registering the PushCloud MCP server with the agent a pairing was made for,
// and writing that agent's approval hook beside it.
//
// Each agent keeps its MCP servers somewhere different:
//   Claude Code  its own CLI (`claude mcp add`), which owns ~/.claude.json
//   Codex        `codex mcp add` where it can take a header, else ~/.codex/config.toml
//   Cursor       ~/.cursor/mcp.json
//   Other        nowhere we know of: print what to paste, write nothing
//
// Every file an agent needs is read before anything is run or written, so a
// settings file we cannot parse stops the pairing with the machine untouched.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { agentById } from "./agents.mjs";
import { hookCommand, onPath } from "./install.mjs";
import { readSettings, writeSettings } from "./settings.mjs";

const NAME = "pushcloud";

// ---------------------------------------------------------------------------
// Codex config.toml
//
// Key names captured from codex-cli 0.159.1 and its config reference
// (https://developers.openai.com/codex/config-reference): a streamable HTTP
// server is `[mcp_servers.<name>]` with `url`, and static request headers go in
// `http_headers`. Pinned by test/fixtures/codex-config.after.toml, which that
// Codex reads back as `streamable_http` with the Authorization header.
// ---------------------------------------------------------------------------

/// A TOML basic string.
function tomlString(s) {
  const body = String(s).replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    if (c === "\\") return "\\\\";
    if (c === '"') return '\\"';
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `"${body}"`;
}

/// `[mcp_servers.pushcloud]` or any `[mcp_servers.pushcloud.<sub>]`, bare or quoted.
const OUR_HEADER = /^\[\s*mcp_servers\s*\.\s*(?:pushcloud|"pushcloud"|'pushcloud')\s*(?:\]|\.)/;
const ANY_HEADER = /^\[/;
const COMMENT = /^\s*#/;

/// Replaces the pushcloud server in a Codex config.toml, keeping every other byte.
///
/// Our table runs from its header to the next header at column 0, and takes its
/// dotted sub-tables with it. A comment sitting directly on top of the next
/// header belongs to that table, not ours, so it stays. The new block goes at
/// the end, which makes a second run a no-op.
export function upsertCodexToml(text, { url, authorization }) {
  const lines = (text ?? "").split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; ) {
    if (!OUR_HEADER.test(lines[i])) {
      kept.push(lines[i++]);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !(ANY_HEADER.test(lines[end]) && !OUR_HEADER.test(lines[end]))) end++;
    let keepFrom = end;
    if (end < lines.length) {
      while (keepFrom - 1 > i && COMMENT.test(lines[keepFrom - 1])) keepFrom--;
    }
    kept.push(...lines.slice(keepFrom, end));
    i = end;
  }
  // Blank lines at the very end are only the gap before our old block.
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const block = [
    `[mcp_servers.${NAME}]`,
    `url = ${tomlString(url)}`,
    `http_headers = { Authorization = ${tomlString(authorization)} }`,
  ].join("\n");
  return kept.length ? `${kept.join("\n")}\n\n${block}\n` : `${block}\n`;
}

// ---------------------------------------------------------------------------
// Cursor mcp.json
// ---------------------------------------------------------------------------

/// Sets mcpServers.pushcloud, leaving every other server and key alone.
export function mergeCursorMcp(json, { url, headers }) {
  const next = structuredClone(json ?? {});
  const servers = next.mcpServers && typeof next.mcpServers === "object" ? next.mcpServers : {};
  next.mcpServers = { ...servers, [NAME]: { url, headers: { ...headers } } };
  return next;
}

// ---------------------------------------------------------------------------
// Per agent
// ---------------------------------------------------------------------------

/// Hook settings for one of this package's agents, read now and written later.
function prepareHooks(agentId, { home, path, matcher, waitSeconds }) {
  const agent = agentById(agentId);
  const file = path ?? agent.config(home);
  const settings = readSettings(file);
  return {
    write(say) {
      writeSettings(
        file,
        agent.install(settings, { command: hookCommand(home), matcher: matcher ?? agent.defaultMatcher, waitSeconds })
      );
      say(`${agent.name}: hooks written to ${file}`);
    },
  };
}

const ok = (r) => r && !r.error && r.status === 0;

function claudeCode({ url, authorization }, ctx) {
  const hooks = prepareHooks("claude", { ...ctx, path: ctx.claudeSettings ? resolve(ctx.claudeSettings) : undefined });
  const add = ["mcp", "add", "--transport", "http", "--scope", "user", NAME, url, "--header", `Authorization: ${authorization}`];
  const command = `claude mcp add --transport http --scope user ${NAME} ${url} --header "Authorization: ${authorization}"`;

  let added = false;
  if (onPath("claude", ctx.env)) {
    // Remove first: `add` refuses a name that exists, and a re-pair must replace
    // the old key. A remove with nothing to remove fails, which is fine.
    ctx.exec("claude", ["mcp", "remove", NAME, "--scope", "user"]);
    added = ok(ctx.exec("claude", add));
    if (added) ctx.say("Claude Code: PushCloud MCP server added (user scope)");
  }
  if (!added) {
    ctx.say("Add the PushCloud tools to Claude Code with:");
    ctx.say(`  ${command}`);
  }
  hooks.write(ctx.say);
}

/// Whether this Codex can add an HTTP server with a static header from its CLI.
/// 0.159.1 cannot (it has --url and --bearer-token-env-var only).
function codexCanAddHeader(ctx) {
  if (!onPath("codex", ctx.env)) return false;
  const r = ctx.exec("codex", ["mcp", "add", "--help"]);
  const help = `${r?.stdout ?? ""}${r?.stderr ?? ""}`;
  return ok(r) && help.includes("--url") && help.includes("header");
}

function codex({ url, authorization }, ctx) {
  const tomlPath = join(ctx.home, ".codex", "config.toml");
  const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  const hooks = prepareHooks("codex", ctx);

  let added = false;
  if (codexCanAddHeader(ctx)) {
    ctx.exec("codex", ["mcp", "remove", NAME]);
    added = ok(ctx.exec("codex", ["mcp", "add", NAME, "--url", url, "--header", `Authorization: ${authorization}`]));
    if (added) ctx.say("Codex: PushCloud MCP server added");
  }
  if (!added) {
    mkdirSync(dirname(tomlPath), { recursive: true });
    writeFileSync(tomlPath, upsertCodexToml(toml, { url, authorization }));
    ctx.say(`Codex: PushCloud MCP server written to ${tomlPath}`);
  }
  hooks.write(ctx.say);
}

function cursor({ url, headers }, ctx) {
  const mcpPath = join(ctx.home, ".cursor", "mcp.json");
  const mcp = readSettings(mcpPath);
  const hooks = prepareHooks("cursor", ctx);
  writeSettings(mcpPath, mergeCursorMcp(mcp, { url, headers }));
  ctx.say(`Cursor: PushCloud MCP server written to ${mcpPath}`);
  hooks.write(ctx.say);
}

function other({ url, authorization }, { say, api, token }) {
  say("Add PushCloud to your agent as an MCP server:");
  say(`  URL     ${url}`);
  say(`  Header  Authorization: ${authorization}`);
  if (api && token) {
    say();
    say("To send a message from a script or an agent without MCP:");
    say(`  curl -X POST ${api}/v1/messages \\`);
    say(`    -H "Authorization: Bearer ${token}" \\`);
    say(`    -H "Content-Type: application/json" \\`);
    say(`    -d '{"title":"Hello","message":"Sent from my agent"}'`);
  }
}

const CONFIGURE = { "claude-code": claudeCode, codex, cursor, other };

/// Registers the MCP server from a `connected` payload with `agent` (the
/// server's slug), then writes that agent's approval hook.
///
/// `run` is spawnSync's signature; tests pass a recorder. `env` is where PATH
/// is looked up. Subprocesses see `home` as HOME, so an agent's own CLI writes
/// into the same home the hooks go to.
export async function configureAgent(
  agent,
  payload,
  { home = homedir(), claudeSettings, say = () => {}, run = spawnSync, env = process.env, matcher, waitSeconds = 120 } = {}
) {
  const configure = Object.hasOwn(CONFIGURE, agent) ? CONFIGURE[agent] : null;
  if (!configure) throw new Error(`unknown agent "${agent}"`);
  const url = payload?.mcp?.url;
  const headers = payload?.mcp?.headers ?? {};
  const authorization = headers.Authorization;
  if (!url || !authorization) throw new Error("the server connected but sent no MCP URL or key.");

  const exec = (cmd, args) => run(cmd, args, { encoding: "utf8", env: { ...env, HOME: home }, stdio: "pipe" });
  const ctx = {
    home,
    claudeSettings,
    say,
    env,
    exec,
    matcher,
    waitSeconds,
    api: payload.api,
    token: payload.application?.token,
  };
  configure({ url, headers, authorization }, ctx);
}

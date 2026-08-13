#!/usr/bin/env node
// `pushcloud setup` - wire a coding agent up to your phone.
//
// Four steps, in this order for a reason:
//
//   1. take the credentials,
//   2. check them against the API before writing anything,
//   3. write the config and the agent's hooks,
//   4. send a real question and make the user answer it on their phone.
//
// Step 2 is what stops a typo becoming "installed successfully" followed by a
// week of silence. Step 4 is what proves the loop end to end, and it is the
// only part of the setup a user will remember.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig, DEFAULT_CONFIG_PATH } from "./config.mjs";
import { AGENTS, agentById } from "./agents.mjs";
import { api, askQuestion, waitForAnswer } from "./api.mjs";
import { parseKey } from "./seal.mjs";

const HOOK = fileURLToPath(new URL("./pushcloud-hook.mjs", import.meta.url));
const SKILL = fileURLToPath(new URL("../skills/pushcloud/SKILL.md", import.meta.url));

const say = (s = "") => process.stdout.write(`${s}\n`);
const bold = (s) => (process.stdout.isTTY ? `[1m${s}[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `[2m${s}[0m` : s);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) args[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

/// Which agents this machine appears to have.
///
/// Presence of the config directory rather than a binary on PATH: an agent
/// installed through a GUI, a version manager or a per-project install may not
/// be on the PATH of whatever shell this runs in, and a false "not installed"
/// sends the user hunting for a problem they do not have.
export function detectAgents(home = homedir()) {
  return AGENTS.map((a) => {
    const config = a.config(home);
    return { agent: a, config, present: existsSync(dirname(config)) };
  });
}

/// Reads a settings file that may not exist, may be empty, or may be broken.
///
/// A parse failure stops the whole setup rather than being treated as an empty
/// object: writing our hooks over a file we could not read would silently
/// discard whatever the user had in there.
function readSettings(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Fix or move it, then run setup again.`);
  }
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  // A backup before the first write, and only the first: the point is to keep
  // the file as it was before this tool ever touched it, not to overwrite that
  // record with our own output on the second run.
  if (existsSync(path) && !existsSync(`${path}.pushcloud-backup`)) {
    copyFileSync(path, `${path}.pushcloud-backup`);
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

async function prompt(rl, question, existing) {
  if (existing) {
    const masked = `${existing.slice(0, 8)}...`;
    const answer = await rl.question(`${question} ${dim(`[${masked}]`)} `);
    return answer.trim() || existing;
  }
  return (await rl.question(`${question} `)).trim();
}

/// Proves the credentials before anything is written.
///
/// The two are checked differently because they can be. The key has a read
/// endpoint it either passes or fails, so it gets a real call. The token has
/// none: an application token can only send, and the send in step 4 is its
/// real test - so all that can be checked cheaply here is that the user has
/// not pasted the two values into each other's prompt, which is the mistake
/// they are actually going to make.
async function verify(cfg) {
  try {
    await api(cfg.api, "/v1/interactions?limit=1", cfg.key);
  } catch (err) {
    throw new Error(`that API key was refused (${err.message}). It needs the \`read\` scope.`);
  }
  if (!cfg.token.startsWith("pca_")) {
    throw new Error("that does not look like an application token (they start with `pca_`).");
  }
}

async function runSetup(args) {
  const configPath = args.config ? resolve(args.config) : DEFAULT_CONFIG_PATH;
  const existing = loadConfig(configPath);

  say();
  say(bold("PushCloud setup"));
  say("Approve your coding agent's tool calls from your phone.");
  say();

  let token = args.token ?? null;
  let key = args.key ?? null;
  let machine = args.machine ?? existing.machine ?? null;
  let e2ee = args["e2ee-key"] ?? existing.e2eeKey ?? null;

  if (!token || !key) {
    if (!process.stdin.isTTY) {
      throw new Error("no terminal to ask on. Pass --token and --key.");
    }
    say(`Both of these are in the panel at ${existing.api}:`);
    say(dim("  application token  Applications, then the one these should come from"));
    say(dim("  API key            Settings, with the `read` scope"));
    say();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      token = token ?? (await prompt(rl, "Application token (pca_...):", existing.token));
      key = key ?? (await prompt(rl, "API key (pck_...):", existing.key));
      machine = machine ?? (await rl.question(`Name for this machine ${dim("[optional]")} `)).trim();
      // Offered, not demanded. Encryption is worth having for a tool that sends
      // shell commands, but a user who has never generated a key should not be
      // stopped here; they can re-run setup once they have one.
      e2ee =
        e2ee ??
        (await rl.question(`Encryption key ${dim("[optional, 64 hex from Settings]")} `)).trim();
    } finally {
      rl.close();
    }
  }

  if (!token || !key) throw new Error("both an application token and an API key are needed.");

  const cfg = { ...existing, token, key, machine: machine || null, e2eeKey: e2ee || null };
  // Validated before anything is written, so a mistyped key is caught here
  // rather than as an unreadable notification on a phone.
  if (cfg.e2eeKey) parseKey(cfg.e2eeKey);
  process.stdout.write("Checking those credentials... ");
  await verify(cfg);
  say("good.");

  saveConfig(
    {
      api: cfg.api,
      token: cfg.token,
      key: cfg.key,
      machine: cfg.machine,
      e2ee_key: cfg.e2eeKey,
      wait_seconds: cfg.waitSeconds,
    },
    configPath
  );
  say(`Saved to ${configPath} ${dim("(readable only by you)")}`);
  if (cfg.e2eeKey) say(dim("Commands will be encrypted before they leave this machine."));

  // Hooks, into every agent this machine has that can actually approve.
  const detected = detectAgents();
  const only = args.agent ? String(args.agent).split(",") : null;
  const targets = detected.filter(
    (d) => d.agent.approves && (only ? only.includes(d.agent.id) : d.present)
  );

  // An explicit --claude-settings overrides where the Claude entry goes, which
  // is how the tests drive this without touching a real home directory.
  const pathFor = (d) =>
    d.agent.id === "claude" && args["claude-settings"] ? resolve(args["claude-settings"]) : d.config;

  if (targets.length === 0) say("\nNo supported agent found on this machine. Nothing to wire up.");
  for (const target of targets) {
    const path = pathFor(target);
    const written = target.agent.install(readSettings(path), {
      command: `node ${HOOK}`,
      matcher: args.matcher ?? target.agent.defaultMatcher,
      waitSeconds: cfg.waitSeconds,
    });
    writeSettings(path, written);
    say(`${target.agent.name}: hooks written to ${path}`);
  }

  // The skill is the other half of this, and the half that decides whether the
  // product is used well: the hook makes an agent *able* to reach you, and the
  // skill tells it when it should. Claude Code only for now - it is the one with
  // a skills directory.
  if (targets.some((t) => t.agent.id === "claude")) {
    const installed = installSkill(args["skills-dir"]);
    if (installed) say(`Skill written to ${installed}`);
  }

  for (const d of detected.filter((x) => x.present && !x.agent.approves)) {
    say();
    say(`Found ${d.agent.name}, and left it alone: ${d.agent.why}.`);
  }

  // The proof.
  if (args["no-test"]) {
    say();
    say("Skipping the test question.");
    return;
  }
  say();
  say("Sending a test question to your phone. Tap Approve on it.");
  const interactionId = await askQuestion(cfg, {
    title: cfg.machine ? `${cfg.machine} · setup` : "PushCloud setup",
    message: "This is PushCloud asking. Tap Approve to finish setting up.",
  });
  const answer = await waitForAnswer(cfg, interactionId, 120);

  say();
  if (answer?.action_id === "allow") {
    say(bold("Done. Your agent can reach you."));
  } else if (answer) {
    // Denying the test still proves the loop: the answer travelled from a phone
    // to this terminal, which is the only thing being tested.
    say(bold("That works too - the answer got back here."));
  } else {
    // Not a failure of the install. The hooks are written and the credentials
    // are good; the only thing unproven is whether a device is registered.
    say("No answer came back within two minutes.");
    say("The setup is written and valid. Check the PushCloud app is installed");
    say("and signed in on your phone, then run `pushcloud setup --test-only`.");
  }
}

/// Copies the skill into the agent's skills directory.
///
/// Copied rather than symlinked: a symlink into a global npm package breaks the
/// moment that package is updated or removed, and it would break silently - the
/// agent would simply stop knowing when to ask.
function installSkill(dir) {
  const target = dir
    ? resolve(dir, "pushcloud", "SKILL.md")
    : join(homedir(), ".claude", "skills", "pushcloud", "SKILL.md");
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(SKILL, target);
    return target;
  } catch {
    // Not worth failing a setup over. The hooks are the part that has to work.
    return null;
  }
}

async function runRemove(args) {
  // Every agent, not just the ones detected: a config directory that has since
  // been deleted can still hold our hooks, and an uninstall that leaves some
  // behind is worse than none at all.
  for (const d of detectAgents()) {
    if (!d.agent.approves) continue;
    const path =
      d.agent.id === "claude" && args["claude-settings"] ? resolve(args["claude-settings"]) : d.config;
    if (!existsSync(path)) continue;
    writeSettings(path, d.agent.uninstall(readSettings(path)));
    say(`Removed the PushCloud hooks from ${path}`);
  }
  const skill = args["skills-dir"]
    ? resolve(args["skills-dir"], "pushcloud", "SKILL.md")
    : join(homedir(), ".claude", "skills", "pushcloud", "SKILL.md");
  if (existsSync(skill)) {
    rmSync(dirname(skill), { recursive: true, force: true });
    say(`Removed the skill from ${dirname(skill)}`);
  }
  say(dim(`Credentials are left at ${DEFAULT_CONFIG_PATH}; delete that file to finish.`));
}

async function runTestOnly(args) {
  const cfg = loadConfig(args.config ? resolve(args.config) : DEFAULT_CONFIG_PATH);
  if (!cfg.token || !cfg.key) throw new Error("not set up yet. Run `pushcloud setup`.");
  say("Sending a test question. Tap anything on it.");
  const id = await askQuestion(cfg, {
    title: cfg.machine ?? "PushCloud",
    message: "Test question from pushcloud setup.",
  });
  const answer = await waitForAnswer(cfg, id, 120);
  say(answer ? bold("The answer got back here. You are set up.") : "No answer within two minutes.");
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "setup";

try {
  if (args.help || command === "help") {
    say("usage: pushcloud <setup|remove|test> [options]");
    say();
    say("  --token pca_...          application token, instead of being asked");
    say("  --key pck_...            API key with the read scope");
    say("  --machine NAME           what to call this machine on the push");
    say("  --matcher REGEX          which tools to ask about (Claude Code only)");
    say("  --agent ID               wire up just this one (claude, cursor, codex)");
    say("  --claude-settings PATH   settings file to write (default: ~/.claude/settings.json)");
    say("  --config PATH            where to keep credentials");
    say("  --skills-dir PATH        where to write the skill (default: ~/.claude/skills)");
    say("  --e2ee-key HEX           encrypt commands before they leave the machine");
    say("  --no-test                skip the test question at the end");
  } else if (command === "setup") {
    await runSetup(args);
  } else if (command === "remove" || command === "uninstall") {
    await runRemove(args);
  } else if (command === "test" || args["test-only"]) {
    await runTestOnly(args);
  } else {
    throw new Error(`unknown command \`${command}\`. Try \`pushcloud help\`.`);
  }
} catch (err) {
  process.stderr.write(`\npushcloud: ${err.message}\n`);
  process.exit(1);
}

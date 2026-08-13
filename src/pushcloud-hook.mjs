#!/usr/bin/env node
// The PushCloud hook for Claude Code.
//
// Two jobs, chosen by argv[2]:
//
//   ask     a PreToolUse hook. Pushes the tool call to your phone with Approve,
//           Deny and a reply box, blocks until you answer, and prints the
//           verdict back to Claude Code.
//   notify  a Stop / Notification hook. Pushes a line and exits; nothing waits.
//
// Both read the hook payload as JSON on stdin, which is how Claude Code passes
// the tool call, the session and the working directory.
//
// No dependencies, on purpose. This ends up in a stranger's ~/.claude and runs
// before every tool call they make; `npm install` in that position is a cost and
// a supply-chain surface, and everything here is in Node's standard library.

import { loadConfig } from "./config.mjs";
import { askQuestion, waitForAnswer, sendNote } from "./api.mjs";
import { agentById } from "./agents.mjs";

/// Which agent invoked us, and therefore which dialect to answer in. `setup`
/// writes the flag; the default keeps a hand-written Claude Code config working.
const agent = agentById(process.argv.includes("--agent") ? process.argv[process.argv.indexOf("--agent") + 1] : "claude") ?? agentById("claude");

/// How much of a command to put on a lock screen.
///
/// Short enough to read at a glance, and short enough that a key pasted into the
/// middle of a long command is unlikely to be the part that gets shown. The full
/// text is never sent: this is a truncation, not an ellipsis over a full payload.
const MAX_PREVIEW = 300;

/// The verdict Claude Code acts on.
///
/// `ask` means "fall through to the normal terminal prompt", which is the state
/// the user was in before installing this. Every failure path below returns it:
/// no credentials, no network, a 500, a timeout, a malformed payload. An `allow`
/// that nobody typed is a remote code execution with extra steps, so it is only
/// ever printed for a button an actual human actually tapped.
function decide(decision, reason) {
  process.stdout.write(JSON.stringify(agent.verdict(decision, reason)));
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/// One line describing the tool call, as it will read on a lock screen.
///
/// Bash is special-cased because the command *is* the decision: "Claude wants to
/// run Bash" tells you nothing you would answer differently. Everything else
/// leads with the path, for the same reason.
export function describe(toolName, input = {}) {
  const clip = (s) =>
    typeof s === "string" && s.length > MAX_PREVIEW ? `${s.slice(0, MAX_PREVIEW)}...` : String(s ?? "");
  if (toolName === "Bash" && input.command) return clip(input.command);
  if (input.file_path) return `${toolName} ${clip(input.file_path)}`;
  if (input.path) return `${toolName} ${clip(input.path)}`;
  if (input.url) return `${toolName} ${clip(input.url)}`;
  return toolName;
}

/// "PushCloud" alone on a lock screen does not say which of your three machines
/// is blocked. The hostname and the project directory do.
export function where(call, machine) {
  const project = call.cwd ? call.cwd.split("/").filter(Boolean).pop() : null;
  return [machine, project].filter(Boolean).join(" · ") || "Claude Code";
}

async function ask() {
  const payload = await readStdin();
  const cfg = loadConfig();

  // Refuse to be the reason a tool call is approved. Anything wrong here, and
  // the user simply gets the prompt they would have got anyway.
  if (!cfg.token || !cfg.key) {
    return decide("ask", "PushCloud: not set up on this machine, run `pushcloud setup`");
  }

  const call = agent.read(payload);

  try {
    const interactionId = await askQuestion(cfg, {
      title: where(call, cfg.machine),
      message: describe(call.toolName, call.input),
    });

    const answer = await waitForAnswer(cfg, interactionId, cfg.waitSeconds);

    // Timed out. The question is still live on the phone; this run just stops
    // waiting for it.
    if (!answer) {
      return decide("ask", `PushCloud: no answer within ${cfg.waitSeconds}s, asking here instead`);
    }
    if (answer.action_id === "allow") return decide("allow", "Approved from PushCloud");
    if (answer.action_id === "deny") return decide("deny", "Denied from PushCloud");
    // A typed reply is a denial with an instruction attached: the human said
    // something other than yes, and Claude gets to read what.
    if (answer.text) return decide("deny", `Denied from PushCloud: ${answer.text}`);
    return decide("ask", "PushCloud: the answer could not be read");
  } catch (err) {
    return decide("ask", `PushCloud: ${err.message}`);
  }
}

/// Fire-and-forget: a run finished, or Claude wants attention. Nothing blocks on
/// this and nothing is decided by it, so a failure is silent by design. A hook
/// that printed an error here would put noise in the transcript for a push that
/// simply did not matter enough to interrupt anyone.
async function notify() {
  const payload = await readStdin();
  const cfg = loadConfig();
  if (!cfg.token) return;
  try {
    await sendNote(cfg, {
      title: where(agent.read(payload), cfg.machine),
      message: payload.message ?? "Your run has finished.",
    });
  } catch {
    // Deliberately ignored. See above.
  }
}

const mode = process.argv[2];
if (mode === "ask") await ask();
else if (mode === "notify") await notify();
else {
  process.stderr.write("usage: pushcloud-hook.mjs <ask|notify>\n");
  process.exit(2);
}

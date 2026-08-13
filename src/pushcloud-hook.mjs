#!/usr/bin/env node
// The PushCloud hook for Claude Code.
//
// Two jobs, chosen by argv[2]:
//
//   ask     a PreToolUse hook. Pushes the tool call to your phone with Approve
//           and Deny buttons, blocks until you tap one, and prints the verdict
//           back to Claude Code.
//   notify  a Stop / Notification hook. Pushes a line and exits; nothing waits.
//
// Both read the hook payload as JSON on stdin, which is how Claude Code passes
// the tool call, the session and the working directory.
//
// No dependencies, on purpose. This ends up in a stranger's ~/.claude and runs
// before every tool call they make; `npm install` in that position is a cost and
// a supply-chain surface, and everything here is in Node's standard library.

const API = process.env.PUSHCLOUD_API ?? "https://pushcloud.app";

/// Two credentials, because they authorise two different things.
///
/// Sending is the application's identity: a `pca_` token says which source the
/// notification is from, and is all a sender ever needs. Waiting reads your
/// account, which an application token deliberately cannot do - so the wait
/// needs a `pck_` key with the `read` scope. Asking for one credential that did
/// both would mean handing every hook the right to read the account.
const TOKEN = process.env.PUSHCLOUD_TOKEN;
const KEY = process.env.PUSHCLOUD_KEY;

/// Seconds to hold the phone question open before giving up and asking locally.
/// The server's ceiling is 300; going near it means a hook that appears hung to
/// anyone sitting at the keyboard, so the default is a couple of minutes.
const WAIT_SECONDS = Number(process.env.PUSHCLOUD_WAIT_SECONDS ?? 120);

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
/// no key, no network, a 500, a timeout, a malformed payload. An `allow` that
/// nobody typed is a remote code execution with extra steps, so it is only ever
/// printed for a button an actual human actually tapped.
function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
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

async function api(path, credential, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}`);
  return res.json();
}

/// One line describing the tool call, as it will read on a lock screen.
///
/// Bash is special-cased because the command *is* the decision: "Claude wants to
/// run Bash" tells you nothing you would answer differently. Everything else
/// leads with the path, for the same reason.
function describe(toolName, input = {}) {
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
function where(payload) {
  const project = payload.cwd ? payload.cwd.split("/").filter(Boolean).pop() : null;
  const host = process.env.PUSHCLOUD_MACHINE ?? null;
  return [host, project].filter(Boolean).join(" · ") || "Claude Code";
}

async function ask() {
  const payload = await readStdin();
  const toolName = payload.tool_name ?? "a tool";

  // Refuse to be the reason a tool call is approved. Anything wrong here, and
  // the user simply gets the prompt they would have got anyway.
  if (!TOKEN || !KEY) {
    return decide("ask", "PushCloud: set PUSHCLOUD_TOKEN (pca_) and PUSHCLOUD_KEY (pck_)");
  }

  try {
    const sent = await api("/v1/messages", TOKEN, {
      method: "POST",
      body: JSON.stringify({
        title: where(payload),
        message: describe(toolName, payload.tool_input),
        // Time-sensitive: someone is sitting in a blocked terminal waiting for
        // this, so it should break through a focus mode.
        priority: 1,
        // The question outlives this hook deliberately. If the wait times out
        // and the user answers on their phone a minute later, the answer is
        // still recorded rather than landing on a dead interaction.
        expires_in: 3600,
        // Three, not two. The reply box is what makes "no, rebase instead" a
        // possible answer: a bare deny leaves Claude to guess what you objected
        // to, and it will often guess a variation of the same thing. A question
        // with no reply action rejects a typed answer outright, so leaving it
        // out would make the reply branch below unreachable.
        actions: [
          { id: "allow", label: "Approve", type: "button" },
          { id: "deny", label: "Deny", type: "button" },
          { id: "reason", label: "Deny with a reason", type: "reply" },
        ],
      }),
    });

    if (!sent.interaction_id) return decide("ask", "PushCloud: the message carried no question");

    const { interaction } = await api(
      `/v1/interactions/${sent.interaction_id}/wait?timeout=${WAIT_SECONDS}`,
      KEY
    );

    // Timed out. The question is still live on the phone; this run just stops
    // waiting for it.
    if (interaction.status !== "responded") {
      return decide("ask", `PushCloud: no answer within ${WAIT_SECONDS}s, asking here instead`);
    }

    const response = JSON.parse(interaction.response ?? "{}");
    if (response.action_id === "allow") return decide("allow", "Approved from PushCloud");
    if (response.action_id === "deny") return decide("deny", "Denied from PushCloud");
    // A typed reply is a denial with an instruction attached: the human said
    // something other than yes, and Claude gets to read what.
    if (response.text) return decide("deny", `Denied from PushCloud: ${response.text}`);
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
  if (!TOKEN) return;
  try {
    await api("/v1/messages", TOKEN, {
      method: "POST",
      body: JSON.stringify({
        title: where(payload),
        message: payload.message ?? "Your run has finished.",
        priority: 0,
      }),
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

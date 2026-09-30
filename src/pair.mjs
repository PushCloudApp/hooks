// `pushcloud pair <code>` - connect this machine's agent with a code from the phone.
//
// The code is the only thing the user types. The phone shows who is claiming it
// and the owner taps Connect; only then does the server hand this machine an
// app token and an MCP key. So the order below is strict:
//
//   claim -> wait for the tap -> write anything at all.
//
// Nothing touches the disk before `connected`. A denied, expired or burned code
// leaves the machine exactly as it was.
//
// And the claim is posted once, ever. A second claim on a claimed code burns it
// (that is how the server spots two machines racing for one code), so an
// ordinary "retry on a dropped connection" would cancel the user's own code.
// The wait loop is different: it is authenticated by the claim secret, it is
// idempotent until the one `connected` answer, and retrying it is exactly right.

import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { loadConfig, saveConfig, DEFAULT_CONFIG_PATH } from "./config.mjs";
import { askQuestion, waitForAnswer } from "./api.mjs";
import { installBin } from "./install.mjs";
import { installSkill } from "./settings.mjs";
import { configureAgent } from "./mcp-config.mjs";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/// What the claim says it came from; the phone shows it beside the machine.
export const CLIENT = `pushcloud-cli/${PKG.version}`;

/// The server's agent slugs mapped to this package's own agent ids (amendment 7).
/// `other` has no hooks here: it gets the URL and the header, and nothing written.
export const AGENT_ID = { "claude-code": "claude", codex: "codex", cursor: "cursor", other: null };

/// How the server's slugs read in a sentence.
const AGENT_NAME = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", other: "agent" };

/// Every way a pairing ends short of `connected`, with the line the user sees.
export const MESSAGES = {
  invalid: "That code isn't valid or has expired. Get a new one on your phone.",
  used: "That code was used by two machines, so it was cancelled. Get a new one on your phone.",
  denied: "Cancelled on your phone. Nothing was changed on this machine.",
  expired: "The code expired before it was confirmed. Get a new one on your phone.",
  network: "Couldn't reach PushCloud. Get a new code on your phone and try again.",
  collected: "This pairing was already collected. Get a new code on your phone.",
  cancelled: "Stopped. Nothing was changed on this machine.",
};

export class PairError extends Error {
  /// `kind` is one of the MESSAGES keys, or "rate_limited", whose line is the
  /// server's own (it names the wait).
  constructor(kind, message) {
    super(message ?? MESSAGES[kind] ?? kind);
    this.kind = kind;
  }
}

/// A POST that reports the status instead of throwing on it. Throws only when
/// no response came back at all.
async function post(url, { body, auth, signal }) {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": CLIENT,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const errorOf = (json) => json?.error ?? {};

/// POST /v1/pairings/claim, exactly once. Never retried, whatever goes wrong:
/// see the top of this file.
export async function claim(api, { code, machine }) {
  let r;
  try {
    r = await post(`${api}/v1/pairings/claim`, { body: { code, machine, client: CLIENT } });
  } catch {
    throw new PairError("network");
  }
  if (r.status === 202 || r.status === 200) {
    if (!r.json?.claim_secret) throw new PairError("network");
    return r.json;
  }
  if (r.status === 409) throw new PairError("used");
  if (r.status === 429) {
    throw new PairError("rate_limited", errorOf(r.json).message ?? "Too many pairing attempts. Try again in a few minutes.");
  }
  // A 5xx says nothing about the code; the claim may or may not have landed, and
  // a second one could burn it. Same line as a dropped connection: get a new code.
  if (r.status >= 500) throw new PairError("network");
  throw new PairError("invalid");
}

const sleep = (ms, signal) =>
  new Promise((done, fail) => {
    if (signal?.aborted) return fail(new PairError("cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      done();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      fail(new PairError("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/// Loops on POST /v1/pairings/claim/wait?wait=25 until the phone answers.
///
/// Resolves the `connected` payload. A dropped connection or a 5xx inside the
/// loop is retried after `interval` seconds: the claim itself is never re-posted.
/// `giveUpAfter` bounds a network that never comes back; the code has expired
/// on the server long before the default.
export async function waitConnected(api, secret, { interval = 2, onTick, signal, giveUpAfter = 11 * 60_000 } = {}) {
  const pause = Math.max(0, Number(interval) || 0) * 1000;
  const deadline = Date.now() + giveUpAfter;
  for (;;) {
    if (signal?.aborted) throw new PairError("cancelled");
    let r = null;
    try {
      r = await post(`${api}/v1/pairings/claim/wait?wait=25`, { auth: secret, signal });
    } catch {
      if (signal?.aborted) throw new PairError("cancelled");
      r = null;
    }
    if (r?.status === 200 && r.json?.status === "connected") return r.json;
    if (r && r.status < 500 && !(r.status === 200 && r.json?.status === "awaiting_confirmation")) {
      const code = errorOf(r.json).code;
      if (r.status === 403) throw new PairError("denied");
      if (r.status === 409) throw new PairError("used");
      if (r.status === 410) throw new PairError(code === "PAIRING_COLLECTED" ? "collected" : "expired");
      // 401 (the secret is unknown) or anything else: the claim is gone.
      throw new PairError("expired");
    }
    if (Date.now() > deadline) throw new PairError(r ? "expired" : "network");
    onTick?.(r?.json?.status ?? "retrying");
    await sleep(pause, signal);
  }
}

/// The whole flow, spec §4.1 steps 1-8. Returns the process exit code.
export async function runPair(args, { home = homedir(), say = () => {}, signal } = {}) {
  const code = args._.slice(1).join("").replace(/[\s-]/g, "");
  if (!code) {
    say("usage: pushcloud pair <code>   (the code is on your phone, under Connect an agent)");
    return 1;
  }
  const configPath = args.config ? resolve(args.config) : DEFAULT_CONFIG_PATH;
  const existing = loadConfig(configPath);
  const api = existing.api;
  const machine = typeof args.machine === "string" && args.machine ? args.machine : hostname();

  let payload;
  try {
    const claimed = await claim(api, { code, machine });
    // The claim answer does not say which agent the code was made for; say so
    // generically rather than guess wrong.
    const agentName = AGENT_NAME[claimed.agent] ?? "an agent";
    say(`Confirm on your phone: Connect ${agentName} on ${machine}?`);
    payload = await waitConnected(api, claimed.claim_secret, { interval: claimed.interval ?? 2, signal });
  } catch (err) {
    if (!(err instanceof PairError)) throw err;
    say(err.message);
    return err.kind === "cancelled" ? 130 : 1;
  }

  // Connected. From here on, and only from here on, the disk is touched.
  // An agent this version does not know yet gets the Other treatment: the URL
  // and header printed, nothing written.
  const slug = payload.agent == null ? "claude-code" : Object.hasOwn(AGENT_ID, payload.agent) ? payload.agent : "other";
  const token = payload.application?.token;
  if (!token) throw new Error("the server connected but sent no application token.");

  installBin(home);
  saveConfig(
    {
      api,
      token,
      machine,
      e2ee_key: existing.e2eeKey,
      wait_seconds: existing.waitSeconds,
    },
    configPath
  );
  say(`Saved to ${configPath}`);

  say();
  await configureAgent(slug, payload, {
    home,
    claudeSettings: args["claude-settings"],
    matcher: args.matcher,
    waitSeconds: existing.waitSeconds,
    say,
  });

  if (slug === "claude-code") {
    const installed = installSkill(args["skills-dir"], home);
    if (installed) say(`Skill written to ${installed}`);
  }

  if (!args["no-test"]) {
    const cfg = { api, token, key: null, machine, e2eeKey: existing.e2eeKey };
    say();
    say("Sending a test question to your phone. Tap Approve on it.");
    const id = await askQuestion(cfg, {
      title: `${machine} · setup`,
      message: "This is PushCloud asking. Tap Approve to finish setting up.",
    });
    const answer = await waitForAnswer(cfg, id, 120);
    if (!answer) {
      say("No answer came back within two minutes. The setup is written; check the PushCloud app is signed in on your phone.");
    }
  }

  say();
  say(`Done. Start a new ${AGENT_NAME[slug] ?? "agent"} session (or run /mcp) to load the PushCloud tools.`);
  return 0;
}

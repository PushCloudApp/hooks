// Claude Code's own session lifecycle, reported to PushCloud sessions.
//
// Five hooks. SessionStart opens a session; UserPromptSubmit marks it working;
// Notification and Stop mark it waiting (Claude wants attention, or a turn has
// ended and the prompt is yours); SessionEnd marks it done. So the phone's
// Agents tab shows what each terminal is doing, and one terminal is one session.
//
// Stop fires at the end of every turn, not once per session, which is why it is
// `waiting` and only SessionEnd is `done`: the server replays an external_id only
// while its session is open, so a done-per-turn would start a new session (and
// spend a session start) every turn. Stop's waiting ring is also the turn-end
// push, so `install` no longer puts a separate `notify` beside it; if the session
// can't be reported, Stop sends that one plain push itself.
//
// Unlike the PreToolUse hook, nothing here decides anything. So every failure is
// swallowed: a session hook that threw, printed or hung would get in the way of
// the agent it is only meant to be reporting on. The caller also puts a hard
// deadline on the whole run.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

/// How many Claude Code sessions to remember. Each is ~40 bytes, and a session
/// older than a couple of hundred others is long finished.
export const MAX_CACHED = 200;

/// How long any one request may take. The hook's own deadline is the same, so
/// this is what makes a hung server a clean exit rather than a killed process.
export const REQUEST_TIMEOUT_MS = 3000;

const MAX_TITLE = 200;

/// Cached in place of a session id once the person has dismissed that session
/// on the phone (a 409 whose session reads `failed_reason: "dismissed"`): the rest of that Claude Code session stays quiet rather
/// than opening a fresh one on the next turn. A SessionStart (a resume) clears it.
const DISMISSED = "-";

export function sessionsPath(home = homedir()) {
  return join(home, ".pushcloud", "sessions.json");
}

/// `{ [external_id]: ses_id }`, oldest first. Anything unreadable is empty: the
/// worst a lost cache costs is one replayed POST.
export function readCache(path = sessionsPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/// Writes the cache owner-only, keeping the newest MAX_CACHED entries. Written
/// to a temp file and renamed, so two hooks racing never leave half a file.
export function writeCache(map, path = sessionsPath()) {
  const keys = Object.keys(map);
  const kept = {};
  for (const k of keys.slice(Math.max(0, keys.length - MAX_CACHED))) kept[k] = map[k];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function remember(path, externalId, sesId) {
  const map = readCache(path);
  // Re-inserting moves it to the end, which is what "newest" means here.
  delete map[externalId];
  map[externalId] = sesId;
  writeCache(map, path);
}

function forget(path, externalId) {
  const map = readCache(path);
  if (!(externalId in map)) return;
  delete map[externalId];
  writeCache(map, path);
}

const projectOf = (hookInput) => (hookInput?.cwd ? basename(hookInput.cwd) || null : null);
const externalIdOf = (hookInput) => `cc-${hookInput?.session_id ?? ""}`;

/// SessionStart's input carries no prompt, so in practice this is "Claude Code
/// in <project>". A prompt is used if one is ever there.
export function titleFor(hookInput) {
  const prompt = typeof hookInput?.prompt === "string" ? hookInput.prompt.trim() : "";
  if (prompt) return [...prompt].slice(0, MAX_TITLE).join("");
  const project = projectOf(hookInput);
  return project ? `Claude Code in ${project}` : "Claude Code";
}

async function call(cfg, method, path, body) {
  const res = await fetch(`${cfg.api}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.status = res.status;
    err.code = json?.error?.code ?? null;
    throw err;
  }
  return json;
}

const usable = (cfg, hookInput) => Boolean(cfg?.token && cfg?.api && hookInput?.session_id);
const cacheFile = (cfg) => cfg.sessionsPath ?? sessionsPath();

/// POST /v1/sessions. With an `external_id` the server returns the open session
/// again rather than starting a second one, so this doubles as the lookup on a
/// cache miss.
export async function onSessionStart(cfg, hookInput) {
  if (!usable(cfg, hookInput)) return null;
  const externalId = externalIdOf(hookInput);
  const project = projectOf(hookInput);
  const { session } = await call(cfg, "POST", "/v1/sessions", {
    title: titleFor(hookInput),
    agent: "claude-code",
    ...(project ? { project } : {}),
    external_id: externalId,
  });
  if (!session?.id) return null;
  remember(cacheFile(cfg), externalId, session.id);
  return session.id;
}

/// Whether an ended session was dismissed by the person on the phone. The
/// worker answers a dismissed session and one its 24 h stale sweep closed with
/// the same 409 SESSION_ENDED, so only `failed_reason` tells them apart. When
/// that can't be read, it counts as not dismissed: a stray new session is a
/// smaller harm than a terminal that goes silent for the rest of its life.
async function wasDismissed(cfg, id) {
  try {
    const json = await call(cfg, "GET", `/v1/sessions/${encodeURIComponent(id)}`);
    return json?.session?.failed_reason === "dismissed";
  } catch {
    return false;
  }
}

/// PATCHes the session's status, opening (or replaying) it first on a cache miss
/// unless `openIfMissing` is false. Returns true once the status is reported,
/// false when there was nothing to report to (dismissed, or no session). Throws
/// on anything else, so the caller can fall back.
async function setStatus(cfg, hookInput, status, { openIfMissing = true } = {}) {
  if (!usable(cfg, hookInput)) return false;
  const externalId = externalIdOf(hookInput);
  const path = cacheFile(cfg);
  const cached = readCache(path)[externalId];
  if (cached === DISMISSED) return false;
  let id = cached ?? (openIfMissing ? await onSessionStart(cfg, hookInput) : null);
  if (!id) return false;
  // At most one retry: a cached session that ended some other way than a dismiss
  // (the stale sweep, or done) is forgotten and a fresh one opened in its place.
  for (let attempt = 0; ; attempt++) {
    try {
      await call(cfg, "PATCH", `/v1/sessions/${encodeURIComponent(id)}`, { status });
      break;
    } catch (err) {
      if (err.status !== 409) throw err;
      if (status === "done") {
        forget(path, externalId);
        return false;
      }
      // Dismissed on the phone: remember that, so the next turn doesn't open a
      // new session the person never asked for.
      if (await wasDismissed(cfg, id)) {
        remember(path, externalId, DISMISSED);
        return false;
      }
      forget(path, externalId);
      if (attempt > 0 || !openIfMissing) return false;
      id = await onSessionStart(cfg, hookInput);
      if (!id) return false;
    }
  }
  if (status === "done") forget(path, externalId);
  return true;
}

export const onUserPromptSubmit = (cfg, hookInput) => setStatus(cfg, hookInput, "working");
export const onNotification = (cfg, hookInput) => setStatus(cfg, hookInput, "waiting");

/// The end of a turn. Its waiting ring is the turn's one push; when the session
/// can't be reported at all (no sessions on the plan, the server erroring), one
/// plain message goes instead, so a turn's end is never silent. `sendNote` is
/// passed in to keep this module free of the message API.
export async function onStop(cfg, hookInput, { sendNote } = {}) {
  try {
    await setStatus(cfg, hookInput, "waiting");
  } catch (err) {
    if (!sendNote || !cfg?.token || !cfg?.api) throw err;
    const project = projectOf(hookInput);
    await sendNote(cfg, {
      title: project ? `Claude Code in ${project}` : "Claude Code",
      message: "Your turn: Claude has finished.",
    });
  }
}

/// The terminal closed (or /clear, or logout). Never opens a session just to end
/// it: with nothing cached there is nothing on the phone to close.
export const onSessionEnd = (cfg, hookInput) => setStatus(cfg, hookInput, "done", { openIfMissing: false });

export const SESSION_EVENTS = {
  "session-start": onSessionStart,
  "user-prompt-submit": onUserPromptSubmit,
  notification: onNotification,
  stop: onStop,
  "session-end": onSessionEnd,
};

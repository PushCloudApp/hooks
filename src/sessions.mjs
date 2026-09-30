// Claude Code's own session lifecycle, reported to PushCloud sessions.
//
// Three hooks, one each for SessionStart, Notification and Stop. They open a
// session, mark it waiting when Claude wants attention, and mark it done when a
// run stops, so the phone's Agents tab shows what each terminal is doing.
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

async function setStatus(cfg, hookInput, status) {
  if (!usable(cfg, hookInput)) return;
  const externalId = externalIdOf(hookInput);
  const path = cacheFile(cfg);
  const id = readCache(path)[externalId] ?? (await onSessionStart(cfg, hookInput));
  if (!id) return;
  try {
    await call(cfg, "PATCH", `/v1/sessions/${encodeURIComponent(id)}`, { status });
  } catch (err) {
    // The session already ended (dismissed on the phone, or gone stale). Nothing
    // to report to; forget it so the next event starts clean.
    if (err.status === 409) return forget(path, externalId);
    throw err;
  }
  if (status === "done") forget(path, externalId);
}

export const onNotification = (cfg, hookInput) => setStatus(cfg, hookInput, "waiting");
export const onStop = (cfg, hookInput) => setStatus(cfg, hookInput, "done");

export const SESSION_EVENTS = {
  "session-start": onSessionStart,
  notification: onNotification,
  stop: onStop,
};

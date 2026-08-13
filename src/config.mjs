import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/// Where credentials live.
///
/// Not in `~/.claude/settings.json`, which is the obvious place and the wrong
/// one: project settings files get committed, and a token in a repo is a token
/// on GitHub. Not in the shell profile either, because `export` only reaches a
/// hook if the user's terminal happens to have sourced it, and "it worked
/// yesterday" is a miserable bug to own.
export const DEFAULT_CONFIG_PATH =
  process.env.PUSHCLOUD_CONFIG ?? join(homedir(), ".pushcloud", "config.json");

/// Credentials, from the environment first and the config file second.
///
/// The environment wins so that CI, a one-off run, or a second account can
/// override without editing anything. A missing or unreadable file is simply an
/// empty config: this is read before every tool call, and a hook that threw
/// because a JSON file had a stray comma would block the terminal it is meant to
/// be helping.
export function loadConfig(path = DEFAULT_CONFIG_PATH) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    file = {};
  }
  return {
    api: process.env.PUSHCLOUD_API ?? file.api ?? "https://pushcloud.app",
    token: process.env.PUSHCLOUD_TOKEN || file.token || null,
    key: process.env.PUSHCLOUD_KEY || file.key || null,
    machine: process.env.PUSHCLOUD_MACHINE || file.machine || null,
    waitSeconds: Number(process.env.PUSHCLOUD_WAIT_SECONDS ?? file.wait_seconds ?? 120),
  };
}

/// Writes credentials readable only by this user.
///
/// The mode is set on the open, not with a chmod afterwards: creating the file
/// world-readable and narrowing it a moment later leaves a window where an API
/// key sits in a readable file, which is the sort of window that only ever gets
/// noticed by the person who exploits it.
export function saveConfig(config, path = DEFAULT_CONFIG_PATH) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return path;
}

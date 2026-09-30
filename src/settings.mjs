// Reading and writing an agent's settings file, and copying the skill.
//
// Shared by `setup` and `pair`. It lives in its own module because setup.mjs is
// the CLI entry point and runs on import, so nothing can import from it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = fileURLToPath(new URL("../skills/pushcloud/SKILL.md", import.meta.url));

/// Reads a settings file that may not exist, may be empty, or may be broken.
///
/// A parse failure stops the whole setup rather than being treated as an empty
/// object: writing our hooks over a file we could not read would silently
/// discard whatever the user had in there.
export function readSettings(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Fix or move it, then run setup again.`);
  }
}

export function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  // A backup before the first write, and only the first: the point is to keep
  // the file as it was before this tool ever touched it, not to overwrite that
  // record with our own output on the second run.
  if (existsSync(path) && !existsSync(`${path}.pushcloud-backup`)) {
    copyFileSync(path, `${path}.pushcloud-backup`);
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

/// Where the skill goes: `<dir>/pushcloud/SKILL.md`, or under ~/.claude/skills.
export function skillPath(dir, home = homedir()) {
  return dir ? resolve(dir, "pushcloud", "SKILL.md") : join(home, ".claude", "skills", "pushcloud", "SKILL.md");
}

/// Copies the skill into the agent's skills directory.
///
/// Copied rather than symlinked: a symlink into a global npm package breaks the
/// moment that package is updated or removed, and it would break silently - the
/// agent would simply stop knowing when to ask.
export function installSkill(dir, home = homedir()) {
  const target = skillPath(dir, home);
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(SKILL, target);
    return target;
  } catch {
    // Not worth failing a setup over. The hooks are the part that has to work.
    return null;
  }
}

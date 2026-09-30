// Where the hook lives once it is installed, and how to find a binary.
//
// The hook command written into an agent's settings used to point into this
// package wherever it happened to be. Run through `npx`, that is a directory in
// the npx cache, which npm prunes whenever it likes - and a pruned cache turns
// every tool call into "Cannot find module". So the hook and the modules it
// imports are copied to a path we own, ~/.pushcloud/bin, and the settings point
// there instead. Setup copies them again on every run, which is also how an
// upgrade reaches an existing install.

import { copyFileSync, mkdirSync, chmodSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

/// The hook, and everything it imports, transitively. A module missing here is
/// a hook that fails on its first import, so the test compares this list with
/// the real files.
export const BIN_FILES = ["pushcloud-hook.mjs", "api.mjs", "config.mjs", "seal.mjs", "agents.mjs"];

const SRC = fileURLToPath(new URL("./", import.meta.url));

export function binDir(home = homedir()) {
  return join(home, ".pushcloud", "bin");
}

/// Copies BIN_FILES into binDir, overwriting whatever an earlier version left.
/// Returns the hook's path.
export function installBin(home = homedir()) {
  const dir = binDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  // mkdir's mode is masked by the umask and ignored for a directory that
  // already exists, so set it outright.
  chmodSync(dir, 0o755);
  for (const f of BIN_FILES) copyFileSync(join(SRC, f), join(dir, f));
  return join(dir, "pushcloud-hook.mjs");
}

/// The command an agent's settings run. Quoted: a home directory with a space
/// in it is common enough on a Mac.
export function hookCommand(home = homedir()) {
  return `node "${join(binDir(home), "pushcloud-hook.mjs")}"`;
}

/// Whether an executable called `bin` is on env.PATH.
export function onPath(bin, env = process.env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      // Not here; keep looking.
    }
  }
  return false;
}

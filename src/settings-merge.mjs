/// How a PushCloud hook entry is recognised in someone else's settings file.
///
/// Matching on the command string rather than storing a marker key, because the
/// file belongs to the user: they may have hand-edited it, moved the checkout,
/// or copied the block between machines, and none of that should stop `setup`
/// from recognising its own work and replacing it.
const MARKER = "pushcloud-hook";

const isOurs = (entry) =>
  (entry?.hooks ?? []).some((h) => typeof h?.command === "string" && h.command.includes(MARKER));

/// Adds (or updates) the PushCloud hooks in a Claude Code settings object.
///
/// Three properties this has to have, in order of how much damage getting them
/// wrong would do:
///
/// 1. **It never touches a hook that is not ours.** This file is where people
///    keep their formatters, their linters and their audit logging. Rewriting
///    it is a privilege, and the only entries this may remove are ones it can
///    prove it wrote.
/// 2. **It is idempotent.** Running `setup` twice is the most likely thing a
///    user will ever do with it, usually because the first run did not appear
///    to work. Two copies of the hook means two pushes per tool call.
/// 3. **It does not reorder or drop unknown keys.** Settings files carry all
///    sorts of things this tool has never heard of and must preserve blind.
export function mergeHooks(settings, { command, matcher = "Bash", timeout = 130 }) {
  const next = structuredClone(settings ?? {});
  next.hooks = { ...(next.hooks ?? {}) };

  const put = (event, entry) => {
    // Drop our previous entries for this event, keep everyone else's, append
    // the fresh one. Filtering first is what makes a re-run a replacement
    // rather than a duplicate.
    const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    next.hooks[event] = [...existing.filter((e) => !isOurs(e)), entry];
  };

  put("PreToolUse", {
    matcher,
    hooks: [{ type: "command", command: `${command} ask`, timeout }],
  });
  put("Stop", {
    hooks: [{ type: "command", command: `${command} notify` }],
  });

  return next;
}

/// Removes every PushCloud hook and leaves the rest of the file alone.
///
/// An uninstall that a user cannot find is a tool they will not install. An
/// event whose entries were all ours is deleted rather than left as an empty
/// array, so an uninstall leaves no trace of us at all.
export function removeHooks(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks) return next;
  next.hooks = { ...next.hooks };
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => !isOurs(e));
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export const __testing = { isOurs, MARKER };

// What each coding agent wants, and what it will accept back.
//
// Every agent here does the same two things in a different dialect: hand a hook
// a tool call on stdin, and read a verdict off stdout. The dialects are not
// close enough to paper over - the config file, its shape, the event name and
// the verdict schema all differ - so each one is written out in full rather
// than generated from a table of exceptions.
//
// Contracts verified against each project's own source, not its blog posts:
//   Claude Code  hookSpecificOutput.permissionDecision: allow | deny | ask
//   Cursor       {permission: allow|deny|ask, agent_message, user_message}
//   Codex        hookSpecificOutput.decision.behavior: allow | deny
//   Gemini CLI   deny only - see GEMINI below

import { join } from "node:path";

const MARKER = "pushcloud-hook";

const hasOurCommand = (o) => typeof o?.command === "string" && o.command.includes(MARKER);

/// Claude Code and Codex share a config shape: an event holds a list of
/// matcher-groups, each holding a list of `{type, command}`.
const isOursNested = (entry) => (entry?.hooks ?? []).some(hasOurCommand);

function putNested(hooks, event, entry) {
  const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
  // Filtering ours out first is what makes a second run a replacement rather
  // than a second push per tool call.
  return { ...hooks, [event]: [...existing.filter((e) => !isOursNested(e)), entry] };
}

function stripNested(hooks) {
  const next = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      next[event] = entries;
      continue;
    }
    const kept = entries.filter((e) => !isOursNested(e));
    if (kept.length) next[event] = kept;
  }
  return next;
}

const CLAUDE = {
  id: "claude",
  name: "Claude Code",
  approves: true,
  config: (home) => join(home, ".claude", "settings.json"),
  /// PreToolUse fires for every tool, so it needs a matcher. The others do not:
  /// Cursor's event is shell-only, and Codex's fires only when it was going to
  /// ask anyway, which is exactly the set worth forwarding.
  defaultMatcher: "Bash",

  read: (p) => ({ toolName: p.tool_name ?? "a tool", input: p.tool_input ?? {}, cwd: p.cwd }),

  verdict(decision, reason) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    };
  },

  install(settings, { command, matcher, waitSeconds }) {
    const next = structuredClone(settings ?? {});
    let hooks = { ...(next.hooks ?? {}) };
    hooks = putNested(hooks, "PreToolUse", {
      matcher: matcher ?? CLAUDE.defaultMatcher,
      hooks: [
        {
          type: "command",
          command: `${command} ask --agent claude`,
          // Must outlast the hook's own wait, or Claude Code kills it while the
          // user is looking at the question on their phone.
          timeout: waitSeconds + 10,
        },
      ],
    });
    hooks = putNested(hooks, "Stop", {
      hooks: [{ type: "command", command: `${command} notify --agent claude` }],
    });
    next.hooks = hooks;
    return next;
  },

  uninstall(settings) {
    const next = structuredClone(settings ?? {});
    if (!next.hooks) return next;
    next.hooks = stripNested(next.hooks);
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
    return next;
  },
};

const CURSOR = {
  id: "cursor",
  name: "Cursor",
  approves: true,
  config: (home) => join(home, ".cursor", "hooks.json"),
  defaultMatcher: null,

  read: (p) => ({
    toolName: "Bash",
    input: { command: p.command },
    // Cursor sends the workspace roots as well as the cwd; the root is the
    // better name for a project, since cwd may be a subdirectory of it.
    cwd: p.workspace_roots?.[0] ?? p.cwd,
  }),

  verdict(decision, reason) {
    // Cursor's vocabulary happens to match Claude's exactly, which is why this
    // is a pass-through rather than a mapping.
    return { permission: decision, agent_message: reason, user_message: reason };
  },

  install(settings, { command }) {
    const next = structuredClone(settings ?? {});
    // Cursor requires this and rejects the file without it.
    next.version = next.version ?? 1;
    const hooks = { ...(next.hooks ?? {}) };
    const existing = Array.isArray(hooks.beforeShellExecution) ? hooks.beforeShellExecution : [];
    hooks.beforeShellExecution = [
      ...existing.filter((e) => !hasOurCommand(e)),
      { command: `${command} ask --agent cursor` },
    ];
    next.hooks = hooks;
    return next;
  },

  uninstall(settings) {
    const next = structuredClone(settings ?? {});
    if (!next.hooks) return next;
    const hooks = {};
    for (const [event, entries] of Object.entries(next.hooks)) {
      if (!Array.isArray(entries)) {
        hooks[event] = entries;
        continue;
      }
      const kept = entries.filter((e) => !hasOurCommand(e));
      if (kept.length) hooks[event] = kept;
    }
    next.hooks = hooks;
    if (Object.keys(hooks).length === 0) {
      delete next.hooks;
      // `version` is ours too, when it is all that is left: install adds it
      // because Cursor rejects the file without it, so a hooks.json holding
      // nothing but a version number is a file we created and should take away.
      if (next.version === 1) delete next.version;
    }
    return next;
  },
};

const CODEX = {
  id: "codex",
  name: "Codex",
  approves: true,
  config: (home) => join(home, ".codex", "hooks.json"),
  defaultMatcher: null,

  read: (p) => ({ toolName: p.tool_name ?? "a tool", input: p.tool_input ?? {}, cwd: p.cwd }),

  /// Codex's `PermissionRequest` is the event that can approve. Its `PreToolUse`
  /// cannot: the parser rejects `permissionDecision: allow` unless it comes with
  /// an `updatedInput`, and rejects `ask` outright
  /// (codex-rs/hooks/src/engine/output_parser.rs). Hooking PreToolUse would have
  /// produced a hook that could only ever say no.
  ///
  /// There is no "ask" here either, but there does not need to be: omitting the
  /// decision entirely lets Codex put its own prompt up, which is the same
  /// fall-through the other agents get from `ask`.
  verdict(decision, reason) {
    if (decision === "ask") return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: decision === "allow" ? "allow" : "deny", message: reason },
      },
    };
  },

  install(settings, { command }) {
    const next = structuredClone(settings ?? {});
    next.hooks = putNested({ ...(next.hooks ?? {}) }, "PermissionRequest", {
      hooks: [{ type: "command", command: `${command} ask --agent codex` }],
    });
    return next;
  },

  uninstall: (settings) => CLAUDE.uninstall(settings),
};

/// Gemini CLI gets notifications and nothing else.
///
/// Its hooks can deny a tool call and nothing more: there is no mechanism for a
/// hook to grant permission or to ask. So "approve from your phone" cannot be
/// built on it - the best available would be a veto, where tapping Approve
/// leaves Gemini prompting in the terminal anyway, which is worse than not
/// offering it. Left as detection plus an honest sentence until that changes.
const GEMINI = {
  id: "gemini",
  name: "Gemini CLI",
  approves: false,
  config: (home) => join(home, ".gemini", "settings.json"),
  why: "its hooks can only block a tool call, never approve one",
};

export const AGENTS = [CLAUDE, CURSOR, CODEX, GEMINI];

export const agentById = (id) => AGENTS.find((a) => a.id === id);

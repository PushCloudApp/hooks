import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { agentById, AGENTS } from "../src/agents.mjs";

const claude = agentById("claude");
const OURS = { command: "node /path/to/pushcloud-hook.mjs", waitSeconds: 120 };

// The Claude adapter is what the original merge tests were written against, so
// they keep testing it by name; the cross-agent properties are asserted for
// every adapter further down.
const mergeHooks = (settings, opts) => claude.install(settings, { ...OURS, ...opts });
const removeHooks = (settings) => claude.uninstall(settings);

/// Somebody else's hook, of the shape people really have in these files.
const THEIRS = {
  matcher: "Write|Edit",
  hooks: [{ type: "command", command: "npx prettier --write" }],
};

describe("mergeHooks", () => {
  test("adds both hooks to an empty settings file", () => {
    const out = mergeHooks({});
    assert.equal(out.hooks.PreToolUse.length, 1);
    assert.equal(out.hooks.PreToolUse[0].matcher, "Bash");
    assert.match(out.hooks.PreToolUse[0].hooks[0].command, /pushcloud-hook\.mjs ask --agent claude$/);
    assert.match(out.hooks.Stop[0].hooks[0].command, /pushcloud-hook\.mjs notify --agent claude$/);
  });

  test("the PreToolUse timeout exceeds the hook's own wait", () => {
    // If Claude Code's timeout is shorter than the phone wait, it kills the hook
    // while the user is looking at the question. The install would then fail
    // only for people who take their time answering.
    assert.ok(mergeHooks({}).hooks.PreToolUse[0].hooks[0].timeout > 120);
  });

  test("leaves hooks that are not ours completely alone", () => {
    const before = { hooks: { PreToolUse: [THEIRS], PostToolUse: [THEIRS] } };
    const out = mergeHooks(before);
    assert.deepEqual(out.hooks.PreToolUse[0], THEIRS);
    assert.deepEqual(out.hooks.PostToolUse, [THEIRS]);
    assert.equal(out.hooks.PreToolUse.length, 2);
  });

  test("running it twice does not install the hook twice", () => {
    const once = mergeHooks({});
    const twice = mergeHooks(once);
    assert.equal(twice.hooks.PreToolUse.length, 1);
    assert.equal(twice.hooks.Stop.length, 1);
    assert.deepEqual(twice, once);
  });

  test("a re-run with a new path replaces the old one rather than stacking", () => {
    const old = mergeHooks({}, { command: "node /old/place/pushcloud-hook.mjs" });
    const moved = mergeHooks(old, { command: "node /new/place/pushcloud-hook.mjs" });
    assert.equal(moved.hooks.PreToolUse.length, 1);
    assert.match(moved.hooks.PreToolUse[0].hooks[0].command, /\/new\/place\//);
  });

  test("a re-run with a different matcher updates it", () => {
    const first = mergeHooks({}, { matcher: "Bash" });
    const second = mergeHooks(first, { matcher: "Bash|Write" });
    assert.equal(second.hooks.PreToolUse.length, 1);
    assert.equal(second.hooks.PreToolUse[0].matcher, "Bash|Write");
  });

  test("keeps settings keys it has never heard of", () => {
    const before = { model: "opus", permissions: { allow: ["Bash(ls:*)"] }, futureKey: [1, 2] };
    const out = mergeHooks(before);
    assert.equal(out.model, "opus");
    assert.deepEqual(out.permissions, { allow: ["Bash(ls:*)"] });
    assert.deepEqual(out.futureKey, [1, 2]);
  });

  test("does not mutate the object it was given", () => {
    const before = { hooks: { PreToolUse: [THEIRS] } };
    const snapshot = structuredClone(before);
    mergeHooks(before);
    assert.deepEqual(before, snapshot);
  });

  test("survives a hooks entry of an unexpected shape", () => {
    // Hand-edited files contain all sorts of things. Throwing here would mean
    // setup could not run at all for someone with a slightly odd file.
    const before = { hooks: { PreToolUse: "not an array", Weird: null } };
    const out = mergeHooks(before);
    assert.equal(out.hooks.PreToolUse.length, 1);
    assert.equal(out.hooks.Weird, null);
  });
});

describe("removeHooks", () => {
  test("takes ours out and leaves theirs", () => {
    const installed = mergeHooks({ hooks: { PreToolUse: [THEIRS] } });
    const out = removeHooks(installed);
    assert.deepEqual(out.hooks.PreToolUse, [THEIRS]);
    // Stop held nothing but ours, so it should be gone rather than left empty.
    assert.equal("Stop" in out.hooks, false);
  });

  test("leaves no trace when nothing else was there", () => {
    const out = removeHooks(mergeHooks({ model: "opus" }));
    assert.deepEqual(out, { model: "opus" });
  });

  test("is safe on a file that never had us in it", () => {
    const before = { hooks: { PreToolUse: [THEIRS] } };
    assert.deepEqual(removeHooks(before), before);
  });

  test("is safe on an empty object", () => {
    assert.deepEqual(removeHooks({}), {});
  });
});

/// The properties that must hold for every agent that can approve. Written as a
/// loop rather than three copies, so an adapter added later is covered the
/// moment it appears in AGENTS rather than whenever someone remembers.
describe("every approving agent", () => {
  const approving = AGENTS.filter((a) => a.approves);

  test("there are three of them", () => {
    assert.deepEqual(approving.map((a) => a.id), ["claude", "cursor", "codex"]);
  });

  for (const agent of approving) {
    describe(agent.name, () => {
      const opts = { command: "node /p/pushcloud-hook.mjs", waitSeconds: 120 };

      test("installing is idempotent", () => {
        const once = agent.install({}, opts);
        assert.deepEqual(agent.install(once, opts), once);
      });

      test("uninstall undoes install exactly", () => {
        const before = { existing: "value" };
        assert.deepEqual(agent.uninstall(agent.install(before, opts)), before);
      });

      test("it tells the hook which dialect to answer in", () => {
        const json = JSON.stringify(agent.install({}, opts));
        assert.ok(json.includes(`--agent ${agent.id}`), json);
      });

      test("a verdict is emitted for all three decisions", () => {
        for (const decision of ["allow", "deny", "ask"]) {
          const v = agent.verdict(decision, "because");
          assert.equal(typeof v, "object");
          assert.doesNotThrow(() => JSON.stringify(v));
        }
      });

      test("allow and deny are distinguishable, and neither looks like ask", () => {
        // A dialect where two decisions serialise the same way would approve
        // things the user denied, silently.
        const [allow, deny, ask] = ["allow", "deny", "ask"].map((d) =>
          JSON.stringify(agent.verdict(d, "r"))
        );
        assert.notEqual(allow, deny);
        assert.notEqual(allow, ask);
        assert.notEqual(deny, ask);
      });

      test("does not disturb another tool's hooks", () => {
        const theirs = { hooks: { SomeOtherEvent: [{ command: "their-linter" }] } };
        const out = agent.uninstall(agent.install(theirs, opts));
        assert.deepEqual(out.hooks.SomeOtherEvent, [{ command: "their-linter" }]);
      });
    });
  }
});

describe("Codex specifically", () => {
  const codex = agentById("codex");

  test("uses PermissionRequest, not PreToolUse", () => {
    // Codex's PreToolUse parser rejects `permissionDecision: allow` without an
    // updatedInput, and rejects `ask` outright, so a PreToolUse hook could only
    // ever say no. PermissionRequest is the event that can approve.
    const hooks = codex.install({}, { command: "node /p/pushcloud-hook.mjs" }).hooks;
    assert.ok(hooks.PermissionRequest, "should install on PermissionRequest");
    assert.equal(hooks.PreToolUse, undefined);
  });

  test("ask is an empty object, which lets Codex prompt normally", () => {
    assert.deepEqual(codex.verdict("ask", "no answer"), {});
  });

  test("allow and deny use the behavior field Codex actually parses", () => {
    assert.equal(codex.verdict("allow", "x").hookSpecificOutput.decision.behavior, "allow");
    assert.equal(codex.verdict("deny", "x").hookSpecificOutput.decision.behavior, "deny");
  });
});

describe("Cursor specifically", () => {
  const cursor = agentById("cursor");

  test("writes the version field Cursor requires", () => {
    assert.equal(cursor.install({}, { command: "node /p/pushcloud-hook.mjs" }).version, 1);
  });

  test("hooks the shell event", () => {
    const hooks = cursor.install({}, { command: "node /p/pushcloud-hook.mjs" }).hooks;
    assert.equal(hooks.beforeShellExecution.length, 1);
  });

  test("reads the command out of Cursor's own payload shape", () => {
    const call = cursor.read({ command: "rm -rf /", workspace_roots: ["/Users/me/proj"] });
    assert.equal(call.input.command, "rm -rf /");
    assert.equal(call.cwd, "/Users/me/proj");
  });
});

describe("Gemini CLI", () => {
  test("is present but not wired up, with a reason", () => {
    const gemini = agentById("gemini");
    assert.equal(gemini.approves, false);
    // The reason is printed to the user, so it has to say something true.
    assert.match(gemini.why, /deny|block/);
  });
});

describe("Claude Code session hooks", () => {
  const opts = { command: 'node "/h/.pushcloud/bin/pushcloud-hook.mjs"', waitSeconds: 120 };
  const EVENTS = { SessionStart: "session-start", Notification: "notification", Stop: "stop" };
  const commandsFor = (hooks, event) => (hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));

  test("install adds SessionStart, Notification and Stop entries pointing at --event <name>", () => {
    const { hooks } = claude.install({}, opts);
    for (const [event, name] of Object.entries(EVENTS)) {
      const cmds = commandsFor(hooks, event);
      assert.ok(cmds.includes(`${opts.command} --event ${name}`), `${event}: ${JSON.stringify(cmds)}`);
    }
  });

  test("each entry appears once, however often install runs", () => {
    const once = claude.install({}, opts);
    const thrice = claude.install(claude.install(once, opts), opts);
    assert.deepEqual(thrice, once);
    for (const [event, name] of Object.entries(EVENTS)) {
      const hits = commandsFor(thrice.hooks, event).filter((c) => c.endsWith(`--event ${name}`));
      assert.equal(hits.length, 1, event);
    }
  });

  test("the notify Stop hook is still installed alongside the session one", () => {
    const cmds = commandsFor(claude.install({}, opts).hooks, "Stop");
    assert.ok(cmds.some((c) => c.endsWith("notify --agent claude")), JSON.stringify(cmds));
  });

  test("session hooks carry a short timeout", () => {
    const { hooks } = claude.install({}, opts);
    for (const event of Object.keys(EVENTS)) {
      for (const g of hooks[event]) {
        for (const h of g.hooks.filter((x) => x.command.includes("--event"))) {
          assert.ok(h.timeout > 0 && h.timeout <= 10, `${event} timeout ${h.timeout}`);
        }
      }
    }
  });

  test("uninstall removes only ours, leaving a user's own Stop hook in place", () => {
    const theirStop = { hooks: [{ type: "command", command: "say done" }] };
    const theirStart = { matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] };
    const before = { hooks: { Stop: [theirStop], SessionStart: [theirStart] } };
    const installed = claude.install(before, opts);
    assert.deepEqual(installed.hooks.Stop[0], theirStop);
    const out = claude.uninstall(installed);
    assert.deepEqual(out, before);
    assert.equal("Notification" in out.hooks, false);
  });
});

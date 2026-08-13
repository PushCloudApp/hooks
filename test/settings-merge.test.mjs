import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mergeHooks, removeHooks } from "../src/settings-merge.mjs";

const OURS = { command: "node /path/to/pushcloud-hook.mjs" };

/// Somebody else's hook, of the shape people really have in these files.
const THEIRS = {
  matcher: "Write|Edit",
  hooks: [{ type: "command", command: "npx prettier --write" }],
};

describe("mergeHooks", () => {
  test("adds both hooks to an empty settings file", () => {
    const out = mergeHooks({}, OURS);
    assert.equal(out.hooks.PreToolUse.length, 1);
    assert.equal(out.hooks.PreToolUse[0].matcher, "Bash");
    assert.match(out.hooks.PreToolUse[0].hooks[0].command, /pushcloud-hook\.mjs ask$/);
    assert.match(out.hooks.Stop[0].hooks[0].command, /pushcloud-hook\.mjs notify$/);
  });

  test("the PreToolUse timeout exceeds the hook's own wait", () => {
    // If Claude Code's timeout is shorter than the phone wait, it kills the hook
    // while the user is looking at the question. The install would then fail
    // only for people who take their time answering.
    assert.ok(mergeHooks({}, OURS).hooks.PreToolUse[0].hooks[0].timeout > 120);
  });

  test("leaves hooks that are not ours completely alone", () => {
    const before = { hooks: { PreToolUse: [THEIRS], PostToolUse: [THEIRS] } };
    const out = mergeHooks(before, OURS);
    assert.deepEqual(out.hooks.PreToolUse[0], THEIRS);
    assert.deepEqual(out.hooks.PostToolUse, [THEIRS]);
    assert.equal(out.hooks.PreToolUse.length, 2);
  });

  test("running it twice does not install the hook twice", () => {
    const once = mergeHooks({}, OURS);
    const twice = mergeHooks(once, OURS);
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
    const first = mergeHooks({}, { ...OURS, matcher: "Bash" });
    const second = mergeHooks(first, { ...OURS, matcher: "Bash|Write" });
    assert.equal(second.hooks.PreToolUse.length, 1);
    assert.equal(second.hooks.PreToolUse[0].matcher, "Bash|Write");
  });

  test("keeps settings keys it has never heard of", () => {
    const before = { model: "opus", permissions: { allow: ["Bash(ls:*)"] }, futureKey: [1, 2] };
    const out = mergeHooks(before, OURS);
    assert.equal(out.model, "opus");
    assert.deepEqual(out.permissions, { allow: ["Bash(ls:*)"] });
    assert.deepEqual(out.futureKey, [1, 2]);
  });

  test("does not mutate the object it was given", () => {
    const before = { hooks: { PreToolUse: [THEIRS] } };
    const snapshot = structuredClone(before);
    mergeHooks(before, OURS);
    assert.deepEqual(before, snapshot);
  });

  test("survives a hooks entry of an unexpected shape", () => {
    // Hand-edited files contain all sorts of things. Throwing here would mean
    // setup could not run at all for someone with a slightly odd file.
    const before = { hooks: { PreToolUse: "not an array", Weird: null } };
    const out = mergeHooks(before, OURS);
    assert.equal(out.hooks.PreToolUse.length, 1);
    assert.equal(out.hooks.Weird, null);
  });
});

describe("removeHooks", () => {
  test("takes ours out and leaves theirs", () => {
    const installed = mergeHooks({ hooks: { PreToolUse: [THEIRS] } }, OURS);
    const out = removeHooks(installed);
    assert.deepEqual(out.hooks.PreToolUse, [THEIRS]);
    // Stop held nothing but ours, so it should be gone rather than left empty.
    assert.equal("Stop" in out.hooks, false);
  });

  test("leaves no trace when nothing else was there", () => {
    const out = removeHooks(mergeHooks({ model: "opus" }, OURS));
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

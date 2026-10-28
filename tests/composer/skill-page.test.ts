import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context),
});
const { skillTree, skillAuthor } =
  await import("../../src/settings/tabs/SkillPage");

test("a skill's folder becomes a tree with SKILL.md first (R-1622)", () => {
  const tree = skillTree([
    "scripts/b.py",
    "agents/grader.md",
    "SKILL.md",
    "agents/analyzer.md",
    "LICENSE.txt",
  ]);
  assert.deepEqual(tree.files, ["SKILL.md", "LICENSE.txt"]);
  assert.deepEqual(
    tree.folders.map((folder) => [folder.name, folder.files]),
    [
      ["agents", ["agents/analyzer.md", "agents/grader.md"]],
      ["scripts", ["scripts/b.py"]],
    ],
  );
  assert.equal(skillAuthor("user"), "You");
  assert.equal(skillAuthor("system"), "Codex");
});

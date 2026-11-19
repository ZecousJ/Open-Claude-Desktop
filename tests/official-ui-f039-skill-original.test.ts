/** Executes the pinned original editor serializer, not a screenshot or rendered UI test. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";

const original = process.env.CLAUDEX_ORIGINAL_SKILL_SERIALIZER;
function serializer() {
  const text = fs.readFileSync(original!, "utf8");
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    "b7b3d58df26a60ce5e4ad1e2dd2cb1607056a645279fb37d1b91cf32852682e6",
  );
  const source = ts.createSourceFile(
    "original.js",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const matches: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "Vb" &&
      node.initializer
    )
      matches.push(node.initializer.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1);
  const begin = text.indexOf("var db,"),
    end = text.indexOf("function yb(", begin);
  assert.ok(begin > 0 && end > begin);
  return vm.runInNewContext(
    `${text.slice(begin, end)}\n(${matches[0]})`,
    {},
    { timeout: 1000 },
  ) as (doc: unknown) => string;
}

test(
  "the original serializer gives identical text for selected and manually typed slashes",
  { skip: !original },
  () => {
    const serialize = serializer();
    const doc = (content: unknown[]) => ({
      type: "doc",
      content: [{ type: "paragraph", content }],
    });
    const text = "🔎 Use /review, then /演示.";
    assert.equal(serialize(doc([{ type: "text", text }])), text);
    assert.equal(
      serialize(
        doc([
          { type: "text", text: "🔎 Use " },
          {
            type: "skillChip",
            attrs: { skillId: "review", skillDisplayName: "Readable label" },
          },
          { type: "text", text: ", then " },
          { type: "skillChip", attrs: { skillId: "演示" } },
          { type: "text", text: "." },
        ]),
      ),
      text,
    );
  },
);

test(
  "the original remote chip preserves its connector and skill identity in the serialized text",
  { skip: !original },
  () => {
    const id = "12345678-1234-1234-1234-123456789abc:review";
    const prompt = serializer()({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Inspect with " },
            {
              type: "skillChip",
              attrs: { skillId: id, skillDisplayName: "Review" },
            },
          ],
        },
      ],
    });
    assert.equal(prompt, `Inspect with /${id}`);
  },
);

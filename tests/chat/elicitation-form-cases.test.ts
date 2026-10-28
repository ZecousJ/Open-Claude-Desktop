import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  elicitationContent,
  elicitationFields,
  elicitationResult,
  problemMessage,
  type FormField,
} from "../../src/approval/elicitation-form";

/**
 * The cases the desktop, the iOS Core and the Android app all pass
 * (ElicitationFormTests.swift, ElicitationFormTest.kt read the same file).
 */
const file = new URL(
  "../fixtures/elicitation-form-cases.json",
  import.meta.url,
);
const { cases } = JSON.parse(fs.readFileSync(file, "utf8")) as {
  cases: {
    name: string;
    schema: unknown;
    fields: Record<string, any>[];
    attempts: {
      values: Record<string, any>;
      content?: Record<string, unknown>;
      problem?: Record<string, unknown>;
    }[];
  }[];
};

for (const item of cases) {
  test(`form fields and answers: ${item.name}`, () => {
    const fields = elicitationFields(item.schema);
    assert.deepEqual(
      fields.map((field) => field.name),
      item.fields.map((field) => field.name),
    );
    for (const [index, expected] of item.fields.entries()) {
      const actual: any = fields[index];
      for (const [key, value] of Object.entries(expected)) {
        if (key === "options")
          assert.deepEqual(
            actual.options.map((o: FormField["options"][number]) => [
              o.value,
              o.label,
            ]),
            value,
            `${expected.name}.${key}`,
          );
        else assert.deepEqual(actual[key], value, `${expected.name}.${key}`);
      }
    }
    for (const attempt of item.attempts) {
      const result = elicitationResult(fields, attempt.values);
      if (attempt.problem) {
        assert.ok("problem" in result, JSON.stringify(attempt.values));
        assert.deepEqual(result.problem, attempt.problem);
        assert.deepEqual(elicitationContent(fields, attempt.values), {
          error: problemMessage(result.problem),
        });
      } else {
        assert.ok("content" in result, JSON.stringify(attempt.values));
        assert.deepEqual(result.content, attempt.content);
      }
    }
  });
}

test("a problem reads as the desktop's sentence", () => {
  const fields = elicitationFields({
    properties: { n: { type: "integer", title: "Count", minimum: 1 } },
  });
  assert.deepEqual(elicitationContent(fields, { n: "0" }), {
    error: "Count must be at least 1.",
  });
});

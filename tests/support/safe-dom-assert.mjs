/**
 * A failed assert.equal / deepEqual between DOM nodes (linkedom) makes Node
 * render a diff of both nodes' whole object graphs: tens of GB in seconds,
 * synchronously, so neither --test-timeout nor --max-old-space-size stops it.
 * Loaded with css-stub.mjs, this makes every equality assertion with a node (or
 * an array of nodes) on either side compare by identity and fail with a short
 * description such as `<button#id.class>`, never a diff of the nodes.
 */
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert";

const isNode = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.nodeType === "number" &&
  typeof value.nodeName === "string";
const hasNode = (value) =>
  isNode(value) || (Array.isArray(value) && value.some(isNode));

function describe(value) {
  if (isNode(value)) {
    const id = value.id ? `#${value.id}` : "";
    const classes =
      typeof value.className === "string" && value.className.trim()
        ? `.${value.className.trim().split(/\s+/).join(".")}`
        : "";
    return `<${String(value.nodeName).toLowerCase()}${id}${classes}>`;
  }
  if (Array.isArray(value)) return `[${value.map(describe).join(", ")}]`;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}

function same(actual, expected, deep) {
  if (!deep || !Array.isArray(actual) || !Array.isArray(expected))
    return actual === expected;
  return (
    actual.length === expected.length &&
    actual.every((item, index) => item === expected[index])
  );
}

const names = [
  ["equal", false, true],
  ["strictEqual", false, true],
  ["notEqual", false, false],
  ["notStrictEqual", false, false],
  ["deepEqual", true, true],
  ["deepStrictEqual", true, true],
  ["notDeepEqual", true, false],
  ["notDeepStrictEqual", true, false],
];
for (const target of [assert, assert.strict]) {
  for (const [name, deep, want] of names) {
    const original = target[name];
    if (typeof original !== "function") continue;
    const guarded = function (actual, expected, message) {
      if (!hasNode(actual) && !hasNode(expected))
        return original.apply(this, arguments);
      if (same(actual, expected, deep) === want) return;
      if (message instanceof Error) throw message;
      throw new assert.AssertionError({
        message:
          message ??
          `${describe(actual)} ${want ? "!==" : "==="} ${describe(expected)}`,
        actual: describe(actual),
        expected: describe(expected),
        operator: name,
        stackStartFn: guarded,
      });
    };
    target[name] = guarded;
  }
}
syncBuiltinESMExports();

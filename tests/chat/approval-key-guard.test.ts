import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { guardApprovalKey, ARM_GRACE_MS } from "../../src/approval/key-guard";
import { approvalShortcut, Keycap } from "../../src/approval/ApprovalActions";
import { PlanApprovalCard } from "../../src/plan/PlanApprovalCard";
import type { Conversation } from "../../shared/types";

const idle = {
  armedAt: 0,
  typedAt: -Infinity,
  focusedAt: -Infinity,
};
const key = (extra: Record<string, unknown> = {}) => ({
  key: "Enter",
  repeat: false,
  metaKey: true,
  ctrlKey: false,
  target: null as EventTarget | null,
  ...extra,
});
const outside = (inCard: boolean) =>
  ({
    closest: (selector: string) =>
      inCard && selector.includes(".approval-card") ? {} : null,
  }) as unknown as EventTarget;

test("a key does nothing in the first 400ms after the card appears or the window refocuses", () => {
  assert.equal(
    guardApprovalKey(
      key(),
      { ...idle, armedAt: 1000 },
      1000 + ARM_GRACE_MS - 1,
    ),
    "swallow",
  );
  assert.equal(
    guardApprovalKey(key(), { ...idle, armedAt: 1000 }, 1000 + ARM_GRACE_MS),
    "act",
  );
  assert.equal(
    guardApprovalKey(
      key({ key: "Escape", metaKey: false }),
      { ...idle, focusedAt: 5000 },
      5100,
    ),
    "swallow",
  );
});

test("a held key never acts", () => {
  assert.equal(
    guardApprovalKey(key({ repeat: true }), idle, 10_000),
    "swallow",
  );
  assert.equal(
    guardApprovalKey(key({ key: "Escape", repeat: true }), idle, 10_000),
    "swallow",
  );
});

test("⌘↩ right after typing outside the card is swallowed, inside the card it is not", () => {
  const typed = { ...idle, typedAt: 9900 };
  assert.equal(guardApprovalKey(key(), typed, 10_000), "swallow");
  assert.equal(
    guardApprovalKey(key({ target: outside(true) }), typed, 10_000),
    "act",
  );
  assert.equal(guardApprovalKey(key(), typed, 10_400), "act");
});

test("⌘↩ from a field outside the card and the composer is swallowed", () => {
  const field = (selector: RegExp) =>
    ({
      closest: (query: string) => (selector.test(query) ? {} : null),
    }) as unknown as EventTarget;
  assert.equal(
    guardApprovalKey(key({ target: field(/^$/) }), idle, 10_000),
    "swallow",
  );
  assert.equal(
    guardApprovalKey(key({ target: field(/composer-wrap/) }), idle, 10_000),
    "act",
  );
});

test("a card without number keycaps ignores 1, 2 and 3", () => {
  const calls: string[] = [];
  const handlers = {
    deny: () => calls.push("deny"),
    once: () => calls.push("once"),
    digits: false,
  };
  const press = (k: string, extra = {}) =>
    approvalShortcut(
      {
        key: k,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
        ...extra,
      },
      handlers,
      true,
    );
  assert.equal(press("1"), undefined);
  press("Escape")?.();
  press("Enter", { metaKey: true })?.();
  assert.deepEqual(calls, ["deny", "once"]);
});

test("the plan card is the proposed-plan card with Reject, Revise… and the accept buttons", () => {
  const html = renderToStaticMarkup(
    createElement(PlanApprovalCard, {
      conversation: {
        id: "c1",
        mode: "code",
        turns: [],
      } as unknown as Conversation,
      mac: true,
      autoAcceptAvailable: true,
      updatePreference: async () => {},
      onSent: () => {},
      onKeepPlanning: () => {},
      onError: () => {},
    }),
  );
  assert.match(html, /Claudex proposed a plan/);
  assert.match(html, />Open plan</);
  for (const label of ["Reject", "Revise…", "Accept", "Accept and allow edits"])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /Plan feedback/);
  assert.doesNotMatch(html, /data-key="1"/);
});

test("keycaps write modifier keys as text: symbols on Mac, words elsewhere", () => {
  const cap = (k: "shift" | "mod", mac: boolean) =>
    renderToStaticMarkup(createElement(Keycap, { k, mac }));
  assert.match(cap("mod", true), />\u2318</);
  assert.match(cap("shift", true), />\u21E7</);
  assert.match(cap("mod", false), />Ctrl</);
  assert.match(cap("shift", false), />Shift</);
  assert.doesNotMatch(cap("mod", true), /<svg/);
  assert.doesNotMatch(cap("shift", true), /<svg/);
});

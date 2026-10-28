import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PlanSteps,
  currentStepIndex,
  foldedStepCount,
} from "../../src/plan/PlanSteps";
import { currentLocale, setLocale } from "../../src/i18n";

const steps = (...statuses: string[]) =>
  statuses.map((status, index) => ({ step: `Step ${index + 1}`, status }));

test("finished steps at the top fold, keeping the last two in view", () => {
  assert.equal(foldedStepCount(steps("completed", "completed")), 0);
  assert.equal(
    foldedStepCount(
      steps("completed", "completed", "completed", "inProgress", "pending"),
    ),
    1,
  );
  // Only the unbroken run at the top counts.
  assert.equal(
    foldedStepCount(
      steps("completed", "pending", "completed", "completed", "completed"),
    ),
    0,
  );
  assert.equal(foldedStepCount(steps(...Array(6).fill("completed"))), 4);
});

test("the list points at the running step, else the first open one, else the last", () => {
  assert.equal(currentStepIndex(steps("completed", "inProgress")), 1);
  assert.equal(currentStepIndex(steps("completed", "pending", "pending")), 1);
  assert.equal(currentStepIndex(steps("completed", "completed")), 1);
});

test("the rail joins each step to the next and the fold names its count", () => {
  const html = renderToStaticMarkup(
    createElement(PlanSteps, {
      conversationId: "c",
      plan: steps("completed", "completed", "completed", "inProgress"),
      live: true,
    }),
  );
  assert.match(html, /1 earlier step/);
  // Three visible steps, two rails between them; the walked one is marked.
  assert.equal(html.match(/class="plan-rail"/g)?.length, 2);
  assert.match(html, /class="plan-rail" data-walked/);
  const building = renderToStaticMarkup(
    createElement(PlanSteps, {
      conversationId: "c",
      plan: steps("pending", "pending"),
      live: true,
    }),
  );
  assert.match(building, /data-building/);
});

test("the fold names its count in the interface language", async () => {
  const previous = currentLocale();
  try {
    await setLocale("zh-CN");
    const html = renderToStaticMarkup(
      createElement(PlanSteps, {
        conversationId: "c",
        plan: steps("completed", "completed", "completed", "inProgress"),
        live: true,
      }),
    );
    assert.match(html, /1 个较早步骤/);
  } finally {
    await setLocale(previous);
  }
});

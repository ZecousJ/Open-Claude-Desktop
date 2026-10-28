import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost, webHost } from "../../shared/host";
import type { Routine } from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import {
  RoutineDetail,
  type RoutineDetailProps,
} from "../../src/collections/routines/RoutineDetail";
import { RoutineHistory } from "../../src/collections/routines/RoutineHistory";
import { routineDom } from "../support/routine-dom";
test("the current shared Run now button keeps the measured control font axes", () => {
  const css = readFileSync(
    "src/collections/routines/web-routine-detail.css",
    "utf8",
  ).replace(/\s+/g, " ");
  const rule = css.match(
    /\.scheduled-detail-actions > \.scheduled-detail-run\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(rule);
  assert.match(rule, /font-variation-settings:\s*"GRAD" 0, "wght" 460/);
});
const task: Routine = {
  id: "b19-detail",
  name: "User title <kept>",
  prompt: "Neutral detail instructions",
  mode: "cowork",
  providerId: "fixture",
  model: "Sonnet",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:59" },
  nextRunAt: Date.now() + 86_400_000,
  createdAt: 1,
  updatedAt: 1,
  permission: "auto",
  executionLocation: "remote",
};
const props: RoutineDetailProps = {
  routine: task,
  onClose() {},
  onEdit() {},
  onRename: async () => {},
  onDelete() {},
  onRun() {},
  onEnabled() {},
  onRemoveApproval() {},
  onOpenConversation() {},
  running: false,
  disabled: false,
};
const wrap = (child: ReturnType<typeof h>, host = webHost) =>
  h(HostContext.Provider, { value: host }, child);
const read = (file: string) =>
  readFileSync(
    new URL(`../../src/collections/routines/${file}`, import.meta.url),
    "utf8",
  );
test("47: default web and desktop Scheduled details share the captured title/next-run/action/status/switch order", () => {
  for (const host of [webHost, desktopHost]) {
    const dom = new JSDOM(
      renderToStaticMarkup(wrap(h(RoutineDetail, props), host)),
    );
    try {
      const document = dom.window.document,
        header = document.querySelector(".scheduled-detail-header")!;
      assert.ok(header);
      assert.equal(header.querySelector("h1")!.textContent, task.name);
      assert.ok(header.querySelector("h1")!.hasAttribute("data-no-translate"));
      assert.match(
        header.querySelector(".scheduled-detail-heading p")!.textContent!,
        /^Next run: /,
      );
      assert.deepEqual(
        [...header.querySelectorAll(".scheduled-detail-actions > *")].map(
          (node) => node.className,
        ),
        ["primary scheduled-detail-run", "scheduled-detail-status"],
      );
      assert.equal(
        header.querySelector(".scheduled-detail-status > span")!.textContent,
        "Active",
      );
      assert.equal(
        header.querySelector('[role="switch"]')!.getAttribute("aria-label"),
        "Enable schedule",
      );
      assert.equal(
        header.querySelector('[role="switch"]')!.getAttribute("aria-checked"),
        "true",
      );
      assert.equal(
        header.querySelectorAll('[aria-label="Edit"],[aria-label="Delete"]')
          .length,
        0,
      );
      const style = document.createElement("style");
      style.textContent =
        read("routine-detail.css") + read("web-routine-detail.css");
      document.head.append(style);
      const heading = dom.window.getComputedStyle(header.querySelector("h1")!),
        run = dom.window.getComputedStyle(
          header.querySelector(".scheduled-detail-run")!,
        ),
        toggle = dom.window.getComputedStyle(
          header.querySelector('[role="switch"]')!,
        );
      assert.equal(heading.fontSize, "24px");
      assert.equal(heading.lineHeight, "31.2px");
      assert.equal(heading.fontWeight, "600");
      assert.equal(run.height, "32px");
      assert.equal(run.borderRadius, "8px");
      assert.equal(toggle.width, "36px");
      assert.equal(toggle.height, "20px");
    } finally {
      dom.window.close();
    }
  }
});
test("47: the separate legacy local/Epitaxy presentation remains explicit, rather than guessed from host", () => {
  const dom = new JSDOM(
    renderToStaticMarkup(
      wrap(
        h(RoutineDetail, { ...props, presentation: "legacy-local" }),
        desktopHost,
      ),
    ),
  );
  try {
    assert.ok(dom.window.document.querySelector(".routine-detail-back"));
    assert.ok(dom.window.document.querySelector('[aria-label="Edit"]'));
    assert.equal(
      dom.window.document.querySelector(".scheduled-detail-toolbar"),
      null,
    );
  } finally {
    dom.window.close();
  }
});
test("47/23: real header run and enable callbacks stay usable and real refusal/busy/empty-prompt states cannot run", async () => {
  const env = await routineDom();
  let runs = 0,
    enabled: boolean[] = [];
  const run = () => {
    runs++;
  };
  try {
    for (const host of [webHost, desktopHost]) {
      await env.render(
        wrap(
          h(RoutineDetail, {
            ...props,
            onRun: run,
            onEnabled: (value) => enabled.push(value),
          }),
          host,
        ),
      );
      await env.click(".scheduled-detail-run");
      await env.click('[role="switch"]');
      for (const condition of [
        { running: true },
        { disabled: true },
        { hold: "Actual connection refusal" },
        { routine: { ...task, prompt: "" } },
        { routine: { ...task, lastRunStatus: "running" as const } },
      ]) {
        await env.render(
          wrap(h(RoutineDetail, { ...props, onRun: run, ...condition }), host),
        );
        const button = env.document.querySelector<HTMLButtonElement>(
          ".scheduled-detail-run",
        )!;
        assert.equal(button.disabled, true);
        const before = runs;
        await env.event(button, "click");
        assert.equal(runs, before);
      }
    }
    assert.equal(runs, 2);
    assert.deepEqual(enabled, [false, false]);
  } finally {
    await env.clean();
  }
});
test("23: current frame empty history has its real primary action in the header and no duplicated empty-card Run now", async () => {
  const env = await routineDom();
  try {
    await env.render(wrap(h(RoutineDetail, props)));
    assert.equal(
      env.document.querySelectorAll(".scheduled-detail-run").length,
      1,
    );
    assert.equal(env.document.querySelector(".routine-history-run"), null);
    assert.equal(
      env.document.querySelector(".routine-history-empty p")?.textContent,
      "No runs yet",
    );
  } finally {
    await env.clean();
  }
});
test("23: compact unified empty history offers the actual callback; prior history and no prior run use distinct copy", async () => {
  const env = await routineDom();
  let runs = 0;
  try {
    for (const prior of [undefined, 123]) {
      await env.render(
        wrap(
          h(RoutineDetail, {
            ...props,
            routine: { ...task, lastRunAt: prior },
            runActionPlacement: "history",
            onRun: () => runs++,
          }),
        ),
      );
      const header = env.document.querySelector(".scheduled-detail-run")!;
      assert.equal(header.getAttribute("aria-label"), "Run now");
      assert.equal(
        [...header.childNodes]
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent)
          .join(""),
        "",
      );
      assert.equal(header.classList.contains("primary"), false);
      assert.equal(
        env.document.querySelector(".routine-history-empty p")?.textContent,
        prior ? "No runs to show" : "No runs yet",
      );
      const action = env.document.querySelector<HTMLButtonElement>(
        ".routine-history-run",
      )!;
      assert.equal(
        [...action.childNodes]
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent)
          .join(""),
        "Run now",
      );
      assert.equal(action.disabled, false);
      await env.event(action, "click");
    }
    assert.equal(runs, 2);
  } finally {
    await env.clean();
  }
});
test("23: pending, failed and nonempty reads never pretend to be actionable empty history", async () => {
  let resolve!: (value: RoutineRun[]) => void;
  const pending = new Promise<RoutineRun[]>((done) => (resolve = done));
  const env = await routineDom({ routineRuns: () => pending });
  try {
    await env.render(
      wrap(h(RoutineDetail, { ...props, runActionPlacement: "history" })),
    );
    assert.ok(env.document.querySelector(".routine-history-loading"));
    assert.equal(env.document.querySelector(".routine-history-run"), null);
    await act(async () =>
      resolve([
        {
          id: "real-run",
          startedAt: 100,
          status: "completed",
          trigger: "manual",
          conversationId: "real-conversation",
        },
      ]),
    );
    assert.ok(env.document.querySelector(".routine-history-row"));
    assert.equal(env.document.querySelector(".routine-history-run"), null);
    env.window.desktop.routineRuns = async () => {
      throw new Error("Actual read failed");
    };
    await env.render(
      wrap(
        h(RoutineDetail, {
          ...props,
          routine: { ...task, id: "failed" },
          runActionPlacement: "history",
        }),
      ),
    );
    assert.match(
      env.document.querySelector('[role="alert"]')!.textContent!,
      /Actual read failed/,
    );
    assert.equal(env.document.querySelector(".routine-history-run"), null);
  } finally {
    await env.clean();
  }
});
test("23: absent run capability has no empty action, and actual hold/busy/disabled states preserve its refusal", async () => {
  const env = await routineDom();
  let runs = 0;
  try {
    await env.render(
      wrap(h(RoutineHistory, { routine: task, onOpenConversation() {} })),
    );
    assert.equal(env.document.querySelector(".routine-history-run"), null);
    for (const condition of [
      { running: true },
      { disabled: true },
      { hold: "Real policy refusal" },
      { routine: { ...task, prompt: "" } },
    ]) {
      await env.render(
        wrap(
          h(RoutineDetail, {
            ...props,
            runActionPlacement: "history",
            onRun: () => runs++,
            ...condition,
          }),
        ),
      );
      const button = env.document.querySelector<HTMLButtonElement>(
        ".routine-history-run",
      )!;
      assert.equal(button.disabled, true);
      await env.event(button, "click");
      if ("hold" in condition) assert.equal(button.title, condition.hold);
      if ("running" in condition)
        assert.equal(button.getAttribute("aria-busy"), "true");
    }
    assert.equal(runs, 0);
  } finally {
    await env.clean();
  }
});

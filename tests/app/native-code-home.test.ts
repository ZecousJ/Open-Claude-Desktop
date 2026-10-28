import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, StrictMode, type ReactNode } from "react";
import { parseHTML } from "linkedom";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import type { Conversation, DesktopAPI, PlanUsage } from "../../shared/types";
import { defaultSettings } from "../../electron/store/store";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { NativeCliImportCard } from "../../src/code-home/NativeCliImportCard";
import { UsageTab } from "../../src/settings/tabs/Usage";
import NextSteps from "../../src/code-home/NextSteps";
import { CodeHome } from "../../src/code-home/CodeHome";
import { EnvironmentStartCard } from "../../src/composer/EnvironmentStartCard";

async function page(
  bridge: Partial<DesktopAPI> = {},
  override: Partial<AppController> = {},
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  window.desktop = bridge as DesktopAPI;
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof matchMedia;
  const oldFocus = window.HTMLElement.prototype.focus;
  let focused: HTMLElement | undefined;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused ?? document.body,
  });
  const globals = {
    window,
    document,
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      overflowX: "visible",
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const errors: unknown[] = [];
  const conversations = [
    {
      id: "local-code",
      mode: "code",
      model: "sonnet-5",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
      turns: [
        {
          createdAt: Date.now() - 1000,
          inputTokens: 100,
          outputTokens: 50,
          items: [],
        },
      ],
    },
  ] as unknown as Conversation[];
  const controller = (accountId: string) =>
    ({
      accountId,
      snapshot: { conversations, settings: defaultSettings },
      report: (error: unknown) => errors.push(error),
      ...override,
    }) as unknown as AppController;
  return {
    window,
    document,
    errors,
    async render(
      node: ReactNode,
      host: HostInfo = desktopHost,
      account = "one",
      strict = false,
    ) {
      const tree = createElement(
        HostContext.Provider,
        { value: host },
        createElement(
          AppContext.Provider,
          { value: controller(account) },
          node,
        ),
      );
      await act(async () =>
        root.render(strict ? createElement(StrictMode, null, tree) : tree),
      );
    },
    async flush() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    async click(element: Element) {
      await act(async () =>
        element.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
    },
    async focus() {
      await act(async () => window.dispatchEvent(new window.Event("focus")));
    },
    async restore() {
      await act(async () => root.unmount());
      window.HTMLElement.prototype.focus = oldFocus;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("native eligible CLI count opens the existing confirmation, imports once, and refreshes after Done", async () => {
  let count = 1,
    imported = 0,
    probes = 0;
  const env = await page({
    probeImportableCliSessions: async () => {
      probes++;
      return { count };
    },
    importAllCliSessions: async () => {
      imported++;
      count = 0;
      return { imported: 1, skipped: 0 };
    },
  });
  try {
    await env.render(createElement(NativeCliImportCard));
    await env.flush();
    const action = env.document.querySelector<HTMLButtonElement>(
      ".native-cli-import-action",
    )!;
    assert.equal(
      action.querySelector(".next-step-title")?.textContent,
      "Import 1 Claude Code CLI session",
    );
    assert.equal(
      action.querySelector(".next-step-detail")?.textContent,
      "found on this computer",
    );
    assert.equal(imported, 0);
    action.focus();
    await env.click(action);
    await env.flush();
    const dialog = env.document.querySelector('[role="alertdialog"]')!;
    assert.ok(
      dialog,
      "uses actual CliImportDialog rather than importing on the card click",
    );
    assert.equal(imported, 0);
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Import",
    )!;
    await env.click(confirm);
    assert.equal(imported, 1);
    assert.match(dialog.textContent!, /Imported 1 session/);
    await env.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Done",
      )!,
    );
    await env.flush();
    assert.equal(env.document.querySelector('[role="alertdialog"]'), null);
    assert.equal(env.document.querySelector(".native-cli-import-card"), null);
    assert.ok(
      probes >= 3,
      "card, confirmation, then post-import eligible count",
    );
    assert.deepEqual(env.errors, []);
  } finally {
    await env.restore();
  }
});

test("actual native home places eligible import below the environment card without executing the old landing/statistics", async () => {
  let probes = 0,
    dashboards = 0;
  const env = await page({
    probeImportableCliSessions: async () => {
      probes++;
      return { count: 1 };
    },
    codeUsageDashboard: async () => {
      dashboards++;
      return null;
    },
  });
  const composer = createElement(
    "div",
    { className: "code-composer" },
    createElement(EnvironmentStartCard, {
      rows: [{ id: "workspace", name: "workspace", onSelect() {} }],
      selectedId: "workspace",
      open: false,
      onChoose() {},
    }),
    createElement("textarea", { "aria-label": "Prompt" }),
  );
  const home = createElement(CodeHome, {
    name: "Ada",
    conversations: [],
    composer,
    landing: createElement(
      "section",
      { "data-legacy-landing": true },
      "Sessions",
    ),
  });
  try {
    await env.render(home);
    await env.flush();
    const centre = env.document.querySelector(".native-code-home-centre")!;
    const target = centre.querySelector(".native-code-home-environments")!;
    assert.ok(target.querySelector(".environment-start-card"));
    assert.ok(
      centre.querySelector(
        "ul.native-code-home-suggestions > li.native-cli-import-card",
      ),
      "the import is a row of the shared start-card list",
    );
    assert.equal(centre.children[0], target);
    assert.equal(
      env.document.querySelector(".code-composer .environment-start-card"),
      null,
    );
    assert.equal(
      env.document.querySelector("h1, .usage-overview, [data-legacy-landing]"),
      null,
    );
    assert.equal(dashboards, 0);
    const reads = probes;
    await env.render(home, webHost);
    await env.focus();
    assert.equal(env.document.querySelector(".native-cli-import-card"), null);
    assert.equal(probes, reads, "web has no local CLI discovery side effect");
  } finally {
    await env.restore();
  }
});

test("CLI card plural/dismiss behavior stays local to the account and never probes web or unsupported hosts", async () => {
  let count = 2,
    probes = 0;
  const env = await page({
    probeImportableCliSessions: async () => {
      probes++;
      return { count };
    },
  });
  try {
    await env.render(createElement(NativeCliImportCard), webHost);
    assert.equal(probes, 0);
    await env.render(createElement(NativeCliImportCard), {
      ...desktopHost,
      capabilities: { ...desktopHost.capabilities, localCode: false },
    });
    assert.equal(probes, 0);
    await env.render(createElement(NativeCliImportCard));
    assert.match(
      env.document.querySelector(".native-cli-import-action")?.textContent ??
        "",
      /Import 2 Claude Code CLI sessions/,
    );
    await env.click(env.document.querySelector(".native-cli-import-dismiss")!);
    await env.focus();
    assert.equal(env.document.querySelector(".native-cli-import-card"), null);
    count = 3;
    await env.render(createElement(NativeCliImportCard), desktopHost, "two");
    assert.match(
      env.document.querySelector(".native-cli-import-action")?.textContent ??
        "",
      /Import 3 Claude Code CLI sessions/,
    );
  } finally {
    await env.restore();
  }
});

test("the reused CLI confirmation keeps pending imports open and prevents duplicate import", async () => {
  let finish: (value: { imported: number; skipped: number }) => void = () => {};
  let calls = 0;
  const env = await page({
    probeImportableCliSessions: async () => ({ count: 1 }),
    importAllCliSessions: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    await env.render(createElement(NativeCliImportCard));
    await env.click(env.document.querySelector(".native-cli-import-action")!);
    await env.flush();
    const dialog = env.document.querySelector('[role="alertdialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Import",
    )!;
    await env.click(confirm);
    await env.click(confirm);
    assert.equal(calls, 1);
    const escape = new env.window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(escape, { key: "Escape" });
    await act(async () => dialog.dispatchEvent(escape));
    assert.ok(
      env.document.querySelector('[role="alertdialog"]') === dialog,
      "Escape must use the current busy state",
    );
  } finally {
    await act(async () => finish({ imported: 1, skipped: 0 }));
    await env.restore();
  }
});

test("zero and invalid/error discovery cannot fabricate a CLI count", async () => {
  let result: unknown = { count: 0 };
  const env = await page({
    probeImportableCliSessions: async () => {
      if (result instanceof Error) throw result;
      return result as { count: number };
    },
  });
  try {
    await env.render(createElement(NativeCliImportCard));
    assert.equal(env.document.querySelector(".native-cli-import-card"), null);
    for (const bad of [
      { count: -1 },
      { count: 1.5 },
      { count: Infinity },
      undefined,
      new Error("probe failure"),
    ]) {
      result = bad;
      await env.focus();
      assert.equal(env.document.querySelector(".native-cli-import-card"), null);
    }
    assert.equal(env.errors.length, 5);
    result = { count: 4 };
    await env.focus();
    assert.match(
      env.document.querySelector(".native-cli-import-action")?.textContent ??
        "",
      /Import 4 Claude Code CLI sessions/,
    );
  } finally {
    await env.restore();
  }
});

test("CLI import failure stays retryable and does not report a successful import", async () => {
  let calls = 0;
  const env = await page({
    probeImportableCliSessions: async () => ({ count: 2 }),
    importAllCliSessions: async () => {
      if (++calls === 1) throw new Error("synthetic import failure");
      return { imported: 2, skipped: 0 };
    },
  });
  const button = (text: string) =>
    Array.from(
      env.document.querySelectorAll('[role="alertdialog"] button'),
    ).find((item) => item.textContent === text)!;
  try {
    await env.render(createElement(NativeCliImportCard));
    await env.click(env.document.querySelector(".native-cli-import-action")!);
    await env.flush();
    await env.click(button("Import"));
    assert.match(
      env.document.querySelector('[role="alertdialog"]')?.textContent ?? "",
      /Couldn’t import sessions/,
    );
    assert.doesNotMatch(
      env.document.querySelector('[role="alertdialog"]')?.textContent ?? "",
      /Imported 2 sessions/,
    );
    await env.click(button("Try again"));
    await env.click(button("Import"));
    assert.equal(calls, 2);
    assert.match(
      env.document.querySelector('[role="alertdialog"]')?.textContent ?? "",
      /Imported 2 sessions/,
    );
  } finally {
    await env.restore();
  }
});

test("a stale focus probe and a response after unmount cannot replace current eligibility", async () => {
  const pending: ((value: { count: number }) => void)[] = [];
  const env = await page({
    probeImportableCliSessions: () =>
      new Promise((resolve) => pending.push(resolve)),
  });
  try {
    await env.render(createElement(NativeCliImportCard));
    await env.focus();
    assert.equal(pending.length, 2);
    await act(async () => pending[1]({ count: 5 }));
    await act(async () => pending[0]({ count: 1 }));
    assert.match(
      env.document.querySelector(".native-cli-import-action")?.textContent ??
        "",
      /Import 5 Claude Code CLI sessions/,
    );
    await env.focus();
    await env.render(null);
    await act(async () => pending[2]({ count: 9 }));
    assert.equal(env.document.querySelector(".native-cli-import-card"), null);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.restore();
  }
});

test("actual UsageTab preserves Code Overview/Models even without a service plan; web does not mount local statistics", async () => {
  const ranges: string[] = [];
  const env = await page({
    planUsage: async () => null,
    billingCheckout: async () => null,
    codeUsageDashboard: async (range) => {
      ranges.push(range);
      return null;
    },
  });
  const props = {
    settings: defaultSettings,
    engine: { state: "stopped" as const },
    platform: "darwin" as const,
    save() {},
    onError(error: unknown) {
      throw error;
    },
    goTo() {},
  };
  try {
    await env.render(createElement(UsageTab, props));
    await env.flush();
    assert.match(env.document.body.textContent!, /Your account has no plan/);
    assert.equal(
      env.document.querySelector(".usage-grid > div strong")?.textContent,
      "1",
      "real snapshot has one Code session",
    );
    const models = env.document.querySelector(
      '[role="tablist"] [role="tab"]:last-child',
    )!;
    await env.click(models);
    assert.ok(env.document.querySelector(".usage-chart"));
    assert.match(
      env.document.querySelector(".usage-legend")?.textContent ?? "",
      /sonnet-5/,
    );
    await env.click(
      Array.from(
        env.document.querySelectorAll('[role="radiogroup"] button'),
      ).find((button) => button.textContent === "7d")!,
    );
    assert.deepEqual(ranges, ["all", "7d"]);
    await env.render(createElement(UsageTab, props), webHost);
    await env.flush();
    assert.equal(env.document.querySelector(".usage-overview"), null);
    assert.deepEqual(ranges, ["all", "7d"]);
  } finally {
    await env.restore();
  }
});

const servicePlan = (plan: string): PlanUsage => ({
  plan,
  expiresAt: null,
  windows: [],
  updatedAt: Date.now(),
  warnPercent: 80,
  learnMoreUrl: null,
});

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const usageProps = {
  settings: defaultSettings,
  engine: { state: "stopped" as const },
  platform: "darwin" as const,
  save() {},
  onError(_error: unknown) {},
  goTo() {},
};

test("Usage keeps last-known data throughout a refresh and reports only the latest failure", async () => {
  const errors: unknown[] = [];
  const request = pending<PlanUsage | null>();
  let reads = 0;
  const env = await page({
    planUsage: () =>
      ++reads === 1
        ? Promise.resolve(servicePlan("last-known-plan"))
        : request.promise,
    billingCheckout: async () => null,
    usageProducts: async () => null,
    usageOverview: async () => null,
  });
  try {
    await env.render(
      createElement(UsageTab, {
        ...usageProps,
        onError: (error) => errors.push(error),
      }),
      webHost,
    );
    const shown = () =>
      env.document.querySelector(".usage-heading [data-no-translate]")
        ?.textContent;
    assert.equal(shown(), "last-known-plan");
    await env.focus();
    assert.equal(
      shown(),
      "last-known-plan",
      "refresh does not replace valid data with a skeleton",
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh"]',
      )?.disabled,
      true,
    );
    const failure = new Error("latest request failed");
    await act(async () => request.reject(failure));
    assert.equal(shown(), "last-known-plan");
    assert.deepEqual(errors, [failure]);
    assert.equal(env.document.querySelector(".settings-load-error"), null);
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh"]',
      )?.disabled,
      false,
    );
  } finally {
    await env.restore();
  }
});

test("Usage account-key rollover and unmount ignore late values and failures", async () => {
  const requests: ReturnType<typeof pending<PlanUsage | null>>[] = [];
  const errors: unknown[] = [];
  const env = await page({
    planUsage: () => {
      const request = pending<PlanUsage | null>();
      requests.push(request);
      return request.promise;
    },
    billingCheckout: async () => null,
    usageProducts: async () => null,
    usageOverview: async () => null,
  });
  const node = createElement(UsageTab, {
    ...usageProps,
    onError: (error) => errors.push(error),
  });
  try {
    await env.render(node, webHost, "first-account");
    await env.render(node, webHost, "second-account");
    assert.equal(requests.length, 2);
    await act(async () => requests[0].resolve(servicePlan("old-account-plan")));
    assert.equal(
      env.document.querySelector(".usage-heading [data-no-translate]"),
      null,
    );
    await act(async () => requests[1].resolve(servicePlan("new-account-plan")));
    assert.equal(
      env.document.querySelector(".usage-heading [data-no-translate]")
        ?.textContent,
      "new-account-plan",
    );
    await env.focus();
    await env.render(null, webHost, "second-account");
    await act(async () => requests[2].reject(new Error("reply after unmount")));
    assert.deepEqual(errors, []);
    assert.equal(env.document.querySelector(".usage-page"), null);
  } finally {
    requests.forEach((request) => request.resolve(null));
    await env.restore();
  }
});

test("Usage StrictMode effect replay still accepts its current read and rejects the replayed stale read", async () => {
  const requests: ReturnType<typeof pending<PlanUsage | null>>[] = [];
  const env = await page({
    planUsage: () => {
      const request = pending<PlanUsage | null>();
      requests.push(request);
      return request.promise;
    },
    billingCheckout: async () => null,
    usageProducts: async () => null,
    usageOverview: async () => null,
  });
  try {
    await env.render(createElement(UsageTab, usageProps), webHost, "one", true);
    assert.equal(requests.length, 2);
    await act(async () =>
      requests[1].resolve(servicePlan("current-strict-plan")),
    );
    assert.equal(
      env.document.querySelector(".usage-heading [data-no-translate]")
        ?.textContent,
      "current-strict-plan",
    );
    await act(async () =>
      requests[0].resolve(servicePlan("obsolete-strict-plan")),
    );
    assert.equal(
      env.document.querySelector(".usage-heading [data-no-translate]")
        ?.textContent,
      "current-strict-plan",
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh"]',
      )?.disabled,
      false,
    );
  } finally {
    requests.forEach((request) => request.resolve(null));
    await env.restore();
  }
});

test("native home portals truthful blocked suggestions to the centre and keeps the bottom composer clear", async () => {
  for (const reason of ["question", "permission", "error"] as const) {
    const c = {
      id: "blocked",
      title: "Actual title",
      mode: "code",
      archived: false,
      createdAt: 1,
      updatedAt: Date.now(),
      turns:
        reason === "error"
          ? [
              {
                id: "turn",
                status: "failed",
                prompt: "",
                attachments: [],
                items: [],
                createdAt: 1,
              },
            ]
          : [],
    } as unknown as Conversation;
    const approvals =
      reason === "error"
        ? []
        : [
            {
              id: "request",
              conversationId: c.id,
              method:
                reason === "question"
                  ? "item/tool/requestUserInput"
                  : "item/commandExecution/requestApproval",
              params: {},
            },
          ];
    let opened = 0;
    const env = await page({}, {
      listed: [c],
      snapshot: { settings: defaultSettings, approvals },
      openConversation: () => {
        opened++;
      },
    } as unknown as Partial<AppController>);
    try {
      await env.render(
        createElement(CodeHome, {
          name: "",
          conversations: [c],
          composer: createElement(
            "div",
            { className: "real-composer-slot" },
            createElement(NextSteps, { onPrompt() {} }),
          ),
        }),
      );
      await env.flush();
      const card = env.document.querySelector(
        ".native-code-home-suggestions.next-steps",
      )!;
      assert.ok(card);
      assert.equal(
        env.document.querySelector(".real-composer-slot .next-steps"),
        null,
      );
      assert.equal(
        card.querySelector(".next-step-blocked")?.textContent,
        "Blocked",
      );
      assert.equal(
        card.querySelector(".next-step-detail")?.textContent,
        reason === "question"
          ? "Asked a question"
          : reason === "permission"
            ? "Needs permission"
            : "Hit an error",
      );
      assert.equal(card.querySelector(".next-step-row > svg"), null);
      await env.click(card.querySelector(".next-step-row")!);
      assert.equal(opened, 1);
      await env.click(card.querySelector(".next-step-dismiss button")!);
      assert.equal(env.document.querySelector(".next-step"), null);
      assert.ok(
        env.document.querySelector(".native-code-home-suggestions:empty"),
        "the shared list stays, empty and hidden",
      );
    } finally {
      await env.restore();
    }
  }
});

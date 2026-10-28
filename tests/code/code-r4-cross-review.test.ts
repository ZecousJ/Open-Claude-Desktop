import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  createElement,
  StrictMode,
  useEffect,
  type ReactNode,
} from "react";
import { parseHTML } from "linkedom";
import { defaultSettings } from "../../electron/store/store";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import type { Conversation, DesktopAPI } from "../../shared/types";
import type { CodeUsageDashboard } from "../../shared/code-usage-api";
import type { PlanUsage } from "../../shared/usage-api";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { NativeCliImportCard } from "../../src/code-home/NativeCliImportCard";
import CodeUsageSettings from "../../src/code-home/CodeUsageSettings";
import { UsageTab } from "../../src/settings/tabs/Usage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function environment(bridge: Partial<DesktopAPI>) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  document.documentElement.dataset.motion = "reduced";
  window.desktop = bridge as DesktopAPI;
  const globals = {
    window,
    document,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    innerWidth: 1440,
    innerHeight: 900,
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
  const conversations = (name: string) =>
    [
      {
        id: name,
        title: name,
        mode: "code",
        providerId: "test-provider",
        model: name,
        pinned: false,
        archived: false,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        turns: [
          {
            id: `${name}-turn`,
            prompt: "Usage fixture",
            attachments: [],
            status: "completed",
            createdAt: Date.now() - 1000,
            inputTokens: 90,
            outputTokens: 10,
            items: [],
          },
        ],
      },
    ] as Conversation[];
  return {
    document,
    errors,
    async render(
      node: ReactNode,
      host: HostInfo = desktopHost,
      account = "account-a",
      strict = false,
    ) {
      const app = {
        accountId: account,
        snapshot: {
          conversations: conversations(account),
          settings: defaultSettings,
        },
        report: (error: unknown) => errors.push(error),
      } as unknown as AppController;
      const tree = createElement(
        HostContext.Provider,
        { value: host },
        // AuthGate actually keys ProfileStepGate/PolicyProvider by account.
        // Model that lifecycle rather than inventing a retained-account tree.
        createElement(AppContext.Provider, { key: account, value: app }, node),
      );
      await act(async () =>
        root.render(strict ? createElement(StrictMode, null, tree) : tree),
      );
    },
    async focus() {
      await act(async () => window.dispatchEvent(new window.Event("focus")));
    },
    async click(element: Element) {
      await act(async () =>
        element.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
    },
    async settle() {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 25));
      });
    },
    async close() {
      await act(() => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const usageProps = {
  settings: defaultSettings,
  platform: "darwin" as const,
  engine: { state: "stopped" as const },
  save() {},
  goTo() {},
  onError() {},
};

test("review: Usage keeps real local statistics when service-plan loading fails", async () => {
  const env = await environment({
    planUsage: async () => {
      throw new Error("offline");
    },
    billingCheckout: async () => null,
    codeUsageDashboard: async () => {
      throw new Error("offline dashboard");
    },
  });
  try {
    await env.render(createElement(UsageTab, usageProps));
    await env.settle();
    assert.match(env.document.body.textContent!, /Unable to load usage limits/);
    assert.equal(
      env.document.querySelector(".usage-grid > div strong")?.textContent,
      "1",
    );
    assert.equal(
      env.document.querySelector(".usage-grid > div:nth-child(3) strong")
        ?.textContent,
      "100",
    );
    assert.deepEqual(env.errors, []);
  } finally {
    await env.close();
  }
});

test("review: an old-account dashboard cannot overwrite the new account after the real keyed remount", async () => {
  const reads: ReturnType<typeof deferred<CodeUsageDashboard | null>>[] = [];
  const env = await environment({
    codeUsageDashboard: () => {
      const read = deferred<CodeUsageDashboard | null>();
      reads.push(read);
      return read.promise;
    },
  });
  try {
    await env.render(
      createElement(CodeUsageSettings),
      desktopHost,
      "account-a",
    );
    await env.render(
      createElement(CodeUsageSettings),
      desktopHost,
      "account-b",
    );
    assert.equal(reads.length, 2);
    await act(async () =>
      reads[1].resolve({ tokens: 222, models: [], daily: [] }),
    );
    assert.equal(
      env.document.querySelector(".usage-grid > div:nth-child(3) strong")
        ?.textContent,
      "222",
    );
    await act(async () =>
      reads[0].resolve({ tokens: 999, models: [], daily: [] }),
    );
    assert.equal(
      env.document.querySelector(".usage-grid > div:nth-child(3) strong")
        ?.textContent,
      "222",
    );
    await env.render(createElement(CodeUsageSettings), webHost, "account-b");
    assert.equal(env.document.querySelector(".usage-overview"), null);
    assert.equal(
      reads.length,
      2,
      "web never starts a local-statistics dashboard read",
    );
  } finally {
    await env.close();
  }
});

test("review: native to web transition drops late discovery errors and re-enters with fresh eligibility", async () => {
  const reads: ReturnType<typeof deferred<{ count: number }>>[] = [];
  const env = await environment({
    probeImportableCliSessions: () => {
      const read = deferred<{ count: number }>();
      reads.push(read);
      return read.promise;
    },
  });
  try {
    await env.render(createElement(NativeCliImportCard));
    await env.render(createElement(NativeCliImportCard), webHost);
    await env.focus();
    assert.equal(reads.length, 1);
    await act(async () => reads[0].reject(new Error("late native error")));
    assert.equal(env.document.querySelector(".native-cli-import-card"), null);
    assert.deepEqual(env.errors, []);
    await env.render(createElement(NativeCliImportCard));
    await act(async () => reads[1].resolve({ count: 3 }));
    assert.match(
      env.document.querySelector(".native-cli-import-action")!.textContent!,
      /Import 3 Claude Code CLI sessions/,
    );
  } finally {
    await env.close();
  }
});

test("review: cancel while confirmation eligibility is pending ignores its late reply and imports nothing", async () => {
  const confirmation = deferred<{ count: number }>();
  let probes = 0,
    imports = 0;
  const env = await environment({
    probeImportableCliSessions: async () => {
      probes++;
      return probes === 1
        ? { count: 1 }
        : probes === 2
          ? confirmation.promise
          : { count: 0 };
    },
    importAllCliSessions: async () => {
      imports++;
      return { imported: 1, skipped: 0 };
    },
  });
  try {
    await env.render(createElement(NativeCliImportCard));
    await env.click(env.document.querySelector(".native-cli-import-action")!);
    await env.settle();
    const dialog = env.document.querySelector('[role="alertdialog"]')!;
    assert.match(dialog.textContent!, /Looking for sessions/);
    const buttons = Array.from(dialog.querySelectorAll("button"));
    assert.ok(!buttons.some((button) => button.textContent === "Import"));
    await env.click(buttons.find((button) => button.textContent === "Cancel")!);
    await act(async () => confirmation.resolve({ count: 5 }));
    assert.equal(env.document.querySelector('[role="alertdialog"]'), null);
    assert.equal(env.document.querySelector(".native-cli-import-card"), null);
    assert.equal(imports, 0);
    assert.equal(
      probes,
      3,
      "closing the confirmation rereads actual remaining sessions",
    );
  } finally {
    confirmation.resolve({ count: 0 });
    await env.close();
  }
});

test("review: a slower earlier focus refresh cannot overwrite newer service usage", async () => {
  const plan = (name: string, percent = 0): PlanUsage => ({
    plan: name,
    expiresAt: null,
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Current session",
        windowSeconds: 18_000,
        usedUsd: percent,
        limitUsd: 100,
        percent,
        resetsAt: Date.now() + 3_600_000,
        active: true,
        exceeded: false,
        models: null,
      },
    ],
    updatedAt: Date.now(),
    warnPercent: 80,
    learnMoreUrl: null,
  });
  const reads: ReturnType<typeof deferred<PlanUsage | null>>[] = [];
  let calls = 0;
  const env = await environment({
    planUsage: () => {
      if (++calls === 1) return Promise.resolve(plan("initial-plan"));
      const read = deferred<PlanUsage | null>();
      reads.push(read);
      return read.promise;
    },
    billingCheckout: async () => null,
    usageProducts: async () => null,
    usageOverview: async () => null,
  });
  try {
    await env.render(createElement(UsageTab, usageProps), webHost);
    await env.settle();
    await env.focus();
    await env.focus();
    assert.equal(reads.length, 2);
    await act(async () => reads[1].resolve(plan("latest-plan", 40)));
    const shown = () =>
      env.document.querySelector(".usage-heading [data-no-translate]")
        ?.textContent;
    assert.equal(shown(), "latest-plan");
    assert.equal(
      env.document
        .querySelector('[role="progressbar"][aria-label="Current session"]')
        ?.getAttribute("aria-valuenow"),
      "40",
    );
    await act(async () => reads[0].resolve(plan("obsolete-plan", 10)));
    assert.equal(
      env.document
        .querySelector('[role="progressbar"][aria-label="Current session"]')
        ?.getAttribute("aria-valuenow"),
      "40",
      "displayed quota must keep the latest 40%, not roll back to 10%",
    );
    assert.equal(
      shown(),
      "latest-plan",
      "late older data must not replace the latest completed refresh",
    );
  } finally {
    await env.close();
  }
});

test("review: an obsolete refresh settling cannot enable Refresh while the latest read is pending", async () => {
  const reads: ReturnType<typeof deferred<PlanUsage | null>>[] = [];
  let calls = 0;
  const env = await environment({
    planUsage: () => {
      if (++calls === 1)
        return Promise.resolve({
          plan: "current-plan",
          expiresAt: null,
          windows: [],
          updatedAt: Date.now(),
          warnPercent: 80,
          learnMoreUrl: null,
        });
      const read = deferred<PlanUsage | null>();
      reads.push(read);
      return read.promise;
    },
    billingCheckout: async () => null,
    usageProducts: async () => null,
    usageOverview: async () => null,
  });
  try {
    await env.render(createElement(UsageTab, usageProps), webHost);
    await env.settle();
    await env.focus();
    await env.focus();
    const refresh = () =>
      env.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh"]',
      )!;
    assert.equal(refresh().disabled, true);
    await act(async () => reads[0].reject(new Error("obsolete read failed")));
    assert.equal(
      refresh().disabled,
      true,
      "only the latest read can finish the pending UI state",
    );
    await act(async () => reads[1].resolve(null));
    assert.match(env.document.body.textContent!, /Your account has no plan/);
  } finally {
    reads.forEach((read) => read.resolve(null));
    await env.close();
  }
});

test("review: StrictMode reads and a late rejection after unmount cannot replace usage or report stale errors", async () => {
  const reads: ReturnType<typeof deferred<PlanUsage | null>>[] = [];
  const reported: unknown[] = [];
  let setups = 0,
    cleanups = 0;
  function ReplayProbe() {
    useEffect(() => {
      setups++;
      return () => {
        cleanups++;
      };
    }, []);
    return createElement(UsageTab, {
      ...usageProps,
      onError: (error) => reported.push(error),
    });
  }
  const env = await environment({
    planUsage: () => {
      const read = deferred<PlanUsage | null>();
      reads.push(read);
      return read.promise;
    },
    billingCheckout: async () => null,
    usageProducts: async () => null,
    usageOverview: async () => null,
  });
  try {
    await env.render(createElement(ReplayProbe), webHost, "account-a", true);
    assert.equal(
      setups,
      2,
      "the real outer StrictMode replays initial effects",
    );
    assert.equal(cleanups, 1, "the first effect was actually cleaned up");
    assert.ok(reads.length >= 1);
    await act(async () =>
      reads.at(-1)!.resolve({
        plan: "strict-latest",
        expiresAt: null,
        windows: [],
        updatedAt: Date.now(),
        warnPercent: 80,
        learnMoreUrl: null,
      }),
    );
    await act(async () =>
      reads.slice(0, -1).forEach((read) => read.resolve(null)),
    );
    assert.equal(
      env.document.querySelector(".usage-heading [data-no-translate]")
        ?.textContent,
      "strict-latest",
    );
    const beforeFocus = reads.length;
    await env.focus();
    assert.equal(
      reads.length,
      beforeFocus + 1,
      "StrictMode leaves only one active focus listener",
    );
    await env.render(null, webHost);
    await act(async () =>
      reads.at(-1)!.reject(new Error("late unmounted failure")),
    );
    assert.deepEqual(reported, []);
    assert.equal(env.document.querySelector(".usage-page"), null);
  } finally {
    reads.forEach((read) => read.resolve(null));
    await env.close();
  }
});

test("review: a current refresh failure retains known usage and uses the latest error callback", async () => {
  const reported: string[] = [];
  let fail = false;
  const env = await environment({
    planUsage: async () => {
      if (fail) throw new Error("latest refresh failed");
      return {
        plan: "known-plan",
        expiresAt: null,
        windows: [],
        updatedAt: Date.now(),
        warnPercent: 80,
        learnMoreUrl: null,
      };
    },
    billingCheckout: async () => null,
    usageProducts: async () => null,
    usageOverview: async () => null,
  });
  try {
    await env.render(
      createElement(UsageTab, {
        ...usageProps,
        onError: () => reported.push("old-callback"),
      }),
      webHost,
    );
    await env.settle();
    await env.render(
      createElement(UsageTab, {
        ...usageProps,
        onError: () => reported.push("new-callback"),
      }),
      webHost,
    );
    await env.settle();
    fail = true;
    await env.focus();
    assert.equal(
      env.document.querySelector(".usage-heading [data-no-translate]")
        ?.textContent,
      "known-plan",
    );
    assert.doesNotMatch(
      env.document.body.textContent!,
      /Unable to load usage limits/,
    );
    assert.deepEqual(reported, ["new-callback"]);
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh"]',
      )?.disabled,
      false,
    );
  } finally {
    await env.close();
  }
});

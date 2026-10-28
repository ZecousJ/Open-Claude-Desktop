import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Settings } from "../../shared/types";
import type {
  LocalMcpDiscovery,
  McpLogSnapshot,
} from "../../shared/settings-mcp-api";
import { SystemTab } from "../../src/settings/tabs/System";
import { CoworkTab } from "../../src/settings/tabs/Cowork";
import { ServerPanel } from "../../src/settings/tabs/Developer";
import { McpLogsDialog } from "../../src/settings/McpLogsDialog";
import { LocalMcpImportDialog } from "../../src/settings/LocalMcpImportDialog";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost } from "../../shared/host";
import { routineDom } from "../support/routine-dom";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { BrowserLinkPreferences } from "../../src/settings/tabs/BrowserLinkPreferences";

const settings = {
  providers: [],
  mcpServers: {},
  effort: "medium",
} as unknown as Settings;
const engine = { state: "ready" } as const;
const noop = () => {};
const props = {
  settings,
  engine,
  platform: "darwin",
  save: noop,
  onError: noop,
  goTo: noop,
} as unknown as Parameters<typeof CoworkTab>[0];

test("System browser settings describe the built-in host and omit unsupported account-paired Chrome inventory", () => {
  Object.assign(globalThis, { __APP_VERSION__: "test" });
  const html = renderToStaticMarkup(createElement(SystemTab, props));
  assert.match(html, /Controls the built-in browser in local Code sessions/);
  assert.match(html, /Allow all browser actions/);
  assert.match(
    html,
    /aria-label="Open links in built-in browser" aria-checked="true"/,
  );
  assert.match(html, /data-setting="Allowed sites"/);
  assert.doesNotMatch(
    html,
    /data-setting="Browser tools"|data-setting="Keep cookies"/,
  );
  assert.doesNotMatch(
    html,
    /Connected browsers|No browsers connected|Chrome instances signed in|Recheck/,
  );
});

test("retained Cowork reuses functional link preferences and allowed-sites editor", async () => {
  const writes: unknown[] = [];
  const dom = await routineDom(
    {
      systemState: async () => ({ dataFolder: "/fixture" }) as never,
      listCoworkDevices: async () => [],
    },
    { jsdom: true },
  );
  try {
    await dom.render(
      createElement(
        HostContext.Provider,
        { value: desktopHost },
        createElement(CoworkTab, {
          ...props,
          settings,
          save: (patch: unknown) => {
            writes.push(patch);
          },
        }),
      ),
    );
    const link = dom.document.querySelector<HTMLButtonElement>(
      '[aria-label="Open links in built-in browser"]',
    )!;
    assert.equal(link.getAttribute("aria-checked"), "true");
    assert.equal(link.disabled, false);
    await dom.event(link, "click");
    assert.deepEqual(writes[0], { browserOpenLinksInApp: false });
    assert.ok(
      !dom.document.body.textContent!.includes("Only on this computer"),
    );
    const manage = dom.document.querySelector(
      '[data-setting="Allowed sites"] button',
    )!;
    assert.equal(manage.textContent, "Manage");
    await dom.event(manage, "click");
    assert.ok(dom.document.querySelector('[role="dialog"]'));
    assert.match(dom.document.body.textContent!, /No allowed sites yet/);
  } finally {
    await dom.clean();
  }
});

test("MCP View logs is actionable and its reader handles loading, empty, failed and bounded-event states", async () => {
  const html = renderToStaticMarkup(
    createElement(ServerPanel, {
      servers: [{ name: "docs", state: "ready", tools: 1 }],
      configs: {},
      canDelete: false,
      isBlocked: () => false,
      onRemove: async () => {},
      onError: noop,
    }),
  );
  assert.match(html, /class="developer-mcp-logs">View logs/);
  let finish!: (value: McpLogSnapshot) => void;
  let calls = 0;
  const dom = await routineDom(
    {
      readMcpLogs: async (name) => {
        assert.equal(name, "docs");
        calls++;
        if (calls === 1)
          return new Promise((resolve) => {
            finish = resolve;
          });
        if (calls === 2) throw Error("fixture read failed");
        return {
          name,
          kind: "connection-events",
          lines: ["2026-10-19 ready", "2026-10-19 failed: [redacted]"],
          truncated: true,
        };
      },
    },
    { jsdom: true },
  );
  try {
    await dom.render(
      createElement(McpLogsDialog, { name: "docs", onClose: noop }),
    );
    assert.match(dom.document.body.textContent!, /Loading logs/);
    await act(async () =>
      finish({
        name: "docs",
        kind: "connection-events",
        lines: [],
        truncated: false,
      }),
    );
    assert.match(
      dom.document.body.textContent!,
      /No connection events have been captured/,
    );
    const refresh = () =>
      [...dom.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Refresh",
      )!;
    await dom.event(refresh(), "click");
    assert.match(
      dom.document.querySelector('[role="alert"]')!.textContent!,
      /Couldn’t load/,
    );
    await dom.event(refresh(), "click");
    assert.match(
      dom.document.body.textContent!,
      /Showing the most recent events/,
    );
    assert.match(
      dom.document.querySelector("pre")!.textContent!,
      /failed: \[redacted\]/,
    );
    assert.match(
      dom.document.body.textContent!,
      /Server stderr is not available/,
    );
  } finally {
    await dom.clean();
  }
});

const discovered: LocalMcpDiscovery = {
  token: "review-token",
  sources: [{ name: "Claude Desktop", state: "read" }],
  candidates: [
    {
      id: "fresh",
      name: "fresh",
      source: "Claude Desktop",
      state: "available",
      preview: '{"command":"fixture-mcp","env":{"TOKEN":"[redacted]"}}',
    },
    {
      id: "duplicate",
      name: "already",
      source: "Claude Desktop",
      state: "duplicate",
      preview: "",
      reason: "Already set up.",
    },
    {
      id: "managed",
      name: "managed",
      source: "Claude Desktop",
      state: "managed",
      preview: "",
      reason: "This name is managed by Claudex.",
    },
  ],
};

test("local MCP review selects explicitly, disables duplicate/managed entries and writes opaque IDs only", async () => {
  const submitted: unknown[] = [];
  const dom = await routineDom(
    {
      discoverLocalMcp: async () => discovered,
      importLocalMcp: async (input) => {
        submitted.push(input);
        return { imported: ["fresh"], disabled: true };
      },
    },
    { jsdom: true },
  );
  try {
    await dom.render(createElement(LocalMcpImportDialog, { onClose: noop }));
    const checks = [
      ...dom.document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ),
    ];
    assert.equal(checks.length, 3);
    assert.equal(checks[0].checked, false);
    assert.equal(checks[0].disabled, false);
    assert.equal(checks[1].disabled, true);
    assert.equal(checks[2].disabled, true);
    const importButton = () =>
      [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => /^Import \d/.test(button.textContent!),
      )!;
    assert.equal(importButton().disabled, true);
    await act(async () => checks[0].click());
    assert.equal(importButton().disabled, false);
    await dom.event(importButton(), "click");
    assert.deepEqual(submitted, [{ token: "review-token", ids: ["fresh"] }]);
    assert.match(
      dom.document.body.textContent!,
      /Imported 1 server\. They are disabled/,
    );
  } finally {
    await dom.clean();
  }
});

test("local MCP review can retry discovery and preserves a selection after import failure", async () => {
  let checks = 0;
  const dom = await routineDom(
    {
      discoverLocalMcp: async () => {
        if (++checks === 1) throw Error("fixture");
        return discovered;
      },
      importLocalMcp: async () => {
        throw Error("The selected servers changed. Check again.");
      },
    },
    { jsdom: true },
  );
  try {
    await dom.render(createElement(LocalMcpImportDialog, { onClose: noop }));
    assert.match(
      dom.document.querySelector('[role="alert"]')!.textContent!,
      /Couldn’t check/,
    );
    await dom.event(
      [...dom.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Check again",
      )!,
      "click",
    );
    const checkbox = dom.document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => checkbox.click());
    await dom.event(
      [...dom.document.querySelectorAll("button")].find((button) =>
        /^Import 1/.test(button.textContent!),
      )!,
      "click",
    );
    assert.match(
      dom.document.querySelector('[role="alert"]')!.textContent!,
      /selected servers changed/,
    );
    assert.equal(checkbox.checked, true);
  } finally {
    await dom.clean();
  }
});

test("local MCP review enforces the source's five-server selection limit while allowing deselection", async () => {
  const discovery: LocalMcpDiscovery = {
    ...discovered,
    candidates: Array.from({ length: 6 }, (_, index) => ({
      id: `item-${index}`,
      name: `server-${index}`,
      source: "Fixture",
      state: "available",
      preview: "command: fixture",
    })),
  };
  const dom = await routineDom(
    { discoverLocalMcp: async () => discovery },
    { jsdom: true },
  );
  try {
    await dom.render(createElement(LocalMcpImportDialog, { onClose: noop }));
    const checkboxes = [
      ...dom.document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ),
    ];
    for (const checkbox of checkboxes.slice(0, 5))
      await act(async () => checkbox.click());
    assert.equal(checkboxes[5].disabled, true);
    assert.match(
      dom.document.body.textContent!,
      /5 selected\. You can add up to 5 at a time/,
    );
    assert.equal(checkboxes[0].disabled, false);
    await act(async () => checkboxes[0].click());
    assert.equal(checkboxes[5].disabled, false);
  } finally {
    await dom.clean();
  }
});

function controllerOwners() {
  const ref = { current: undefined as AppController | undefined };
  const owner = (accountId: string) =>
    ({
      accountId,
      controllerScope: {},
      currentController: ref,
    }) as unknown as AppController;
  const a = owner("account-a"),
    b = owner("account-b");
  ref.current = a;
  const wrap = (
    value: AppController,
    child: ReturnType<typeof createElement>,
  ) => createElement(AppContext.Provider, { value }, child);
  return { ref, a, b, wrap };
}

test("MCP log account change rejects a late response before repaint and resets the keyed reader", async () => {
  const owners = controllerOwners();
  let finish!: (value: McpLogSnapshot) => void;
  let reads = 0;
  const dom = await routineDom(
    {
      readMcpLogs: async (name) =>
        ++reads === 1
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : {
              name,
              kind: "connection-events",
              lines: ["account-b event"],
              truncated: false,
            },
    },
    { jsdom: true },
  );
  const child = createElement(McpLogsDialog, { name: "docs", onClose: noop });
  try {
    await dom.render(owners.wrap(owners.a, child));
    owners.ref.current = owners.b;
    await act(async () =>
      finish({
        name: "docs",
        kind: "connection-events",
        lines: ["account-a secret event"],
        truncated: false,
      }),
    );
    assert.ok(
      !dom.document.body.textContent!.includes("account-a secret event"),
    );
    await dom.render(owners.wrap(owners.b, child));
    assert.match(
      dom.document.querySelector("pre")!.textContent!,
      /account-b event/,
    );
    assert.equal(reads, 2);
  } finally {
    await dom.clean();
  }
});

test("MCP review ignores old discovery and import outcomes across account changes", async () => {
  const owners = controllerOwners();
  let discover!: (value: LocalMcpDiscovery) => void;
  let imported!: (value: { imported: string[]; disabled: true }) => void;
  let calls = 0;
  const dom = await routineDom(
    {
      discoverLocalMcp: async () =>
        ++calls === 1
          ? new Promise((resolve) => {
              discover = resolve;
            })
          : discovered,
      importLocalMcp: async () =>
        new Promise((resolve) => {
          imported = resolve;
        }),
    },
    { jsdom: true },
  );
  const child = createElement(LocalMcpImportDialog, { onClose: noop });
  try {
    await dom.render(owners.wrap(owners.a, child));
    owners.ref.current = owners.b;
    await act(async () =>
      discover({
        ...discovered,
        candidates: [{ ...discovered.candidates[0], name: "account-a-only" }],
      }),
    );
    assert.ok(!dom.document.body.textContent!.includes("account-a-only"));
    await dom.render(owners.wrap(owners.b, child));
    const checkbox = dom.document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => checkbox.click());
    await dom.event(
      [...dom.document.querySelectorAll("button")].find((button) =>
        /^Import 1/.test(button.textContent!),
      )!,
      "click",
    );
    owners.ref.current = owners.a;
    await act(async () => imported({ imported: ["fresh"], disabled: true }));
    assert.ok(!dom.document.body.textContent!.includes("Imported 1 server"));
    await dom.render(owners.wrap(owners.a, child));
    assert.equal(
      dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .checked,
      false,
    );
  } finally {
    await dom.clean();
  }
});

test("MCP submit cannot use a replaced bridge before a React repaint", async () => {
  let writes = 0;
  const dom = await routineDom(
    {
      discoverLocalMcp: async () => discovered,
      importLocalMcp: async () => {
        writes++;
        return { imported: ["fresh"], disabled: true };
      },
    },
    { jsdom: true },
  );
  try {
    await dom.render(createElement(LocalMcpImportDialog, { onClose: noop }));
    await act(async () =>
      dom.document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    dom.window.desktop = {
      ...dom.window.desktop,
      importLocalMcp: async () => {
        writes++;
        return { imported: ["new-account"], disabled: true };
      },
    };
    await dom.event(
      [...dom.document.querySelectorAll("button")].find((button) =>
        /^Import 1/.test(button.textContent!),
      )!,
      "click",
    );
    assert.equal(writes, 0);
    await dom.render(createElement(LocalMcpImportDialog, { onClose: noop }));
    assert.equal(
      dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .checked,
      false,
    );
  } finally {
    await dom.clean();
  }
});

test("Allowed sites ignores old account actions and closes its manager when the owner changes", async () => {
  const owners = controllerOwners();
  const writes: unknown[] = [];
  const dom = await routineDom({}, { jsdom: true });
  const child = createElement(
    HostContext.Provider,
    { value: desktopHost },
    createElement(BrowserLinkPreferences, {
      settings: {
        ...settings,
        browserAllowedSites: ["https://account-a.example"],
      },
      save: (patch) => {
        writes.push(patch);
      },
    }),
  );
  try {
    await dom.render(owners.wrap(owners.a, child));
    await dom.event(
      dom.document.querySelector('[data-setting="Allowed sites"] button')!,
      "click",
    );
    assert.match(dom.document.body.textContent!, /account-a.example/);
    owners.ref.current = owners.b;
    await dom.event(
      [...dom.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Clear all",
      )!,
      "click",
    );
    assert.equal(writes.length, 0);
    await dom.render(owners.wrap(owners.b, child));
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.ok(!dom.document.body.textContent!.includes("account-a.example"));
  } finally {
    await dom.clean();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toolPaneKinds, isToolPaneKind } from "../../shared/tool-pane";
import {
  embeddedWidget,
  sessionWidgets,
  widgetDomains,
  widgetUri,
} from "../../shared/widget";
import { isDockPanel, openInDock } from "../../src/app/useToolPanels";
import { moveDockPane, reconcileDock } from "../../src/app/dock-layout";
import { dockCardClass, dockPanelOf } from "../../src/app/pane-expand";
import {
  paneHandoffKey,
  savePaneHandoff,
  takePaneHandoff,
} from "../../src/app/pane-handoff";
import { SessionPaneFrame } from "../../src/app/SessionPaneFrame";
import { widgetDocument } from "../../src/widgets/widget-document";
import { registerArtifactToolHandlers } from "../../electron/artifacts/artifact-tools";
import type { AppContext, IpcHandle } from "../../electron/app/app-context";
import type { Item } from "../../shared/types";
import { parseGitHubPullRequest } from "../../shared/github-parse";

const newPanes = [
  "session",
  "pr",
  "widget",
  "plan",
  "agent",
  "artifact",
] as const;

test("all six surfaces share dock movement and window validation", () => {
  for (const pane of newPanes) {
    assert.equal(isDockPanel(pane), true);
    assert.equal(isToolPaneKind(pane), true);
    assert.ok(toolPaneKinds.includes(pane));
    const dock = openInDock(["files", "runs", "browser"], pane);
    const layout = reconcileDock([], dock);
    const moved = moveDockPane(layout, pane, "right");
    assert.deepEqual(moved.at(-1), [pane]);
    assert.deepEqual(
      moved.flat().filter((entry) => entry !== pane),
      ["runs", "files", "browser"],
    );
    assert.deepEqual(moveDockPane(moved, pane, "right"), moved);
    assert.deepEqual(
      reconcileDock(
        moved,
        dock.filter((entry) => entry !== pane),
      ).flat(),
      ["runs", "files", "browser"],
    );
  }
});

test("session, PR and widget headers expose Fill, Tile and Close consistently", () => {
  for (const pane of ["session", "pr", "widget"] as const) {
    const html = renderToStaticMarkup(
      createElement(SessionPaneFrame, {
        pane,
        title: pane,
        onClose() {},
        children: "data",
      }),
    );
    assert.ok(html.includes(`work-panel ${dockCardClass[pane]}`));
    assert.match(html, /<header>/);
    assert.match(html, /aria-label="Fill"/);
    assert.match(html, /aria-label="Close"/);
  }
});

test("Agent is not mistaken for Background tasks when both use the task shell", () => {
  const card = {
    classList: {
      contains: (value: string) =>
        [
          "work-panel",
          "background-tasks-panel",
          "agent-transcript-panel",
        ].includes(value),
    },
  };
  assert.equal(
    dockPanelOf({ closest: () => card } as unknown as Element),
    "agent",
  );
});

test("pane window handoffs preserve selected content once and isolate accounts", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const key = paneHandoffKey("account", "conversation", "widget");
  const target = {
    sessionId: "other-session",
    widgetId: "tool-1",
    artifact: {
      id: "a",
      name: "a.html",
      language: "html",
      content: "<p>actual artifact</p>",
    },
  };
  savePaneHandoff(storage, key, target);
  assert.equal(
    takePaneHandoff(storage, paneHandoffKey("other", "conversation", "widget")),
    undefined,
  );
  assert.deepEqual(takePaneHandoff(storage, key), target);
  assert.equal(takePaneHandoff(storage, key), undefined);
  storage.setItem(
    key,
    JSON.stringify({ at: Date.now() - 61_000, value: target }),
  );
  assert.equal(takePaneHandoff(storage, key), undefined);
});

test("widget resources use MCP app metadata or actual HTML resources, not text results", () => {
  assert.equal(
    widgetUri({ _meta: { ui: { resourceUri: "ui://app/view" } } }),
    "ui://app/view",
  );
  assert.equal(
    widgetUri({ _meta: { "ui/resourceUri": "ui://legacy/view" } }),
    "ui://legacy/view",
  );
  assert.equal(
    widgetUri({ _meta: { ui: { resourceUri: "file:///secret" } } }),
    undefined,
  );
  assert.equal(
    embeddedWidget({ content: [{ type: "text", text: "not a widget" }] }),
    undefined,
  );
  assert.deepEqual(
    embeddedWidget({
      content: [
        {
          type: "resource",
          resource: {
            uri: "ui://app",
            mimeType: "text/html;profile=mcp-app",
            text: "<p>widget</p>",
          },
        },
      ],
    }),
    { uri: "ui://app", html: "<p>widget</p>" },
  );
  const item = {
    id: "tool",
    type: "mcpToolCall",
    server: "search",
    tool: "lookup",
  } as Item;
  assert.deepEqual(
    sessionWidgets([
      { items: [item, { id: "text", type: "agentMessage" } as Item] },
    ]),
    [item],
  );
});

test("widget CSP accepts only server-declared HTTP origins and retains sandbox restrictions", () => {
  const domains = widgetDomains({
    _meta: {
      ui: {
        csp: {
          resourceDomains: [
            "https://cdn.example",
            "javascript:alert(1)",
            "https://x.example/path",
            "https://x.example/; script-src *",
            "https://user:pass@x.example",
          ],
          connectDomains: ["https://api.example"],
        },
      },
    },
  });
  assert.deepEqual(domains, {
    resourceDomains: ["https://cdn.example"],
    connectDomains: ["https://api.example"],
  });
  const html = widgetDocument("<script>window.widget=true</script>", domains);
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script>"));
  assert.ok(html.includes("connect-src https://api.example"));
  assert.ok(html.includes("frame-src 'none'"));
  assert.ok(html.includes("form-action 'none'"));
});

test("desktop and runner widget resources discover their own tool URI and enforce connector policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-widget-"));
  const methods: string[] = [];
  const item = {
    id: "tool",
    type: "mcpToolCall",
    server: "search",
    tool: "lookup",
  };
  const settings = {
    disableNonessentialServices: false,
    mcpServers: {
      search: {
        url: "https://mcp.example",
        enabled: true,
        disabled_tools: [] as string[],
      },
    },
  };
  let blockOnList = false;
  const handlers: Record<string, (...args: unknown[]) => Promise<any>> = {};
  const ctx = {
    store: {
      root,
      settings,
      conversation: (id: string) => {
        if (id !== "session") throw new Error("missing session");
        return { turns: [{ items: [item] }] };
      },
    },
    policy: () => ({}),
    connectors: {
      fetch: (async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        methods.push(body.method);
        if (blockOnList && body.method === "tools/list")
          settings.disableNonessentialServices = true;
        if (!body.id) return new Response(null, { status: 202 });
        const result =
          body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "lookup",
                    _meta: { ui: { resourceUri: "ui://search/view" } },
                  },
                ],
              }
            : body.method === "resources/read"
              ? {
                  contents: [
                    {
                      uri: body.params.uri,
                      mimeType: "text/html;profile=mcp-app",
                      text: "<p>live widget</p>",
                    },
                  ],
                }
              : {};
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }) as typeof fetch,
    },
  } as unknown as AppContext;
  try {
    registerArtifactToolHandlers(
      ((name, handler) => {
        handlers[name] = handler;
      }) as IpcHandle,
      ctx,
    );
    settings.disableNonessentialServices = true;
    await assert.rejects(handlers.widgetResource("session", "tool"));
    assert.equal(methods.length, 0);
    settings.disableNonessentialServices = false;
    const resource = await handlers.widgetResource("session", "tool");
    assert.equal(resource.html, "<p>live widget</p>");
    assert.equal(resource.uri, "ui://search/view");
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "resources/read",
    ]);
    assert.ok(!methods.includes("tools/call"));
    methods.length = 0;
    blockOnList = true;
    await assert.rejects(handlers.widgetResource("session", "tool"));
    assert.ok(!methods.includes("resources/read"));
    blockOnList = false;
    settings.disableNonessentialServices = false;
    await assert.rejects(handlers.widgetResource("missing", "tool"));
    await assert.rejects(handlers.widgetResource("session", "missing"));
    settings.mcpServers.search.disabled_tools = ["lookup"];
    await assert.rejects(handlers.widgetResource("session", "tool"));
    settings.mcpServers.search.disabled_tools = [];
    settings.mcpServers.search.enabled = false;
    await assert.rejects(handlers.widgetResource("session", "tool"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("web PR parsing retains the real description", () => {
  const pr = parseGitHubPullRequest(
    {
      number: 41,
      url: "https://github.com/owner/repo/pull/41",
      title: "Real title",
      body: "## Real description",
      state: "open",
      checks: "none",
      base_ref: "main",
      head_ref: "feature",
    },
    "owner/repo",
  );
  assert.equal(pr?.body, "## Real description");
});

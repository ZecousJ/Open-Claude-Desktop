import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ComputerUseAccessRequest,
  ComputerUseState,
} from "../../shared/computer-use-api";
import type { Item } from "../../shared/types";
import {
  appName,
  grantedNames,
  keyLabel,
  quoted,
  resultScreenshots,
  resultText,
  toolTitle,
  withoutHeader,
} from "../../src/computer-use/labels";
import {
  applyComputerUseEvent,
  resetComputerUseForTests,
} from "../../src/computer-use/useComputerUse";
import {
  AccessCard,
  accessAnswer,
  accessTitle,
} from "../../src/computer-use/AccessCard";
import { activityText } from "../../src/computer-use/ComputerUseDockItems";
import { ComputerUseSection } from "../../src/computer-use/ComputerUseSection";
import { McpToolView } from "../../src/transcript/tools/McpToolView";
import { preloadBrowserToolView } from "../../src/transcript/tools/McpToolView";
import { currentLocale, setLocale } from "../../src/i18n";

before(() => preloadBrowserToolView());

const shot = "5f1c1a52-4a0b-4f7e-9d1e-0b9d7d3c2a11";

const baseState: ComputerUseState = {
  available: true,
  settings: {
    enabled: true,
    mode: "background",
    unhideApps: true,
    deniedApps: [],
  },
  allowFullControl: true,
  adminDeniedApps: [],
  canHideApps: true,
  permissions: {
    platform: "darwin",
    accessibility: "granted",
    screen: "granted",
  },
  activity: null,
  requests: [],
};

const request: ComputerUseAccessRequest = {
  id: "0d6c7a3e-1f2b-4c3d-9e4f-5a6b7c8d9e0f",
  conversationId: "c1",
  kind: "apps",
  reason: "To copy the list into Notes.",
  apps: [
    {
      app: { id: "com.apple.Notes", name: "Notes", platform: "darwin" },
      tier: "full",
    },
    {
      app: { id: "com.apple.Safari", name: "Safari", platform: "darwin" },
      tier: "read",
    },
  ],
  deniedAutomatically: [
    { id: "com.1password.1password", name: "1Password", platform: "darwin" },
  ],
};

test("tool titles read like the original's rows in each phase", () => {
  const args = { app: "com.apple.TextEdit" };
  assert.equal(
    toolTitle("screenshot", args, "running"),
    "Taking a screenshot of TextEdit",
  );
  assert.equal(
    toolTitle("screenshot", args, "done"),
    "Took a screenshot of TextEdit",
  );
  assert.equal(
    toolTitle("click", { app: "Safari" }, "failed"),
    "Couldn't click in Safari",
  );
  assert.equal(
    toolTitle("click", { app: "Notes", click_count: 2 }, "done"),
    "Double-clicked in Notes",
  );
  assert.equal(
    toolTitle("click", { app: "Notes", mouse_button: "right" }, "running"),
    "Right-clicking in Notes",
  );
  assert.equal(
    toolTitle("press_key", { app: "Notes", key: "super+s" }, "done"),
    "Pressed ⌘S in Notes",
  );
  assert.equal(
    toolTitle("press_key", { app: "Notepad", key: "ctrl+s" }, "done", {
      mac: false,
    }),
    "Pressed Ctrl+S in Notepad",
  );
  assert.equal(
    toolTitle("scroll", { app: "Notes", direction: "up" }, "done"),
    "Scrolled up in Notes",
  );
  assert.equal(
    toolTitle("request_access", { apps: ["Notes", "Finder"] }, "running"),
    "Requesting access to 2 apps",
  );
  assert.equal(
    toolTitle("request_access", { apps: ["Notes", "Finder"] }, "done", {
      resultText:
        "Notes: granted (full access).\nFinder: the person didn't allow it.",
    }),
    "Allowed Notes",
  );
  assert.equal(
    toolTitle("request_access", { apps: ["Finder"] }, "done", {
      resultText: "Finder: the person didn't allow it.",
    }),
    "Didn't get access to 1 app",
  );
  assert.equal(
    toolTitle("request_full_control", { reason: "x" }, "done", {
      resultText: "The person didn't allow full control. Continue…",
    }),
    "Full control wasn't allowed",
  );
  assert.equal(
    toolTitle("type_text", { app: "Notes", text: "a".repeat(60) }, "done"),
    `Typed "${"a".repeat(39)}…" in Notes`,
  );
  assert.equal(toolTitle("something_new", {}, "done"), "Used your computer");
});

test("app names prefer the broker's header, then a shortened bundle id", () => {
  assert.equal(
    appName({ app: "com.apple.TextEdit" }, "Text Edit · click · full access"),
    "Text Edit",
  );
  assert.equal(appName({ app: "com.apple.TextEdit" }), "TextEdit");
  assert.equal(appName({ app: "Notepad" }), "Notepad");
  assert.equal(appName({}), undefined);
  assert.equal(quoted("  a\n b "), '"a b"');
  assert.equal(keyLabel("Return", true), "↩");
  assert.equal(keyLabel("shift+tab", false), "Shift+Tab");
  assert.deepEqual(
    grantedNames("A: granted (full access).\nB: already granted (view only)."),
    ["A", "B"],
  );
});

test("screenshots come from references; a bare image becomes a data URL", () => {
  const result = {
    content: [
      { type: "text", text: "TextEdit · screenshot · full access" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "text", text: `claudex-screenshot://${shot}` },
      { type: "image", data: "BBBB", mimeType: "image/png" },
    ],
  };
  assert.deepEqual(resultScreenshots(result), [
    { id: shot },
    { url: "data:image/png;base64,BBBB" },
  ]);
  assert.equal(resultText(result), "TextEdit · screenshot · full access");
  assert.deepEqual(
    resultScreenshots({
      content: [{ type: "image", data: "not base64!", mimeType: "image/png" }],
    }),
    [],
  );
  assert.deepEqual(resultScreenshots(undefined), []);
  assert.equal(withoutHeader("Notes · click · full access"), undefined);
  assert.equal(withoutHeader("Notes · click · full access\nDone."), "Done.");
  assert.equal(withoutHeader("Plain text"), "Plain text");
});

test("events update requests, activity and permissions; changed reloads", () => {
  let state = applyComputerUseEvent(baseState, {
    type: "computer-use",
    request,
  });
  assert.ok(state !== "reload");
  assert.equal(state.requests?.length, 1);
  state = applyComputerUseEvent(state, { type: "computer-use", request });
  assert.ok(state !== "reload");
  assert.equal(state.requests?.length, 1, "the same request isn't doubled");
  const activity = {
    conversationId: "c1",
    mode: "background" as const,
    startedAt: 1,
  };
  state = applyComputerUseEvent(state, { type: "computer-use", activity });
  assert.ok(state !== "reload");
  assert.deepEqual(state.activity, activity);
  state = applyComputerUseEvent(state, {
    type: "computer-use",
    resolved: request.id,
    activity: null,
  });
  assert.ok(state !== "reload");
  assert.equal(state.requests?.length, 0);
  assert.equal(state.activity, null);
  const permissions = {
    platform: "darwin",
    accessibility: "denied" as const,
    screen: "granted" as const,
  };
  state = applyComputerUseEvent(state, {
    type: "computer-use",
    permissions,
  });
  assert.ok(state !== "reload");
  assert.deepEqual(state.permissions, permissions);
  assert.equal(
    applyComputerUseEvent(baseState, { type: "computer-use", changed: true }),
    "reload",
  );
});

test("computer-use tool calls get their own rows with the screenshot", () => {
  const done: Item = {
    id: "t1",
    type: "mcpToolCall",
    server: "computer-use",
    tool: "screenshot",
    status: "completed",
    arguments: { app: "com.apple.TextEdit" },
    result: {
      content: [
        { type: "text", text: "TextEdit · screenshot · full access" },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        { type: "text", text: `claudex-screenshot://${shot}` },
      ],
    },
  };
  const html = renderToStaticMarkup(createElement(McpToolView, { item: done }));
  assert.match(html, /Took a screenshot of TextEdit/);
  assert.match(html, /class="cu-shot"/);
  assert.doesNotMatch(html, /claudex-screenshot:\/\//);
  assert.doesNotMatch(html, /base64,AAAA/, "the saved copy is loaded by id");

  const refused: Item = {
    id: "t2",
    type: "mcpToolCall",
    server: "computer-use",
    tool: "click",
    status: "completed",
    arguments: { app: "com.apple.Safari" },
    result: {
      content: [
        {
          type: "text",
          text: "Safari is granted view-only: clicks and typing are blocked.",
        },
      ],
      isError: true,
    },
  };
  const failed = renderToStaticMarkup(
    createElement(McpToolView, { item: refused }),
  );
  assert.match(failed, /Couldn(’|'|&#x27;)t click in Safari/);
  assert.match(failed, /cu-tool-reason[^>]*>Safari is granted view-only/);

  const other = renderToStaticMarkup(
    createElement(McpToolView, {
      item: { ...done, server: "fixture", tool: "lookup" },
    }),
  );
  assert.match(other, /Used fixture: lookup/);
});

test("the access card lists apps with their proposed level and allows them all", () => {
  assert.equal(accessTitle(request), "Claudex wants to use:");
  assert.equal(
    accessTitle({ ...request, apps: request.apps.slice(0, 1) }),
    "Claudex wants to use Notes",
  );
  assert.equal(
    accessTitle({ ...request, kind: "full-control", apps: [] }),
    "Take over the screen? You’ve set Background as your preferred mode, so Claudex is checking before switching to full-screen control.",
  );
  assert.deepEqual(accessAnswer(request), {
    allow: ["com.apple.Notes", "com.apple.Safari"],
    deny: [],
  });
  const html = renderToStaticMarkup(
    createElement(AccessCard, {
      request,
      frontmost: false,
      mac: true,
      canHideApps: true,
      onError: () => {},
    }),
  );
  assert.match(
    html,
    /Claudex says: <\/span><span data-no-translate="true">To copy the list into Notes\.<\/span>/,
  );
  assert.match(html, /data-tier="full">All</);
  assert.match(html, /data-tier="read">View only</);
  assert.doesNotMatch(html, /type="checkbox"/, "no choosing per app");
  assert.match(html, /Your other windows will be hidden while Claudex works/);
  assert.match(html, /Denied automatically: 1Password/);
  assert.match(html, /Allow for this session/);
  assert.doesNotMatch(html, /Always allow/, "access is for this chat only");
  const terminal = renderToStaticMarkup(
    createElement(AccessCard, {
      request: {
        ...request,
        apps: [
          {
            app: {
              id: "com.apple.Terminal",
              name: "Terminal",
              platform: "darwin",
            },
            tier: "click",
          },
        ],
      },
      frontmost: false,
      mac: true,
      canHideApps: false,
      background: true,
      onError: () => {},
    }),
  );
  assert.match(terminal, /Can run commands on your computer/);
  assert.match(terminal, /in the background while you keep using your Mac/);
  const full = renderToStaticMarkup(
    createElement(AccessCard, {
      request: { ...request, kind: "full-control", deniedAutomatically: [] },
      frontmost: false,
      mac: true,
      canHideApps: false,
      onError: () => {},
    }),
  );
  assert.match(
    full,
    /Take over the screen\? Claudex was working on Notes and Safari in the background/,
  );
  assert.match(full, /Stay in background/);
  assert.match(full, />Allow</);
  const permissions = renderToStaticMarkup(
    createElement(AccessCard, {
      request: { ...request, kind: "permissions", apps: [] },
      frontmost: false,
      mac: true,
      canHideApps: false,
      permissions: {
        platform: "darwin",
        accessibility: "granted",
        screen: "granted",
      },
      onError: () => {},
    }),
  );
  assert.match(permissions, /System permissions needed/);
  assert.match(permissions, /Permissions are ready\. Click Ask again/);
  assert.match(permissions, /Ask again/);
  const clip = renderToStaticMarkup(
    createElement(AccessCard, {
      request: {
        ...request,
        apps: [],
        deniedAutomatically: [],
        clipboard: { read: true, write: false },
      },
      frontmost: false,
      mac: true,
      canHideApps: true,
      unhide: true,
      onError: () => {},
    }),
  );
  assert.match(clip, /Claudex wants to:/);
  assert.match(clip, /Read your clipboard/);
  assert.doesNotMatch(clip, /Write to your clipboard/);
  assert.equal(
    activityText({
      conversationId: "c1",
      mode: "background",
      app: { id: "com.apple.TextEdit", name: "TextEdit", platform: "darwin" },
      startedAt: 1,
    }),
    "Claudex is using your computer",
  );
});

test("Settings shows Computer use only while it is available", () => {
  const render = (platform = "darwin") =>
    renderToStaticMarkup(
      createElement(ComputerUseSection, { platform, onError: () => {} }),
    );
  try {
    resetComputerUseForTests({
      ...baseState,
      available: false,
      reason: "policy",
    });
    assert.equal(render(), "");
    resetComputerUseForTests(baseState);
    assert.equal(render("linux"), "");
    const html = render();
    assert.match(html, /Computer use <span class="cu-badge">Beta<\/span>/);
    assert.match(html, /Enable computer use/);
    assert.match(html, /Unhide apps when Claudex finishes/);
    assert.match(html, /No apps denied/);
    assert.match(html, /Accessibility/);
    assert.match(html, /Screen recording/);
    assert.match(html, /cu-status">Granted/);
    assert.match(html, /Not available in cloud Code sessions/);

    resetComputerUseForTests({
      ...baseState,
      allowFullControl: false,
      canHideApps: false,
      permissions: undefined,
      adminDeniedApps: ["com.apple.Terminal"],
      settings: {
        ...baseState.settings,
        deniedApps: [
          { id: "com.apple.MobileSMS", name: "Messages", platform: "darwin" },
        ],
      },
    });
    const limited = render("win32");
    assert.doesNotMatch(limited, /Unhide apps/);
    assert.match(
      limited,
      /administrator doesn(’|'|&#x27;)t allow full control/,
    );
    assert.match(
      limited,
      /role="radio" aria-checked="false" tabindex="-1" disabled="">Full control/,
    );
    assert.match(limited, /Denied by your administrator/);
    assert.match(limited, /aria-label="Remove Messages"/);
    assert.doesNotMatch(limited, /Accessibility/);
  } finally {
    resetComputerUseForTests();
  }
});

test("tool titles follow the interface language, each phrase ordered by the language", async () => {
  const previous = currentLocale();
  try {
    await setLocale("zh-CN");
    assert.equal(
      toolTitle("screenshot", { app: "Notes" }, "done"),
      "已截取 Notes 的屏幕截图",
    );
    assert.equal(
      toolTitle("click", { app: "Safari" }, "failed"),
      "无法在 Safari 中点击",
    );
    assert.equal(
      toolTitle("scroll", { app: "Notes", direction: "up" }, "running"),
      "正在 Notes 中向上滚动",
    );
    assert.equal(
      toolTitle("request_access", { apps: ["Notes", "Finder"] }, "running"),
      "正在请求访问 2 个应用",
    );
    assert.equal(
      toolTitle("press_key", { key: "super+s" }, "done"),
      "已在 某个应用 中按下 ⌘S",
    );
    await setLocale("ja-JP");
    assert.equal(
      toolTitle("open_application", { app: "Notes" }, "failed"),
      "Notes を開くことができませんでした",
    );
  } finally {
    await setLocale(previous);
  }
});

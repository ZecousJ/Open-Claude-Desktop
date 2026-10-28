/**
 * The web shell (package W-SHELL): sidebar head, navigation, account row,
 * Beta label, update notice, shortcut list and sign-in copy on the web
 * surface. The build constant is set before anything that reads it is
 * imported (node:test runs each file in its own process), so the modules
 * below see `surface === "web"`; desktop behaviour stays covered by the
 * existing tests, which run with the desktop default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthStatus, RemoteSignInPolicy } from "../../shared/types";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
// Components import their stylesheets; Node has nothing to do with them.
registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context),
});

const { surface, desktopHost, webHost } = await import("../../shared/host");
const { HostContext } = await import("../../src/host/HostContext");
const { sidebarNav } = await import("../../src/sidebar/navItems");
const { MainNav } = await import("../../src/sidebar/MainNav");
const { WindowNav } = await import("../../src/sidebar/WindowNav");
const { WebSidebarHeader } = await import("../../src/sidebar/WebSidebarHeader");
const { AccountMenu } = await import("../../src/sidebar/AccountMenu");
const { WebBetaBadge } = await import("../../src/web/WebBetaBadge");
const { UpdateNotice, useUpdateNotice } =
  await import("../../src/policy/UpdateNotice");
const { webShortcutSections } =
  await import("../../src/dialogs/KeyboardShortcutsDialog");
const { initialStep, blockedPage, signedOutNotice } =
  await import("../../src/auth/signInView");

const noop = () => {};

test("the build constant makes this file's modules the web surface", () => {
  assert.equal(surface, "web");
});

test("the web keeps Scheduled (under More); its page says why it is off", async () => {
  assert.deepEqual(
    sidebarNav("chat", []).inMore.map((item) => item.id),
    ["scheduled", "customize"],
  );
  const { webRoutinesMessage } =
    await import("../../src/collections/routines/RoutinesPage");
  assert.match(webRoutinesMessage, /Cowork or Code/);
});

test("web navigation: browser-safe New hint, no window icon, no Routines", () => {
  const nav = (hiddenItems?: string[]) =>
    renderToStaticMarkup(
      createElement(MainNav, {
        mode: "chat",
        page: "chat",
        hiddenItems,
        onNewChat: noop,
        onPageChange: noop,
        onEditSidebar: noop,
      }),
    );
  const html = nav();
  assert.doesNotMatch(html, /main-nav-new-window/);
  assert.doesNotMatch(html, /⌘ N/);
  assert.match(html, /<kbd>(⇧ ⌘ O|Ctrl+Shift+O)<\/kbd>/);
  assert.match(html, />Projects</);
  // Scheduled and Customize sit under More.
  assert.match(html, />Artifacts</);
  assert.doesNotMatch(html, />Scheduled</);
  assert.doesNotMatch(html, />Customize</);
  assert.match(html, /href="\/projects"/);
  // API and Service status sit on the sidebar.
  assert.match(html, /href="\/api"[^]*>API</);
  assert.match(html, />Service status</);
  // Even with nothing hidden they stay in More.
  const edited = nav([]);
  assert.doesNotMatch(edited, />Scheduled</);
  assert.doesNotMatch(edited, />Customize</);
});

test("the collapsed controls keep only the sidebar toggle on the web", () => {
  const html = renderToStaticMarkup(
    createElement(WindowNav, {
      toggleLabel: "Show sidebar",
      onToggleSidebar: noop,
      onBack: noop,
      onForward: noop,
    }),
  );
  assert.match(html, /aria-label="Show sidebar"/);
  assert.doesNotMatch(html, /aria-label="Back"/);
  assert.doesNotMatch(html, /aria-label="Forward"/);
});

test("sidebar head: toggle, serif product name and the switch when Code runs", () => {
  const head = (mode: "chat" | "code", host = webHost) =>
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: host },
        createElement(WebSidebarHeader, {
          mode,
          conversations: [],
          onToggleSidebar: noop,
          onSwitch: noop,
        }),
      ),
    );
  const chat = head("chat");
  assert.match(chat, /class="sidebar-chrome web-sidebar-head"/);
  assert.match(chat, /aria-label="Hide sidebar"/);
  assert.match(chat, /<a class="web-sidebar-title" href="\/new">Claudex<\/a>/);
  assert.doesNotMatch(chat, /aria-label="Back"/);
  // No cloud Code yet: the switch still opens the Code page.
  assert.match(chat, /surface-switch/);
  assert.doesNotMatch(chat, /aria-label="Code"[^>]*aria-disabled="true"/);
  const cloud = {
    kind: "web" as const,
    capabilities: { ...webHost.capabilities, cloudCode: true },
  };
  const code = head("code", cloud);
  assert.match(
    code,
    /<a class="web-sidebar-title" href="\/code">Claudex Code<\/a>/,
  );
  assert.match(code, /class="surface-switch"/);
  assert.match(code, /aria-label="Code" aria-checked="true"/);
  // The desktop host (local Code) would show it too.
  assert.match(head("chat", desktopHost), /surface-switch/);
});

test("account row: search button, no update glyph, no Settings shortcut", () => {
  const html = renderToStaticMarkup(
    createElement(AccountMenu, {
      name: "Ada",
      plan: "Max",
      mode: "chat",
      onSearch: noop,
      onSettings: noop,
      onUsage: noop,
      onChangelog: noop,
      onError: noop,
    }),
  );
  assert.match(html, /aria-label="Search"/);
  assert.match(html, /class="[^"]*account-search/);
  assert.doesNotMatch(html, /account-update/);
  assert.doesNotMatch(html, /update-notice/);
  // No download page configured: no Get apps glyph (Q22).
  assert.doesNotMatch(html, /account-apps/);
  assert.match(html, /<small> · Max<\/small>/);
});

test("the update notice never shows on the web", () => {
  const update = {
    state: "required" as const,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    enforced: true,
  };
  assert.equal(
    renderToStaticMarkup(
      createElement(UpdateNotice, { update, onDismiss: noop }),
    ),
    "",
  );
  let shown: boolean | undefined;
  function Probe() {
    shown = useUpdateNotice(update).shown;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(shown, false);
});

test("Beta is a label, not a control", () => {
  assert.equal(
    renderToStaticMarkup(createElement(WebBetaBadge)),
    '<span class="web-beta-badge" role="note">Beta</span>',
  );
});

test("web shortcut list follows the web key table", () => {
  const general = (platform: string) =>
    Object.fromEntries(
      webShortcutSections(platform)[0].shortcuts.map((s) => [
        s.action,
        s.keys[0].join("+"),
      ]),
    );
  assert.deepEqual(general("darwin"), {
    "Quick chat or search": "mod+K",
    Search: "shift+mod+K",
    "Incognito chat": "shift+mod+I",
    "Toggle sidebar": "mod+B",
    "New chat": "shift+mod+O",
    "Keyboard shortcuts": "mod+/",
    Settings: "shift+mod+,",
  });
  // Ctrl+Shift+I is the developer tools outside macOS.
  assert.deepEqual(general("win32"), {
    "Quick chat or search": "mod+K",
    Search: "mod+shift+K",
    "Toggle sidebar": "mod+B",
    "New chat": "mod+shift+O",
    "Keyboard shortcuts": "mod+/",
    Settings: "mod+shift+,",
  });
  const titles = webShortcutSections("linux").map((s) => s.title);
  assert.deepEqual(titles, ["General", "In chats"]);
});

const remote: RemoteSignInPolicy = {
  siteName: "Claudex",
  registrationEnabled: true,
  emailVerification: false,
  invitationCode: false,
  promoCode: false,
  captchaRequired: false,
  emailDomains: [],
};

test("web sign-in: /register starts creating only when the service allows it", () => {
  const status: AuthStatus = { hasAccounts: true, remote };
  assert.equal(initialStep(status, "create"), "create");
  assert.equal(initialStep(status), "email");
  assert.equal(
    initialStep(
      { hasAccounts: true, remote: { ...remote, registrationEnabled: false } },
      "create",
    ),
    "email",
  );
  assert.equal(
    initialStep({ ...status, twoFactorPending: true }, "create"),
    "twoFactor",
  );
  // Local accounts (desktop) keep their rule.
  assert.equal(initialStep({ hasAccounts: false }), "create");
});

test("web sign-in copy names the browser, not the desktop", () => {
  const status: AuthStatus = {
    hasAccounts: true,
    remote: { ...remote, captchaRequired: true },
  };
  assert.match(blockedPage(status)?.subtitle ?? "", /on the web/);
  assert.match(blockedPage(status, "desktop")?.detail ?? "", /desktop sign-in/);
  assert.equal(
    signedOutNotice({ reason: "revoked" }).title,
    "Your session ended. Log in again to continue.",
  );
});

test("the web sign-in page offers this computer's installer only when published (LOGIN)", async () => {
  const { desktopPlatform, downloadUrlOf, findDesktopDownload } =
    await import("../../src/auth/desktopDownload");
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605";
  assert.equal(desktopPlatform({ userAgent: mac }), "darwin");
  // iPadOS says it is a Mac; the touch screen gives it away.
  assert.equal(
    desktopPlatform({ userAgent: mac, maxTouchPoints: 5 }),
    undefined,
  );
  assert.equal(
    desktopPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64)" }),
    "win32",
  );
  assert.equal(
    desktopPlatform({ userAgent: "Mozilla/5.0 (iPhone)" }),
    undefined,
  );
  assert.equal(
    downloadUrlOf({ code: 0, data: { download_url: "https://x.test/C.dmg" } }),
    "https://x.test/C.dmg",
  );
  assert.equal(
    downloadUrlOf({ code: 0, data: { download_url: "http://x.test/C.dmg" } }),
    undefined,
  );
  assert.equal(
    downloadUrlOf({ code: 0, data: { download_url: null } }),
    undefined,
  );
  const asked: string[] = [];
  const url = await findDesktopDownload({ userAgent: mac }, (async (
    input: string,
  ) => {
    asked.push(input);
    return new Response(
      JSON.stringify({
        code: 0,
        data: { download_url: "https://x.test/C.dmg" },
      }),
    );
  }) as unknown as typeof fetch);
  assert.equal(url, "https://x.test/C.dmg");
  assert.deepEqual(asked, ["/api/v1/claudex/release?platform=darwin"]);
});

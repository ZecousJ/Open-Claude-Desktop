import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  lockedPolicy,
  openPolicy,
  pendingPolicy,
  type Announcement,
  type ClientPolicy,
  type ClientUpdate,
} from "../../shared/client-policy";
import {
  downloadPage,
  hostMatches,
  httpsPage,
  linkOpens,
  remoteImageAllowed,
  remoteImageRefusal,
} from "../../shared/external-links";
import {
  serviceReleaseNotes,
  updateBlocksSending,
  updateCheckResult,
} from "../../shared/client-release";
import type { AppEvent, WeeklyUsageStatus } from "../../shared/types";
import { fetchRemoteImage } from "../../electron/workspace/remote-image";
import { appMenuTemplate } from "../../electron/app/app-menu-template";
import { followPolicy } from "../../src/policy/PolicyContext";
import {
  announcementNotice,
  updateNotice,
  usageNotice,
  usageNoticeKind,
} from "../../src/policy/notice-content";
import { NoticeView } from "../../src/policy/NoticeView";
import {
  ServiceMarkdown,
  withLocalReads,
} from "../../src/policy/Announcements";
import { signedOutNotice } from "../../src/auth/signInView";

const lockedLinks: ClientPolicy = {
  ...lockedPolicy,
  trustedLinkDomains: ["docs.example.com", "*.example.org"],
  links: { help: "https://Help.Example.com", learnMore: [] },
  update: {
    state: "available",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    downloadUrl: "https://download.example.com/claudex",
  },
};

test("trusted domains match one host exactly or, with *., the hosts below it", () => {
  assert.ok(hostMatches("docs.example.com", ["docs.example.com"]));
  assert.ok(hostMatches("DOCS.example.com.", ["Docs.Example.com"]));
  assert.ok(!hostMatches("evil-docs.example.com", ["docs.example.com"]));
  assert.ok(hostMatches("a.example.org", ["*.example.org"]));
  assert.ok(hostMatches("a.b.example.org", ["*.example.org"]));
  assert.ok(!hostMatches("example.org", ["*.example.org"]));
  assert.ok(!hostMatches("notexample.org", ["*.example.org"]));
  // Internationalized names compare as the browser spells them.
  assert.ok(hostMatches("xn--bcher-kva.example", ["bücher.example"]));
  // Entries with a port, path or credentials never match.
  assert.ok(!hostMatches("example.com", ["example.com:443"]));
  assert.ok(!hostMatches("example.com", ["example.com/path"]));
  assert.ok(!hostMatches("example.com", [""]));
});

test("with external links off only the administrator's pages and trusted hosts open", () => {
  assert.ok(linkOpens("https://anything.example.net/a", openPolicy));
  assert.ok(!linkOpens("javascript:alert(1)", openPolicy));
  // Compared as addresses: host case and the trailing slash do not matter.
  assert.ok(linkOpens("https://help.example.com/", lockedLinks));
  assert.ok(linkOpens("https://download.example.com/claudex", lockedLinks));
  assert.ok(linkOpens("https://docs.example.com/guide?x=1", lockedLinks));
  assert.ok(linkOpens("http://a.example.org/", lockedLinks));
  assert.ok(!linkOpens("https://example.org/", lockedLinks));
  assert.ok(!linkOpens("https://help.example.com/other", lockedLinks));
  assert.ok(!linkOpens("https://evil.example.net/", lockedLinks));
});

test("remote images load only when allowed and, with a list, from its hosts", () => {
  const limited = { remoteImages: true, remoteImageDomains: ["*.cdn.test"] };
  assert.ok(remoteImageAllowed("https://any.example/a.png", openPolicy));
  assert.ok(!remoteImageAllowed("https://any.example/a.png", lockedPolicy));
  assert.ok(remoteImageAllowed("https://img.cdn.test/a.png", limited));
  assert.ok(!remoteImageAllowed("https://cdn.test/a.png", limited));
  assert.ok(!remoteImageAllowed("file:///etc/passwd", openPolicy));
  assert.equal(
    remoteImageRefusal("https://a.test/x.png", lockedPolicy),
    "Remote images are turned off by your administrator.",
  );
  assert.equal(
    remoteImageRefusal("https://a.test/x.png", limited),
    "Your administrator doesn't allow images from this site.",
  );
  assert.equal(
    remoteImageRefusal("https://img.cdn.test/x.png", limited),
    undefined,
  );
});

test("an allowed image host cannot redirect to a host off the list", async () => {
  const hops: string[] = [];
  const redirecting: typeof fetch = async (input) => {
    hops.push(String(input));
    return String(input).includes("img.cdn.test")
      ? new Response(null, {
          status: 302,
          headers: { location: "https://tracker.example/pixel.png" },
        })
      : new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/png" },
        });
  };
  const limited = { remoteImages: true, remoteImageDomains: ["*.cdn.test"] };
  await assert.rejects(
    fetchRemoteImage(
      "https://img.cdn.test/a.png",
      redirecting,
      async () => ["93.184.215.14"],
      (url) => remoteImageAllowed(url, limited),
    ),
    /doesn't allow images from this site/,
  );
  assert.deepEqual(hops, ["https://img.cdn.test/a.png"]);
});

test("the update's download page opens only as a plain https address", () => {
  const update = (downloadUrl?: string): ClientUpdate => ({
    state: "available",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    downloadUrl,
  });
  assert.equal(
    downloadPage(update("https://download.example.com/a")),
    "https://download.example.com/a",
  );
  assert.equal(
    downloadPage(update("http://download.example.com/a")),
    undefined,
  );
  assert.equal(
    downloadPage(update("https://u:p@download.example.com/")),
    undefined,
  );
  assert.equal(downloadPage(update("javascript:alert(1)")), undefined);
  assert.equal(downloadPage(update(undefined)), undefined);
  assert.equal(downloadPage(undefined), undefined);
  // The application menu's Claudex Help uses the same check.
  assert.equal(
    httpsPage("https://Help.Example.com/claudex"),
    "https://help.example.com/claudex",
  );
  assert.equal(httpsPage("file:///etc/passwd"), undefined);
  assert.equal(httpsPage("smb://share.example.com/help"), undefined);
});

test("a required update stops sending only when the service enforces it", () => {
  const required: ClientUpdate = {
    state: "required",
    currentVersion: "1.0.0",
    latestVersion: "1.2.0",
  };
  assert.equal(updateBlocksSending(required), true);
  assert.equal(updateBlocksSending({ ...required, enforced: true }), true);
  assert.equal(updateBlocksSending({ ...required, enforced: false }), false);
  assert.equal(updateBlocksSending({ ...required, state: "available" }), false);
  assert.equal(updateBlocksSending(undefined), false);
  assert.deepEqual(updateCheckResult(undefined, "1.0.0"), {
    title: "No Update Available",
    detail: "You are running the latest version.",
  });
  assert.equal(
    updateCheckResult({ ...required, state: "available" }, "1.0.0").title,
    "Update Available",
  );
  assert.equal(updateCheckResult(required, "1.0.0").title, "Update required");
  assert.equal(
    updateCheckResult({ ...required, enforced: false }, "1.0.0").title,
    "Update to Claudex 1.2.0",
  );
});

test("the policy follows the main process's answer, its events and window focus", async () => {
  const listeners: ((event: AppEvent) => void)[] = [];
  let asked = 0;
  const bridge = {
    clientPolicy: async () => {
      asked++;
      return lockedPolicy;
    },
    onEvent: (callback: (event: AppEvent) => void) => {
      listeners.push(callback);
      return () => listeners.splice(listeners.indexOf(callback), 1);
    },
  };
  const focus = new EventTarget();
  let clock = 0;
  let current: ClientPolicy = pendingPolicy;
  const stop = followPolicy(
    bridge,
    (update) => (current = update(current)),
    focus as never,
    () => clock,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current, lockedPolicy);
  const next = { ...openPolicy, revision: 7 };
  listeners[0]({ type: "policy", policy: next, revision: 7 });
  assert.equal(current, next);
  // Focus asks again at most every 30 s.
  focus.dispatchEvent(new Event("focus"));
  assert.equal(asked, 1);
  clock = 30_000;
  focus.dispatchEvent(new Event("focus"));
  assert.equal(asked, 2);
  stop();
  assert.equal(listeners.length, 0);
  // After stopping, late answers and events change nothing.
  await new Promise((resolve) => setImmediate(resolve));
  const before = current;
  focus.dispatchEvent(new Event("focus"));
  assert.equal(current, before);
  // An older bridge without the call leaves everything allowed.
  let fallback: ClientPolicy = pendingPolicy;
  const stopFallback = followPolicy(
    {},
    (update) => (fallback = update(fallback)),
    new EventTarget() as never,
  );
  await new Promise((resolve) => setImmediate(resolve));
  stopFallback();
  assert.equal(fallback, openPolicy);
});

const status: WeeklyUsageStatus = {
  used: 75,
  limit: 100,
  percent: 75,
  warnPercent: 70,
  resetsAt: Date.UTC(2026, 8, 28, 9),
  moreUsageUrl: "https://usage.example.com",
  state: "warning",
  dismissed: false,
};

test("usage notices split usage windows from the account's own state", () => {
  assert.equal(usageNoticeKind(status), "usage");
  assert.equal(usageNoticeKind({ ...status, state: "ok" }), null);
  assert.equal(usageNoticeKind({ ...status, dismissed: true }), null);
  assert.equal(
    usageNoticeKind({ ...status, state: "exceeded", reason: "weekly" }),
    "usage",
  );
  for (const reason of ["balance", "subscription", "key-quota"] as const)
    assert.equal(
      usageNoticeKind({ ...status, state: "exceeded", reason }),
      "service",
    );
  const chat = usageNotice(status, "usage", "chat")!;
  assert.equal(chat.title, "You’ve used 75% of your weekly limit");
  assert.equal(chat.icon, "info");
  assert.deepEqual(chat.action, {
    kind: "more-usage",
    label: "Get more usage",
  });
  const code = usageNotice(status, "usage", "code")!;
  assert.equal(code.title, "Approaching weekly usage limit");
  assert.equal(code.icon, "gauge");
  assert.match(code.detail!, /^Resets /);
  assert.equal(usageNotice(status, "service", "code"), null);
  assert.equal(
    usageNotice({ ...status, moreUsageUrl: null }, "usage", "chat")!.action,
    undefined,
  );
});

test("announcement and update notices say what they are and who can close them", () => {
  const notices: Announcement[] = [
    {
      id: "1",
      title: "Quiet",
      content: "",
      popup: false,
      createdAt: 1,
      read: false,
    },
    {
      id: "2",
      title: "Maintenance",
      content: "",
      popup: true,
      createdAt: 2,
      read: false,
    },
  ];
  assert.equal(announcementNotice(notices)!.title, "Maintenance");
  assert.equal(announcementNotice(notices.slice(0, 1)), null);
  const required: ClientUpdate = {
    state: "required",
    currentVersion: "1.0.0",
    latestVersion: "1.2.0",
    downloadUrl: "https://download.example.com/",
  };
  const enforced = updateNotice(required, "")!;
  assert.equal(enforced.title, "Update required");
  assert.equal(enforced.dismissible, false);
  assert.equal(enforced.role, "alert");
  assert.equal(enforced.action?.label, "Download");
  const soft = updateNotice({ ...required, enforced: false }, "")!;
  assert.equal(soft.dismissible, true);
  assert.equal(updateNotice({ ...required, enforced: false }, "1.2.0"), null);
  // An enforced update cannot be put away.
  assert.ok(updateNotice(required, "1.2.0"));
  assert.equal(updateNotice({ ...required, state: "available" }, ""), null);
  assert.equal(
    updateNotice({ ...required, downloadUrl: "http://x.example/" }, "")!.action,
    undefined,
  );
});

test("each surface and place has its notice frame", () => {
  const render = (
    surface: "chat" | "code",
    variant: "home" | "conversation" | "narrow",
  ) =>
    renderToStaticMarkup(
      createElement(NoticeView, {
        content: usageNotice(status, "usage", surface)!,
        surface,
        variant,
      }),
    );
  const home = render("chat", "home");
  assert.match(home, /class="usage-banner chat home warning"/);
  assert.match(home, /class="[^"]*app-icon usage-banner-icon"/);
  assert.match(home, /Get more usage/);
  assert.match(home, /aria-label="Dismiss"/);
  // Narrowed by a side panel, Chat drops the icon.
  const narrow = render("chat", "narrow");
  assert.match(narrow, /usage-banner chat narrow warning/);
  assert.doesNotMatch(narrow, /usage-banner-icon/);
  // Code keeps the gauge and puts the reset time in the text column.
  const code = render("code", "conversation");
  assert.match(code, /usage-banner code conversation warning/);
  assert.match(code, /usage-banner-icon/);
  assert.match(code, /usage-banner-detail">Resets /);
});

test("release notes from the service show no raw HTML and load no images", () => {
  const html = renderToStaticMarkup(
    createElement(ServiceMarkdown, {
      text: '## Fixed\n- Item [status](https://status.example.com)\n\n<img src="https://x.example/a.png"><b>raw</b>\n\n![Shot](https://images.example.com/a.png)',
      className: "release-notes-service",
      images: "never",
    }),
  );
  assert.match(html, /<h2>Fixed<\/h2>/);
  assert.match(html, /href="https:\/\/status\.example\.com\/"/);
  // Raw HTML tags are dropped; only their text remains.
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /Shot/);
  assert.match(html, /images\.example\.com/);
  assert.doesNotMatch(html, /Load image/);
  // Only well-formed notes are taken from the policy.
  const notes = { version: "1.4.0", markdown: "- New", publishedAt: 5 };
  assert.deepEqual(
    serviceReleaseNotes({ ...openPolicy, releaseNotes: notes } as never),
    notes,
  );
  assert.equal(serviceReleaseNotes(openPolicy), undefined);
  assert.equal(
    serviceReleaseNotes({
      ...openPolicy,
      releaseNotes: { version: "<b>", markdown: "x" },
    } as never),
    undefined,
  );
  assert.equal(
    serviceReleaseNotes({
      ...openPolicy,
      releaseNotes: { version: "1.4.0", markdown: " " },
    } as never),
    undefined,
  );
});

test("a notice marked read stays read until the service confirms it", () => {
  const items: Announcement[] = [
    {
      id: "1",
      title: "A",
      content: "",
      popup: true,
      createdAt: 1,
      read: false,
    },
    {
      id: "2",
      title: "B",
      content: "",
      popup: true,
      createdAt: 2,
      read: false,
    },
  ];
  // The answer to the first request still lists the second as unread.
  const merged = withLocalReads(items, new Set(["2"]));
  assert.deepEqual(
    merged.map((item) => item.read),
    [false, true],
  );
  // Nothing pending: the service's list as it is.
  assert.deepEqual(withLocalReads(items, new Set()), items);
  assert.deepEqual(withLocalReads([{ ...items[0], read: true }], new Set()), [
    { ...items[0], read: true },
  ]);
});

test("the sign-in page says the session ended, as the original does", () => {
  // One line whatever ended it.
  assert.deepEqual(signedOutNotice({ reason: "revoked", message: "" }), {
    title: "Your session ended. Log in again to continue.",
    reason: "revoked",
  });
  assert.equal(
    signedOutNotice({
      reason: "device-revoked",
      message: "This device was removed by your administrator.",
    }).title,
    "Your session ended. Log in again to continue.",
  );
});

test("the application menu checks for updates and always offers Help", () => {
  const labels = (items: unknown): string[] =>
    (items as { label?: string; role?: string; submenu?: unknown }[]).flatMap(
      (item) => [
        item.label ?? item.role ?? "separator",
        ...(Array.isArray(item.submenu) ? labels(item.submenu) : []),
      ],
    );
  const options = {
    appName: "Claudex",
    run: () => {},
    checkForUpdates: () => {},
    showMainWindow: () => {},
    updateItem: { label: "Check for Updates…", enabled: true },
  };
  const mac = labels(appMenuTemplate({ ...options, mac: true }));
  assert.ok(mac.includes("Check for Updates…"));
  assert.ok(mac.indexOf("Settings…") < mac.indexOf("Check for Updates…"));
  // Help is always listed and never greyed (2.37337.1).
  const help = (
    appMenuTemplate({ ...options, mac: true }) as unknown as {
      role?: string;
      submenu: { label?: string; enabled?: boolean }[];
    }[]
  )
    .find((item) => item.role === "help")
    ?.submenu.find((item) => item.label === "Claudex Help");
  assert.notEqual(help?.enabled, false);
  const windows = labels(
    appMenuTemplate({ ...options, mac: false, openHelp: () => {} }),
  );
  assert.ok(windows.includes("Check for Updates…"));
  assert.ok(windows.includes("Claudex Help"));
});

test("the window has no editor for service addresses or keys", () => {
  const root = fileURLToPath(new URL("../../src", import.meta.url));
  const files: string[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(entry.name)) files.push(file);
    }
  };
  walk(root);
  const forbidden =
    /\b(baseUrl|apiKey|accessToken|refreshToken|serviceUrl|downloadUrl)\b/;
  const offenders = files.filter((file) =>
    forbidden.test(fs.readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    offenders.map((file) => path.relative(root, file)),
    [],
  );
});

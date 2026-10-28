import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../src/i18n";
import { sourceLocale } from "../../shared/locales";
import { catalogTranslator } from "../../electron/app/native-i18n";
import { updateCheckResult } from "../../shared/client-release";
import zh from "../../shared/i18n/catalogs/zh-CN";
import { UpdateNotice } from "../../src/policy/UpdateNotice";
import { NoticeView } from "../../src/policy/NoticeView";
import { updateNotice } from "../../src/policy/notice-content";

const noop = () => {};
const available = {
  state: "available" as const,
  currentVersion: "0.0.32",
  latestVersion: "0.0.33",
  downloadUrl: "https://example.com/get",
};

test("an available update with a download page is the one-line strip: no body, no close", () => {
  const html = renderToStaticMarkup(
    createElement(UpdateNotice, { update: available, onDismiss: noop }),
  );
  assert.match(html, /^<button[^>]*class="relaunch-update"/);
  assert.match(html, /<span>Update available<\/span>/);
  assert.doesNotMatch(html, /update-notice|Dismiss|Download/);
});

test("a required update, or one without a page, keeps its card, in the app's language", async () => {
  // Enforced (the default) stops sending; enforced: false only asks.
  const required = { ...available, state: "required" as const };
  const card = (update: typeof required | typeof available) =>
    renderToStaticMarkup(
      createElement(UpdateNotice, { update, onDismiss: noop }),
    );
  assert.match(
    card({ ...required, enforced: false } as never),
    /Your administrator no longer supports this version\. Install Claudex 0\.0\.33\./,
  );
  assert.match(
    card({ ...available, downloadUrl: undefined } as never),
    /Claudex 0\.0\.33 is available\. Ask your administrator for the installer\./,
  );
  try {
    await setLocale("zh-CN");
    const html = card(required);
    assert.match(
      html,
      /此版本已不再受支持。请安装 Claudex 0\.0\.33 以继续使用。/,
    );
    assert.match(html, /需要更新/);
    assert.match(html, />下载</);
  } finally {
    await setLocale(sourceLocale);
  }
});

test("the notice above the composer translates its title and detail, with the version", async () => {
  const soft = updateNotice(
    { ...available, state: "required", enforced: false },
    "",
  )!;
  const view = () =>
    renderToStaticMarkup(
      createElement(NoticeView, {
        content: soft,
        surface: "chat",
        variant: "home",
        onAction: noop,
        onDismiss: noop,
      }),
    );
  assert.match(view(), /Update to Claudex 0\.0\.33/);
  try {
    await setLocale("zh-CN");
    assert.match(view(), /更新到 Claudex 0\.0\.33/);
    assert.match(view(), /此版本已不再受支持。/);
  } finally {
    await setLocale(sourceLocale);
  }
});

test("What's new's section titles have their own words, not the buttons'", async () => {
  const { tc } = await import("../../src/i18n");
  try {
    await setLocale("zh-CN");
    assert.deepEqual(
      ["New", "Improved", "Fixed"].map((title) => tc("release-section", title)),
      ["新增", "已优化", "已修复"],
    );
  } finally {
    await setLocale(sourceLocale);
  }
  assert.equal(tc("release-section", "New"), "New");
});

test("Check for Updates dialogs read in the app's language", () => {
  const translate = catalogTranslator(zh);
  const result = updateCheckResult(available, "0.0.32");
  assert.equal(translate(result.title), "有可用更新");
  assert.equal(
    translate(result.detail),
    "Claudex 0.0.33 已可用，你当前是 0.0.32。",
  );
  const none = updateCheckResult(undefined, "0.0.32");
  assert.equal(translate(none.title), "没有可用更新");
  assert.equal(translate(none.detail), "你使用的已是最新版本。");
  assert.equal(
    translate(
      "Claudex 0.0.33 was published without a checksum, so it can't be verified.",
    ),
    "Claudex 0.0.33 发布时没有校验和，因此无法验证。",
  );
  assert.equal(
    translate("Claudex 0.0.33 couldn't be installed"),
    "无法安装 Claudex 0.0.33",
  );
  assert.equal(translate("Restart to Update to 0.0.33"), "重启以更新到 0.0.33");
});

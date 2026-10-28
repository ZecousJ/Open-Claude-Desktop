import test from "node:test";
import assert from "node:assert/strict";
import { locales, sourceLocale } from "../../shared/locales";
import { readSource } from "../support/read-source";

/*
 * Texts added for the flows and features parity pass: every shipped language
 * has its own line for each, with the same {placeholders} as the English.
 */
const messages = [
  // Dictation that stops itself.
  "Dictation stopped because it heard no words for 1 minute.",
  "Dictation stopped at its time limit.",
  "If you were speaking, check your microphone.",
  "Your words so far are in the message box.",
  // The /schedule confirmation card.
  "Create this task?",
  "Create this routine?",
  "Create task",
  "Create routine",
  "Confirm new task",
  "Confirm new routine",
  // Dispatch.
  "Your sign-in session has expired, so Dispatch is disconnected on this device. Sign in again to reconnect.",
  "Failed to enable Dispatch notifications.",
  "Claudex will access your desktop (files, apps, and browser) to complete tasks you send from your phone. This may have security risks. Only pair devices that you own and trust.",
  "Learn how to use this safely",
  // Cowork folders.
  "Link this task to this computer to add folders",
  // Skip all approvals: the connectors' tools.
  "Already allowed",
  "Read-only",
  "Write/delete",
  // The curated marketplace sources, without the vendor's name.
  "Curated sources",
  "Browse curated sources",
  "Curated marketplaces of plugins",
  "Choose which curated sources to include.",
  "Directory",
  // The connector page's connection sentences.
  "You’re not connected to {name} yet.",
  "Your connection to {name} stopped working. Reconnect to continue.",
  "You disconnected {name}. Claudex can’t access it until you connect it again.",
  // Adding a marketplace that fails.
  "Could not connect to the marketplace host. Check the URL and your network connection.",
  "Could not connect to the marketplace. Check the URL and your network connection.",
  "Repository not found or not accessible.",
  "This marketplace could not be accessed. Private repositories are only supported using the GitHub owner/repo format.",
  "The operation timed out. You can try again.",
  "Git is required to add marketplaces. Install Git, then restart the app.",
  "Failed to add marketplace.",
  "Plugin duplicate failed. You can try again.",
  "Enter a GitHub owner/repo or a Git repository URL to sync.",
  "Shared session. Visible to anyone with the link.",
  "This session may include secure credentials.",
  "Anyone with repository access and the link can view",
  "Shared session. Visible to anyone with repository access and the link.",
  "Only people with access can open the link.",
  "Add connectors",
  "Updated {count} memories",
];

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

test("flows and features texts are translated in every shipped language", async () => {
  const translated = locales.filter((locale) => locale.id !== sourceLocale);
  assert.equal(translated.length, 11);
  for (const { id } of translated) {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    for (const message of messages) {
      const line = catalog[message];
      assert.ok(line?.trim(), `${id}: missing ${message}`);
      assert.notEqual(line, message, `${id}: English left in ${message}`);
      assert.equal(
        placeholders(line).join(),
        placeholders(message).join(),
        `${id}: placeholders of ${message}`,
      );
      assert.doesNotMatch(
        line,
        /Claude(?!x)|Anthropic|claude\.(ai|com)|anthropic\.com/,
        `${id}: vendor name in ${message}`,
      );
    }
  }
});

test("Last seen reads as when something was last there, for a device and a finding alike", async () => {
  const lines: Record<string, string> = {};
  for (const id of ["zh-CN", "ja-JP", "ko-KR"])
    lines[id] = (await import(`../../shared/i18n/catalogs/${id}.ts`)).default[
      "Last seen"
    ];
  // zh-CN tells a device's "Last seen" (最后在线, context key) from a finding's.
  const zh = (await import("../../shared/i18n/catalogs/zh-CN.ts")).default;
  assert.equal(zh["device|Last seen"], "最后在线");
  assert.equal(lines["zh-CN"], "最近发现");
  assert.equal(lines["ja-JP"], "最終確認");
  assert.equal(lines["ko-KR"], "마지막 확인");
});

test("the checkout title goes through the translated template, plan name verbatim", () => {
  const source = readSource("src/settings/billing/CheckoutDialog.tsx", "utf8");
  assert.match(
    source,
    /formatText\("Subscribe to \{x\}", \{ x: plan\.name \}\)/,
  );
  assert.doesNotMatch(source, /`Subscribe to \$\{/);
});

test("an installed plugin's Added is a state; zh-CN keeps the plain key for the Added column", async () => {
  // Plugin rows use tc("state", "Added"); the plain key names the device
  // tables' Added column (tests/artifacts/artifacts-zh-terms).
  const zh = (await import("../../shared/i18n/catalogs/zh-CN.ts")).default;
  assert.equal(zh["state|Added"], "已添加");
  assert.equal(zh["Added"], "添加时间");
  const ja = (await import("../../shared/i18n/catalogs/ja-JP.ts")).default;
  assert.equal(ja["Added"], "追加済み");
});

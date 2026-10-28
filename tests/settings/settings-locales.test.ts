import test from "node:test";
import assert from "node:assert/strict";
import { currentLocale, formatText, setLocale, t } from "../../src/i18n";
import { locales, sourceLocale } from "../../shared/locales";

const generalMessages = [
  "Emails from Claudex Code cloud sessions",
  "Get an email when a cloud session has finished building or needs your response.",
  "Get a push notification when Claudex needs your approval to run a command in a Code session.",
  "Couldn’t load email notification availability.",
  "Email notifications are unavailable for this account.",
];

test("General Code notification labels and availability feedback translate through t() in every shipped locale", async () => {
  const before = currentLocale();
  const translatedLocales = locales.filter(
    (locale) => locale.id !== sourceLocale,
  );
  assert.equal(translatedLocales.length, 11);
  try {
    for (const { id } of translatedLocales) {
      const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
        .default as Record<string, string>;
      await setLocale(id);
      assert.equal(currentLocale(), id);
      for (const message of generalMessages) {
        assert.ok(catalog[message]?.trim(), `${id}: missing ${message}`);
        assert.notEqual(
          t(message),
          message,
          `${id}: English fallback for ${message}`,
        );
        assert.equal(
          t(message),
          catalog[message],
          `${id}: wrong active catalog for ${message}`,
        );
        if (message.includes("Claudex"))
          assert.ok(
            t(message).includes("Claudex"),
            `${id}: product name changed`,
          );
      }
    }
    await setLocale(sourceLocale);
    for (const message of generalMessages) assert.equal(t(message), message);
  } finally {
    await setLocale(before);
  }
});

const desktopMessages = [
  "Controls the built-in browser in local Code sessions. Not available in cloud Code sessions.",
  "Preferences for the built-in browser in Code sessions.",
  "Links in Code sessions open in the built-in browser instead of your default browser.",
  "Import local MCP servers",
  "Review supported configurations on this computer. Selected servers are added disabled.",
  "Review…",
  "MCP logs: {name}",
  "Connection events from the current runtime. Server stderr is not available. Credentials are redacted and older events are discarded when the limit is reached.",
  "Loading logs…",
  "Couldn’t load this server’s logs. Try again.",
  "Showing the most recent events.",
  "MCP connection events",
  "No connection events have been captured for this server yet.",
  "Imported {count} server. They are disabled. Review and enable them in Developer → Edit config when you trust their commands.",
  "Imported {count} servers. They are disabled. Review and enable them in Developer → Edit config when you trust their commands.",
  "Review servers from Claude Desktop, Claude Code user settings and Cursor user settings on this computer. Only supported local stdio configurations are offered. Environment credentials are preserved during import and hidden in this preview.",
  "MCP commands can access local files and services with your account’s permissions when enabled. Selected servers will be added disabled. Existing servers and their credentials are preserved.",
  "Checking local configurations…",
  "Checked MCP sources",
  "Checked",
  "Not found",
  "Couldn’t read",
  "No local MCP servers found in supported sources.",
  "Review command and environment",
  "{count} selected. You can add up to {limit} at a time.",
  "Your administrator has turned off local MCP editing.",
  "Check again",
  "Importing…",
  "Import {count} disabled server",
  "Import {count} disabled servers",
  "Couldn’t check local MCP configurations. Try again.",
  "Couldn’t import these servers. Check again and retry.",
  "Already set up.",
  "This name is managed by Claudex.",
  "Already set up under another name.",
  "This name is already in use. Existing configuration will be preserved.",
  "Your administrator does not allow this server.",
  "This name is managed by an installed extension.",
  "Couldn’t read a supported MCP configuration from this source.",
  "This review expired. Check for MCP servers again.",
  "This server configuration is not supported.",
  "Only local stdio servers with command, arguments, environment and optional working directory are supported.",
  "This server needs a valid local command.",
  "This server has unsupported arguments.",
  "The working directory must be an absolute path.",
  "This server has unsupported environment variables.",
  "Select valid servers to import.",
  "The selected servers changed or a name is now in use. Check for MCP servers again.",
  "This MCP server no longer exists.",
  "This MCP server is unavailable.",
  "Local MCP discovery is only available in the desktop app.",
  "The MCP configuration has unapplied changes. Fix it before importing servers.",
  "Unsupported configuration.",
];

const capabilityMessages = [
  "Disable code execution and file creation to change this setting.",
  "Applies to Chat. Changes take effect with your next message.",
  "Artifacts enabled",
  "Artifacts disabled",
  "Start a new incognito chat to apply the code execution setting.",
];

test("Desktop MCP, browser and Capabilities messages use translated catalogs and preserve runtime values", async () => {
  const before = currentLocale();
  const messages = [...desktopMessages, ...capabilityMessages];
  assert.equal(desktopMessages.length, 53);
  assert.equal(capabilityMessages.length, 5);
  const values = { name: "Settings <MCP>", count: 2, limit: 20 };
  try {
    for (const { id } of locales.filter(
      (locale) => locale.id !== sourceLocale,
    )) {
      const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
        .default as Record<string, string>;
      await setLocale(id);
      for (const message of messages) {
        const translated = t(message);
        assert.ok(translated.trim(), `${id}: empty ${message}`);
        assert.notEqual(
          translated,
          message,
          `${id}: English fallback for ${message}`,
        );
        assert.equal(
          translated,
          catalog[message],
          `${id}: active catalog mismatch`,
        );
        assert.deepEqual(
          (translated.match(/\{\w+\}/g) ?? []).sort(),
          (message.match(/\{\w+\}/g) ?? []).sort(),
          `${id}: lost placeholders for ${message}`,
        );
        assert.equal(
          formatText(message, values),
          translated.replace(/\{(\w+)\}/g, (whole, key: string) =>
            key in values ? String(values[key as keyof typeof values]) : whole,
          ),
        );
      }
      assert.ok(
        formatText("MCP logs: {name}", values).includes(values.name),
        `${id}: server name was translated`,
      );
      assert.ok(
        formatText(
          "{count} selected. You can add up to {limit} at a time.",
          values,
        ).includes("20"),
      );
      for (const count of [1, 2]) {
        const key =
          count === 1
            ? "Import {count} disabled server"
            : "Import {count} disabled servers";
        assert.ok(
          formatText(key, { count }).includes(String(count)),
          `${id}: import count missing`,
        );
      }
    }
  } finally {
    await setLocale(before);
  }
});

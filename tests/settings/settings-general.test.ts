import test from "node:test";
import assert from "node:assert/strict";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { defaultSettings } from "../../electron/store/store";
import { profileInstructions } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import {
  NotificationsSection,
  SyncSection,
  searchLabels as generalLabels,
} from "../../src/settings/tabs/General";
import { nearestSpeed, speedChoices } from "../../src/settings/tabs/General";
import { VoiceSection } from "../../src/settings/tabs/General";
import {
  AccountSection,
  AccountTab,
  ActiveSessionsSection,
  searchLabels as accountLabels,
} from "../../src/settings/tabs/Account";
import {
  PreferencesSection,
  searchLabels as privacyLabels,
} from "../../src/settings/tabs/Privacy";
import { navGroups } from "../../src/settings/nav";
import {
  settingsSearchIndex,
  settingsSearchIndexForHost,
} from "../../src/settings/search/pages";
import {
  matchingRow,
  rankText,
  searchSettings,
  searchText,
  settingsSearchKey,
} from "../../src/settings/search/registry";

test("settings search handles arrows, selection, dismissal, Tab, and IME like the live popover", () => {
  for (const [key, action] of [
    ["ArrowDown", "next"],
    ["ArrowUp", "previous"],
    ["Enter", "select"],
    ["Escape", "dismiss"],
    ["Tab", "leave"],
  ]) {
    assert.equal(settingsSearchKey(key, "avatar"), action);
    assert.equal(settingsSearchKey(key, "avatar", true), undefined);
    assert.equal(settingsSearchKey(key, "  "), undefined);
  }
  assert.equal(settingsSearchKey("a", "avatar"), undefined);
});

test("a profile field saves on Enter and puts the saved value back on Escape", async () => {
  const { textFieldKey } = await import("../../src/settings/controls");
  assert.equal(textFieldKey("Enter", "Ada", "Ada"), "commit");
  assert.equal(textFieldKey("Enter", "Ada L", "Ada"), "commit");
  // Escape on an edit reverts it and keeps Settings open.
  assert.equal(textFieldKey("Escape", "Ada L", "Ada"), "revert");
  // Escape with nothing changed (spaces aside) is left to close Settings.
  assert.equal(textFieldKey("Escape", "Ada ", "Ada"), undefined);
  assert.equal(textFieldKey("a", "Ada", "Ada"), undefined);
});

test("the voice choices belong to the browser, not to the synced settings", () => {
  // Voices are the computer's own, so voice, speed and language are kept in
  // the page's storage (voice/speech.ts) and the account never sees them.
  assert.equal("voiceStyle" in preferenceFields, false);
  assert.equal("voiceSpeed" in preferenceFields, false);
  for (const label of ["Voice", "Language", "Style", "Speed"])
    assert.ok(generalLabels.includes(label), label);
});

test("notification switches read the preferences the desktop integration uses", () => {
  const markup = renderToStaticMarkup(
    createElement(NotificationsSection, {
      settings: { ...defaultSettings, notifyResponses: true },
      save: () => {},
    }),
  );
  const switches = [
    ...markup.matchAll(/aria-label="([^"]+)" aria-checked="(true|false)"/g),
  ].map((match) => [match[1], match[2]]);
  assert.deepEqual(switches, [
    ["Response completions", "true"],
    // Scheduled tasks is on by default.
    ["Scheduled tasks", "true"],
    // A Code session's own notifications are off until turned on; Code
    // approval banners are independently persisted; unavailable cloud email
    // channels are omitted.
    ["Code notifications", "false"],
    ["Code permission requests", "true"],
  ]);
});

test("Settings search ranks pages and lists the rows under them", () => {
  const pages = navGroups.flatMap((group) => group.tabs);
  assert.equal(
    searchSettings("", pages, settingsSearchIndex).length,
    pages.length,
  );
  // Both of Account's log out rows match, so the page is listed with them.
  assert.deepEqual(searchSettings("log out", pages, settingsSearchIndex), [
    { kind: "page", tab: "account" },
    { kind: "child", tab: "account", row: "Log out of all devices" },
    { kind: "child", tab: "account", row: "Log out of this device" },
  ]);
  // General has two matching rows (the section and Code notifications), so
  // the page is listed with them.
  assert.deepEqual(searchSettings("  NOTIF  ", pages, settingsSearchIndex), [
    { kind: "page", tab: "general" },
    { kind: "child", tab: "general", row: "Notifications" },
    { kind: "child", tab: "general", row: "Code notifications" },
    // Claude Code's row has the word at the start of a word: ranked after.
    { kind: "page", tab: "code", row: "Draw attention on notifications" },
  ]);
  assert.deepEqual(searchSettings("export", pages, settingsSearchIndex), [
    { kind: "page", tab: "import", row: "Export" },
    { kind: "page", tab: "privacy", row: "Export data" },
  ]);
  // A page whose name matches comes first, the rows that match follow.
  assert.deepEqual(searchSettings("claude code", pages, settingsSearchIndex), [
    { kind: "page", tab: "code" },
    {
      kind: "page",
      tab: "general",
      row: "Emails from Claudex Code cloud sessions",
    },
  ]);
  assert.deepEqual(searchSettings("zzz", pages, settingsSearchIndex), []);
  assert.equal(searchText("Can’t   RUN"), "can't run");
});

test("Settings search finds pages by their keywords and rows by their phrases", () => {
  const pages = navGroups.flatMap((group) => group.tabs);
  assert.deepEqual(searchSettings("integrations", pages, settingsSearchIndex), [
    { kind: "page", tab: "connectors" },
  ]);
  assert.deepEqual(searchSettings("mcp", pages, settingsSearchIndex), [
    { kind: "page", tab: "developer", row: "Local MCP servers" },
    { kind: "page", tab: "import", row: "Import local MCP servers" },
    { kind: "page", tab: "connectors" },
    { kind: "page", tab: "extensions" },
  ]);
  assert.deepEqual(searchSettings("font size", pages, settingsSearchIndex), [
    { kind: "page", tab: "general", row: "Transcript text size" },
  ]);
  assert.deepEqual(searchSettings("terse", pages, settingsSearchIndex), [
    { kind: "page", tab: "code", row: "Output style" },
  ]);
  // The newer rows' phrases.
  assert.deepEqual(searchSettings("monospace", pages, settingsSearchIndex), [
    { kind: "page", tab: "code", row: "Code font" },
  ]);
  assert.deepEqual(searchSettings("column width", pages, settingsSearchIndex), [
    { kind: "page", tab: "general", row: "Transcript width" },
  ]);
  assert.deepEqual(searchSettings("ui font", pages, settingsSearchIndex), [
    { kind: "page", tab: "code", row: "Interface font" },
  ]);
});

test("a page whose name matches lists three rows and counts the rest", () => {
  const pages = [{ id: "code" as const, label: "Code" }];
  const index = { code: ["Code a", "Code b", "Code c", "Code d", "Code e"] };
  assert.deepEqual(searchSettings("code", pages, index), [
    { kind: "page", tab: "code" },
    { kind: "child", tab: "code", row: "Code a" },
    { kind: "child", tab: "code", row: "Code b" },
    { kind: "child", tab: "code", row: "Code c" },
    { kind: "more", tab: "code", count: 2 },
  ]);
});

test("search ranks equal, then prefix, then word start, then contains", () => {
  assert.equal(rankText("Log out", "log out"), 0);
  assert.equal(rankText("Log out of all devices", "logout"), 1);
  assert.equal(rankText("Draw attention on notifications", "notif"), 2);
  assert.equal(rankText("Notifications", "ication"), 3);
  assert.equal(rankText("Notifications", "zzz"), -1);
});

test("every search label of Account, General and Privacy is a row or section they can show", async () => {
  let markup = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(NotificationsSection, {
        settings: defaultSettings,
        save: () => {},
      }),
      createElement(VoiceSection),
      createElement(SyncSection, { settings: defaultSettings, save: () => {} }),
      createElement(AccountSection, {
        profile: {
          kind: "local",
          fullName: "Z",
          email: "z@example.com",
          canDelete: true,
        },
        onSignOut: () => {},
        onDelete: () => {},
      }),
      createElement(AccountSection, {
        profile: undefined,
        onSignOutEverywhere: () => {},
        onDelete: () => {},
      }),
      createElement(ActiveSessionsSection),
      createElement(AccountTab, {
        settings: defaultSettings,
        platform: "darwin",
        engine: { state: "ready" },
        save() {},
        onError() {},
        goTo() {},
      }),
      createElement(PreferencesSection, {
        status: {
          diagnostics: true,
          feedback: false,
          allowConversationExcerpt: false,
          consented: false,
        },
        settings: defaultSettings,
        save: () => {},
      }),
    ),
  );
  // Account devices are a deferred leaf: mount its actual bridge-backed UI,
  // so search coverage checks the real rows instead of adding label exceptions.
  const { routineDom } = await import("../support/routine-dom");
  const { AccountDeviceSettings } =
    await import("../../src/settings/tabs/AccountTrustedDevices");
  const state = { requireTrustedDevices: false, trusted: [], pending: [] };
  const deviceDOM = await routineDom({
    listCoworkDevices: async () => [],
    deviceTrustState: async () => state,
    setRequireTrustedDevices: async () => state,
    approveDeviceTrust: async () => state,
    rejectDeviceTrust: async () => state,
    revokeDeviceTrust: async () => state,
  });
  try {
    await deviceDOM.render(
      createElement(AccountDeviceSettings, {
        onError(error) {
          throw error;
        },
      }),
    );
    markup += deviceDOM.document.body.innerHTML;
  } finally {
    await deviceDOM.clean();
  }
  // Rows and titles the pages render directly, besides the sections above.
  const direct = [
    "Appearance",
    "Theme",
    "Chat font",
    "Motion",
    // Desktop only, under Appearance (TranscriptAppearance, loaded with it).
    "Transcript text size",
    "Transcript width",
    // Desktop only (Tasks, loaded with the page).
    "Tasks",
    "Trusted Cowork folders",
    "Preferred browser",
    // Eligible cloud mail is checked asynchronously (mounted interactions in settings-b29-notifications).
    "Emails from Claudex Code cloud sessions",
    // The service's artifact e-mails load asynchronously (mounted below).
    "Mentions and replies",
    "Comments on your artifacts",
    "Artifacts shared with you",
    // Only in a browser that has speech recognition.
    "Speech recognition",
    "Profile",
    "Avatar",
    "Full name",
    "What should Claudex call you?",
    "What best describes your work?",
    "Instructions for Claudex",
    "Privacy",
    "Your data",
    "Export data",
    "Shared chats",
    "Shared artifacts",
    "How we protect your data",
    "How we use your data",
    "Uploaded files",
    "Your feedback",
    "Memory preferences",
    // Only for an account of a Claudex service (its terms page).
    "Terms of Service",
    // The row's wording differs per account kind; search scrolls to the
    // row containing the typed words (see SettingsDialog).
    "Delete account",
  ];
  const { document } = parseHTML(markup);
  const renderedRows = Array.from(
    document.querySelectorAll("[data-setting], [aria-label], h2, h3"),
  );
  for (const label of [...generalLabels, ...accountLabels, ...privacyLabels]) {
    const rendered = renderedRows.some(
      (element) =>
        element.getAttribute("data-setting") === label ||
        element.getAttribute("aria-label") === label ||
        (element.matches("h2,h3") && element.textContent === label),
    );
    assert.ok(rendered || direct.includes(label), label);
  }
  // Delete account is found through the local account's row wording.
  assert.match(markup, /data-setting="Delete your account/);
});

test("a search result scrolls to its row, or to the row holding the typed words", () => {
  const shown = [
    "Log out of all devices",
    "Your administrator manages this account. Contact them to delete it.",
  ];
  assert.equal(matchingRow(shown, "Log out of all devices", "log out"), 0);
  assert.equal(matchingRow(shown, "Delete account", "delete"), 1);
  assert.equal(matchingRow(shown, "Delete account", "delete account"), 1);
  assert.equal(matchingRow(shown, "Delete account", "delete password"), -1);
  assert.equal(matchingRow(shown, "Theme", ""), -1);
});

test("the model is told the name and work the user gave in Account", () => {
  assert.equal(profileInstructions({}), "");
  assert.equal(
    profileInstructions({ name: "  Ada ", workType: "Design" }),
    "The user's name is \"Ada\". Use it only where a person naturally would; never open a reply with it. The user's work: design.",
  );
  assert.equal(
    profileInstructions({ name: 'Ann "Boss"\nLee', workType: "Other" }),
    'The user\'s name is "Ann Boss Lee". Use it only where a person naturally would; never open a reply with it.',
  );
});

test("Voice speed offers the live Slow, Normal and Fast; older rates show as the nearest", () => {
  assert.deepEqual(
    speedChoices.map((choice) => [choice.rate, choice.label]),
    [
      [0.8, "Slow"],
      [1, "Normal"],
      [1.2, "Fast"],
    ],
  );
  assert.equal(nearestSpeed(1.5), 1.2);
  assert.equal(nearestSpeed(0.8), 0.8);
  assert.equal(nearestSpeed(1), 1);
});

test("local-only Settings search omits cloud email while eligible cloud search retains it", () => {
  const pages = navGroups.flatMap((group) => group.tabs);
  const query = "Emails from Claudex Code cloud sessions";
  assert.deepEqual(
    searchSettings(query, pages, settingsSearchIndexForHost(false)),
    [],
  );
  assert.deepEqual(
    searchSettings(query, pages, settingsSearchIndexForHost(true)),
    [{ kind: "page", tab: "general", row: query }],
  );
});

test("the artifact e-mails show the service's choices and save each change there", async () => {
  const { routineDom } = await import("../support/routine-dom");
  const patches: unknown[] = [];
  let prefs = { mentions: true, comments: true, shares: true };
  const dom = await routineDom({
    artifactMailPreferences: async () => prefs,
    setArtifactMailPreferences: async (patch) => {
      patches.push(patch);
      prefs = { ...prefs, ...patch };
      return prefs;
    },
  });
  try {
    await dom.render(
      createElement(NotificationsSection, {
        settings: defaultSettings,
        save: () => {},
      }),
    );
    await dom.render(
      createElement(NotificationsSection, {
        settings: defaultSettings,
        save: () => {},
      }),
    );
    const state = (label: string) =>
      dom.document
        .querySelector(`[role="switch"][aria-label="${label}"]`)
        ?.getAttribute("aria-checked");
    assert.equal(state("Mentions and replies"), "true");
    assert.equal(state("Comments on your artifacts"), "true");
    assert.equal(state("Artifacts shared with you"), "true");
    await dom.click('[role="switch"][aria-label="Artifacts shared with you"]');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await dom.render(
      createElement(NotificationsSection, {
        settings: defaultSettings,
        save: () => {},
      }),
    );
    assert.deepEqual(patches, [{ shares: false }]);
    assert.equal(state("Artifacts shared with you"), "false");
  } finally {
    await dom.clean();
  }
});

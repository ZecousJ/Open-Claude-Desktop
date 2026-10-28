import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  busyTabs,
  closeRequest,
  stillPending,
} from "../../src/terminal/terminal-close";
import { terminalCloseText } from "../../src/terminal/TerminalCloseDialog";
import {
  cleanTabName,
  forgetTab,
  hasTabName,
} from "../../src/terminal/terminal-tabs";
import { readSource } from "../support/read-source";

const tab = (id: string, busy?: boolean, running = true) => ({
  id,
  busy,
  running,
});

test("Close terminal asks only while a command is running in the tab", () => {
  const tabs = [tab("a", true), tab("b", false), tab("c")];
  assert.deepEqual(closeRequest({ kind: "close", id: "a" }, tabs, ["a"]), {
    kind: "close",
    id: "a",
  });
  assert.equal(
    closeRequest({ kind: "close", id: "b" }, tabs, ["a"]),
    undefined,
  );
  // A shell without marks is never known to be busy: it closes at once.
  assert.equal(
    closeRequest({ kind: "close", id: "c" }, tabs, ["a"]),
    undefined,
  );
  // A tab already gone needs nothing.
  assert.equal(
    closeRequest({ kind: "close", id: "z" }, tabs, ["z"]),
    undefined,
  );
});

test("Close other terminals counts the other tabs with a running command", () => {
  const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
  assert.deepEqual(
    closeRequest({ kind: "closeOthers", keep: "a" }, tabs, ["a", "b", "d"]),
    { kind: "closeOthers", keep: "a", busyCount: 2 },
  );
  // Only the kept tab is busy: the others close at once.
  assert.equal(
    closeRequest({ kind: "closeOthers", keep: "a" }, tabs, ["a"]),
    undefined,
  );
  assert.equal(
    closeRequest({ kind: "closeOthers", keep: "z" }, tabs, ["b"]),
    undefined,
  );
});

test("the question goes away once the commands it asks about end", () => {
  const close = { kind: "close" as const, id: "a" };
  assert.equal(stillPending(close, [tab("a", true)]), true);
  assert.equal(stillPending(close, [tab("a", false)]), false);
  assert.equal(stillPending(close, [tab("a", true, false)]), false);
  assert.equal(stillPending(close, []), false);
  const others = { kind: "closeOthers" as const, keep: "a", busyCount: 2 };
  assert.equal(stillPending(others, [tab("a"), tab("b", true)]), true);
  assert.equal(stillPending(others, [tab("a", true), tab("b", false)]), false);
  assert.equal(stillPending(others, [tab("b", true)]), false);
  assert.deepEqual(
    busyTabs([tab("a", true), tab("b"), tab("c", true, false)]),
    ["a"],
  );
});

test("the dialogs use the original's words", () => {
  assert.deepEqual(
    terminalCloseText({ kind: "close", id: "a" }, "Terminal 2"),
    {
      title: "Close terminal?",
      body: "A command is still running in Terminal 2. Closing the terminal stops it.",
      confirm: "Close terminal",
    },
  );
  assert.deepEqual(
    terminalCloseText({ kind: "closeOthers", keep: "a", busyCount: 1 }, ""),
    {
      title: "Close other terminals?",
      body: "A command is still running in one of the other terminals. Closing them stops it.",
      confirm: "Close other terminals",
    },
  );
  assert.equal(
    terminalCloseText({ kind: "closeOthers", keep: "a", busyCount: 3 }, "")
      .body,
    "Commands are still running in 3 of the other terminals. Closing them stops those commands.",
  );
});

test("a tab given a name is named as typed", () => {
  assert.equal(hasTabName("c", "t"), false);
  cleanTabName("c", "t", "build");
  assert.equal(hasTabName("c", "t"), true);
  forgetTab("c", "t");
  assert.equal(hasTabName("c", "t"), false);
});

test("the panel asks before closing and every new string has its translations", async () => {
  const panel = readSource("src/terminal/TerminalPanel.tsx");
  // Both the tab's × and its menu go through the asking close.
  assert.match(panel, /onClick=\{\(\) => void close\(session\.id\)\}/);
  assert.match(
    panel,
    /label: "Close terminal", onSelect: \(\) => void close\(tab\)/,
  );
  assert.match(panel, /onSelect: \(\) => void closeOthers\(tab\)/);
  assert.match(panel, /api\s*\.terminalBusy\(conversationId\)/);
  const locales = [
    "zh-CN",
    "ja-JP",
    "ko-KR",
    "de-DE",
    "fr-FR",
    "es-ES",
    "es-419",
    "it-IT",
    "pt-BR",
    "id-ID",
    "hi-IN",
  ];
  for (const english of [
    "Close terminal?",
    "Close other terminals?",
    "A command is still running in {name}. Closing the terminal stops it.",
    "A command is still running in one of the other terminals. Closing them stops it.",
    "Commands are still running in {count} of the other terminals. Closing them stops those commands.",
  ]) {
    const entry: Record<string, string> = {};
    for (const locale of locales)
      entry[locale] = (
        (await import(`../../shared/i18n/catalogs/${locale}.ts`))
          .default as Record<string, string>
      )[english];
    for (const locale of locales)
      assert.ok(entry[locale], `${locale}: ${english}`);
    const holes = english.match(/\{\w+\}/g) ?? [];
    for (const locale of locales)
      for (const hole of holes)
        assert.equal(
          entry[locale].split(hole).length - 1,
          1,
          `${locale}: ${english}`,
        );
  }
});

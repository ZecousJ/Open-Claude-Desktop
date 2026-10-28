import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});

const { codeSessionKey, promptJumpTarget } =
  await import("../../src/code-keys/code-session-keys");
const { effectiveTranscriptView, nextTranscriptView, showsThinking } =
  await import("../../shared/transcript-view");
const {
  markTranscriptViewNudged,
  noteTranscriptViewPick,
  pickedTranscriptView,
  resetTranscriptViews,
  setTranscriptView,
  transcriptViewFor,
  transcriptViewSessionLimit,
  TranscriptViewContext,
  verboseOpen,
} = await import("../../src/transcript-view/transcript-view-store");
const { transcriptViewEntries, titleMenuEntries } =
  await import("../../src/conversation/ConversationTitle");
const { codeSegments } = await import("../../src/code-tools/code-tool-model");
const { codeShortcutSections, desktopShortcutSections } =
  await import("../../src/dialogs/KeyboardShortcutsDialog");
const { commandForKey, keyTable } = await import("../../src/host/keys");
const { paneKeyCommand } = await import("../../shared/pane-keys");
const { catalogHasFastTier } =
  await import("../../src/composer/code/code-fast-mode");
const { paneToExpand } = await import("../../src/app/pane-expand");
const { preference } = await import("../../shared/settings-extras");
const { preferenceFields } =
  await import("../../shared/settings-extras-schema");
const { ItemView } = await import("../../src/ui/ItemView");

const press = (
  code: string,
  modifiers: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
) => ({
  key: code.replace(/^Key/, "").toLowerCase(),
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

beforeEach(() => {
  storage.clear();
  resetTranscriptViews();
});

test("Ctrl+O cycles the transcript view on every platform", () => {
  for (const mac of [true, false])
    assert.equal(
      codeSessionKey(press("KeyO", { ctrlKey: true }), mac),
      "cycle-transcript-view",
    );
  // ⌘O and Ctrl+Shift+O are other keys.
  assert.equal(
    codeSessionKey(press("KeyO", { metaKey: true }), true),
    undefined,
  );
  assert.equal(
    codeSessionKey(press("KeyO", { ctrlKey: true, shiftKey: true }), false),
    undefined,
  );
});

test("⌥⌘↑ / ⌥⌘↓ jump between prompts on macOS, Alt+↑ / Alt+↓ elsewhere", () => {
  assert.equal(
    codeSessionKey(press("ArrowUp", { metaKey: true, altKey: true }), true),
    "jump-previous-prompt",
  );
  assert.equal(
    codeSessionKey(press("ArrowDown", { metaKey: true, altKey: true }), true),
    "jump-next-prompt",
  );
  // Alt alone on a Mac moves by paragraph in a text field.
  assert.equal(
    codeSessionKey(press("ArrowUp", { altKey: true }), true),
    undefined,
  );
  assert.equal(
    codeSessionKey(press("ArrowUp", { altKey: true }), false),
    "jump-previous-prompt",
  );
  assert.equal(
    codeSessionKey(press("ArrowDown", { altKey: true, shiftKey: true }), false),
    undefined,
  );
});

test("a prompt jump lands on the prompt above or below the view", () => {
  const prompts = [
    { id: "a", index: 0, top: -400 },
    { id: "b", index: 1, top: -100 },
    { id: "c", index: 2, top: 115 },
    { id: "d", index: 3, top: 600 },
  ];
  const at = { viewportTop: 100, landingOffset: 20, atBottom: false };
  // "c" sits on the landing line (100 + 20, within 12px): it is the current one.
  assert.equal(promptJumpTarget(prompts, "previous", at)?.id, "b");
  assert.equal(promptJumpTarget(prompts, "next", at)?.id, "d");
  // Nothing below at the end; nothing above the first.
  assert.equal(
    promptJumpTarget(prompts, "next", { ...at, atBottom: true }),
    null,
  );
  assert.equal(
    promptJumpTarget(
      prompts.map((p) => ({ ...p, top: p.top + 1000 })),
      "previous",
      at,
    ),
    null,
  );
  // Right after a jump the landed prompt steers the next press.
  assert.equal(
    promptJumpTarget(prompts, "previous", { ...at, anchor: "b" })?.id,
    "a",
  );
  assert.equal(promptJumpTarget(prompts, "next", { ...at, anchor: "d" }), null);
});

test("the transcript views cycle Normal, Thinking, Verbose", () => {
  const thinking = { thinking: true };
  assert.equal(nextTranscriptView("normal", thinking), "thinking");
  assert.equal(nextTranscriptView("thinking", thinking), "verbose");
  assert.equal(nextTranscriptView("verbose", thinking), "normal");
  // Without thinking, Thinking reads as Normal and is skipped.
  assert.equal(nextTranscriptView("normal", { thinking: false }), "verbose");
  assert.equal(
    effectiveTranscriptView("thinking", { thinking: false }),
    "normal",
  );
  assert.equal(showsThinking("normal"), false);
  assert.equal(showsThinking("verbose"), true);
  assert.equal(verboseOpen("verbose"), true);
  assert.equal(verboseOpen("thinking"), undefined);
});

test("each session keeps its own view; the rest follow the default", () => {
  assert.equal(transcriptViewFor("s1", "normal"), "normal");
  setTranscriptView("s1", "verbose");
  assert.equal(transcriptViewFor("s1", "normal"), "verbose");
  assert.equal(transcriptViewFor("s2", "thinking"), "thinking");
  // Stored for the next launch.
  resetTranscriptViews();
  assert.equal(pickedTranscriptView("s1"), "verbose");
  // Only the latest sessions keep theirs.
  for (let i = 0; i < transcriptViewSessionLimit + 5; i++)
    setTranscriptView(`n${i}`, "thinking");
  assert.equal(pickedTranscriptView("s1"), undefined);
  assert.equal(
    pickedTranscriptView(`n${transcriptViewSessionLimit + 4}`),
    "thinking",
  );
});

test("picking a view in a second session offers it as the default, once", () => {
  assert.equal(noteTranscriptViewPick("verbose", "s1", "normal"), false);
  assert.equal(noteTranscriptViewPick("verbose", "s1", "normal"), false);
  assert.equal(noteTranscriptViewPick("verbose", "s2", "normal"), true);
  markTranscriptViewNudged("verbose");
  assert.equal(noteTranscriptViewPick("verbose", "s3", "normal"), false);
  // The default itself is never offered.
  assert.equal(noteTranscriptViewPick("normal", "s4", "normal"), false);
});

test("the default transcript view is a setting", () => {
  assert.equal(preference({}, "defaultTranscriptView"), "normal");
  assert.equal(
    preferenceFields.defaultTranscriptView.safeParse("verbose").success,
    true,
  );
  assert.equal(
    preferenceFields.defaultTranscriptView.safeParse("loud").success,
    false,
  );
});

test("Transcript view ▸ lists the views and offers Make … the default", () => {
  const picked: string[] = [];
  const menu = (view: "normal" | "thinking" | "verbose") =>
    transcriptViewEntries({
      view,
      defaultView: "normal",
      onSelect: (value) => picked.push(value),
      onMakeDefault: () => picked.push("default"),
    });
  const normal = menu("normal");
  assert.deepEqual(
    normal.map((entry) => ("label" in entry ? entry.label : "—")),
    ["Normal", "Thinking", "Verbose"],
  );
  const verbose = menu("verbose");
  assert.deepEqual(
    verbose.map((entry) =>
      "separator" in entry ? "—" : "label" in entry ? entry.label : "",
    ),
    ["Normal", "Thinking", "Verbose", "—", "Make Verbose the default"],
  );
  const rows = verbose as {
    label?: string;
    checked?: boolean;
    onSelect?: () => void;
  }[];
  assert.equal(rows[2].checked, true);
  rows[0].onSelect?.();
  rows[4].onSelect?.();
  assert.deepEqual(picked, ["normal", "default"]);
});

test("the Code title menu's Transcript view works once it is wired", () => {
  const conversation = {
    id: "c",
    mode: "code",
    title: "T",
    turns: [],
  } as never;
  const actions = {
    onPin() {},
    onRename() {},
    onMoveToProject() {},
    onCreateProject() {},
    onOpenProjects() {},
    onArchive() {},
    onDelete() {},
  };
  const submenu = (entries: ReturnType<typeof titleMenuEntries>) =>
    (
      entries.find(
        (entry) => "label" in entry && entry.label === "Transcript view",
      ) as { submenu: { label: string; disabled?: boolean }[] }
    ).submenu;
  // Unwired (no menu passed): the old greyed rows.
  assert.equal(
    submenu(titleMenuEntries(conversation, [], false, actions))[2].disabled,
    true,
  );
  const wired = submenu(
    titleMenuEntries(conversation, [], false, {
      ...actions,
      transcriptView: {
        view: "normal",
        defaultView: "normal",
        onSelect() {},
        onMakeDefault() {},
      },
    }),
  );
  assert.equal(
    wired.some((row) => row.disabled),
    false,
  );
});

test("Thinking and Verbose list every tool call and show the thinking", () => {
  const items = [
    { id: "1", type: "commandExecution", command: "ls", status: "completed" },
    { id: "2", type: "reasoning", summary: ["Looking around"] },
    { id: "3", type: "commandExecution", command: "pwd", status: "completed" },
  ] as never[];
  assert.equal(codeSegments(items).length, 1);
  const flat = codeSegments(items, { fold: false });
  assert.deepEqual(
    flat.map((segment) => segment.type),
    ["tools", "item", "tools"],
  );
  const reasoning = items[1];
  const render = (view: "normal" | "thinking") =>
    renderToStaticMarkup(
      createElement(
        TranscriptViewContext.Provider,
        { value: view },
        createElement(ItemView, {
          item: reasoning,
          mode: "code",
          onArtifact: () => {},
        }),
      ),
    );
  assert.match(render("normal"), /Thought process/);
  assert.match(
    render("thinking"),
    /class="code-thinking-text">Looking around</,
  );
});

test("⇧⌘\\ expands the focused pane and ⇧⌘S selects an element", () => {
  const mac = keyTable("desktop", "darwin");
  const win = keyTable("desktop", "win32");
  const key = (
    k: string,
    code: string,
    extra: Partial<{ metaKey: boolean; ctrlKey: boolean }>,
  ) => ({
    key: k,
    code,
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    ...extra,
  });
  assert.equal(
    commandForKey(key("|", "Backslash", { metaKey: true }), mac),
    "toggle-expand-pane",
  );
  assert.equal(
    commandForKey(key("|", "Backslash", { ctrlKey: true }), win),
    "toggle-expand-pane",
  );
  assert.equal(
    commandForKey(key("S", "KeyS", { metaKey: true }), mac),
    "browser-select-element",
  );
  // A Browser page with the focus hands both keys to the window.
  assert.equal(
    paneKeyCommand(
      { key: "|", code: "Backslash", meta: true, shift: true },
      true,
    ),
    "toggle-expand-pane",
  );
  assert.equal(
    paneKeyCommand({ key: "s", control: true, shift: true }, false),
    "browser-select-element",
  );
  // The web leaves them to the browser.
  assert.equal(
    commandForKey(
      key("S", "KeyS", { metaKey: true }),
      keyTable("web", "darwin"),
    ),
    undefined,
  );
});

test("⇧⌘\\ acts on the card with the focus, else the dock's focused card", () => {
  const card = (panel: string) =>
    ({
      closest: (selector: string) =>
        selector === ".work-panel"
          ? { classList: { contains: (name: string) => name === panel } }
          : null,
    }) as unknown as Element;
  const doc = (active: Element | null, focus: string | null) =>
    ({
      activeElement: active,
      querySelector: () => (focus ? { getAttribute: () => focus } : null),
    }) as unknown as Document;
  assert.equal(
    paneToExpand(doc(card("terminal-panel"), "changes")),
    "terminal",
  );
  assert.equal(paneToExpand(doc(null, "changes")), "changes");
  assert.equal(paneToExpand(doc(null, null)), undefined);
});

test("Code's shortcut list follows the live sections and keys", () => {
  const rows = (sections: ReturnType<typeof codeShortcutSections>) =>
    Object.fromEntries(
      sections
        .flatMap((section) => section.shortcuts)
        .map((s) => [s.action, s.keys.map((k) => k.join("+")).join(" | ")]),
    );
  const mac = desktopShortcutSections("darwin", "code");
  assert.deepEqual(
    mac.map((section) => section.title),
    ["General", "Panes", "Composer"],
  );
  const desktop = rows(mac);
  assert.equal(desktop["Search or start a session"], "mod+K");
  assert.equal(desktop["New session"], "mod+N");
  assert.equal(desktop["Transcript view"], "ctrl+O");
  assert.equal(desktop["Jump to previous prompt"], "alt+mod+up");
  assert.equal(desktop["Expand or collapse pane"], "mod+shift+\\");
  assert.equal(desktop["Select element in Browser"], "mod+shift+S");
  assert.equal(desktop["Open mode menu"], "shift+mod+M");
  // Chat-only rows are gone from Code's list.
  assert.equal(desktop["Send message"], undefined);
  assert.equal(desktop["Incognito chat"], undefined);
  // ⌥⌘F shows only when a model has a fast tier.
  assert.equal(desktop["Toggle fast mode"], undefined);
  assert.equal(
    rows(desktopShortcutSections("darwin", "code", { fastMode: true }))[
      "Toggle fast mode"
    ],
    "alt+mod+F",
  );
  const windows = rows(codeShortcutSections("win32", "desktop"));
  assert.equal(windows["Jump to next prompt"], "alt+down");
  // The web: the browser keeps the pane keys and ⇧⌘M.
  const web = rows(codeShortcutSections("darwin", "web"));
  assert.equal(web["New session"], "shift+mod+O");
  assert.equal(web["Expand or collapse pane"], undefined);
  assert.equal(web["Open mode menu"], "alt+mod+M");
  assert.equal(web["Toggle side chat"], "mod+;");
  // ⌥⌘↵ forks with the draft; the menus pick rows by number; the
  // terminal's selection goes into the message.
  assert.equal(
    desktop["Send in a forked session (local sessions)"],
    "alt+mod+enter",
  );
  assert.equal(web["Fork with this prompt"], "alt+mod+enter");
  assert.equal(desktop["Select menu item"], "1…9");
  assert.equal(desktop["Attach selection as context"], "mod+shift+L");
});

test("a fast tier in the catalog shows the fast mode key", () => {
  assert.equal(catalogHasFastTier(null), false);
  assert.equal(
    catalogHasFastTier({
      items: [{ id: "m" }, { id: "m-fast", fastOf: "m" }],
    } as never),
    true,
  );
});

/**
 * R3-S7: Settings → Memory. The two switches with the original's wording,
 * the administrator's lock, offline, a service without memory, the rows
 * Generate adds, and the View and edit / Import / Turn off dialogs.
 *
 * `npm test` runs tests/*.test.ts only; tests/projects-page.test.ts
 * imports this file so it runs with them.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemoryStatus } from "../../shared/memory-api";
import { openPolicy } from "../../shared/client-policy";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());

// Components import their stylesheets; the dialogs portal into
// document.body, which the server renderer cannot do: render in place.
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "react-dom" &&
      (context.parentURL?.endsWith("/src/settings/controls.tsx") ||
        context.parentURL?.endsWith(
          "/src/settings/tabs/TurnOffMemoryDialog.tsx",
        ))
    )
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent("export const createPortal = (node) => node;"),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});

const {
  MemoryPage,
  memoryLearnMore,
  memoryView,
  showsMemoryRows,
  switchEnabled,
  switchLocked,
} = await import("../../src/settings/tabs/Memory");
const {
  ManageMemoryDialog,
  ManageMemoryContent,
  EditField,
  EditsList,
  ManageMemorySkeleton,
  manageMemoryTitle,
  removedEdits,
} = await import("../../src/memory/ManageMemoryDialog");
const { MemoryImportDialog } =
  await import("../../src/memory/MemoryImportDialog");
const { isConflict, memoryError, memoryFits } =
  await import("../../src/memory/useMemory");
const labels = await import("../../src/settings/tabs/desktop-labels");

const on = { searchChats: true, generate: true };
const off = { searchChats: false, generate: false };
const status = (extra: Partial<MemoryStatus> = {}): MemoryStatus => ({
  available: true,
  allowed: { ...on },
  prefs: { ...off },
  synthesizing: false,
  ...extra,
});
const doc = {
  content: "Prefers short answers.\nWrites in English and Chinese.",
  updatedAt: Date.now() - 3 * 3_600_000,
  source: "generated" as const,
  revision: 2,
  edits: [{ id: "e-1", text: "Call me Sam.", createdAt: 0 }],
};
const page = (value: MemoryStatus | undefined, learnMore?: string) =>
  renderToStaticMarkup(
    <MemoryPage
      status={value}
      learnMore={learnMore}
      onPrefs={() => {}}
      onDialog={() => {}}
    />,
  );
/** Renders a dialog: SettingsModal names document.body as the portal's target. */
const dialog = (node: Parameters<typeof renderToStaticMarkup>[0]) => {
  const scope = globalThis as { document?: unknown };
  scope.document = { body: {} };
  try {
    return renderToStaticMarkup(node);
  } finally {
    delete scope.document;
  }
};
const switches = (html: string) =>
  [...html.matchAll(/role="switch"[^>]*/g)].map((match) => match[0]);

test("the two switches carry the original's wording", () => {
  const html = page(status());
  assert.match(html, /Search and reference chats/);
  assert.match(
    html,
    /Allow Claudex to search for relevant details in past chats\./,
  );
  assert.match(html, /Generate memory from chats/);
  assert.match(html, /Allow Claudex to generate memory from your chats\./);
  assert.doesNotMatch(html, /chats and Cowork sessions/);
  const both = switches(html);
  assert.equal(both.length, 2);
  for (const item of both) {
    assert.match(item, /aria-checked="false"/);
    assert.doesNotMatch(item, /disabled/);
  }
  // No administrator link: no dead Learn more.
  assert.doesNotMatch(html, /Learn more/);
  assert.match(page(status(), "https://example.com/memory"), /Learn more/);
  // Generate off: nothing else.
  assert.doesNotMatch(
    html,
    /View and manage memory|Import memory|Reset memory/,
  );
});

test("Learn more is the administrator's memory link, else the original's article", () => {
  const links = (learnMore: { label: string; url: string }[]) => ({
    ...openPolicy.links,
    learnMore,
  });
  assert.equal(
    memoryLearnMore(links([{ label: "Usage policy", url: "https://a" }])),
    "/help/memory",
  );
  assert.equal(
    memoryLearnMore(
      links([
        { label: "Usage policy", url: "https://a" },
        { label: "About memory", url: "https://m" },
      ]),
    ),
    "https://m",
  );
  assert.equal(
    memoryLearnMore(
      links([
        {
          label: "Memory",
          url: `https://${"support"}.${"claude"}.com/article`,
        },
      ]),
    ),
    "/help/memory",
  );
});

test("a service without memory shows the switches off and disabled, and why", () => {
  assert.equal(memoryView(undefined).kind, "loading");
  // The original's two switches stay, off and disabled.
  const unsupported = page(status({ available: false, reason: "unsupported" }));
  assert.match(unsupported, /Memory isn&#x27;t available on this server yet\./);
  assert.equal(switches(unsupported).length, 2);
  for (const item of switches(unsupported)) {
    assert.match(item, /disabled/);
    assert.match(item, /aria-checked="false"/);
  }
  const server = page(status({ available: false, reason: "server" }));
  assert.match(
    server,
    /Memory needs the server to be set up by your administrator\./,
  );
  assert.equal(switches(server).length, 2);
});

test("the administrator's lock disables a switch and says so", () => {
  const policy = status({ available: false, reason: "policy", allowed: off });
  const html = page(policy);
  assert.equal(html.match(/Turned off by your administrator\./g)?.length, 2);
  for (const item of switches(html)) assert.match(item, /disabled/);
  // Only Generate forbidden: Search stays usable.
  const one = status({
    allowed: { searchChats: true, generate: false },
    prefs: { searchChats: true, generate: false },
  });
  assert.equal(switchEnabled(one, "searchChats"), true);
  assert.equal(switchEnabled(one, "generate"), false);
  assert.equal(switchLocked(one, "generate"), true);
  assert.equal(switchLocked(one, "searchChats"), false);
  // Turned on before the lock: it can still be turned off.
  assert.equal(
    switchEnabled(
      status({ allowed: { searchChats: false, generate: true }, prefs: on }),
      "searchChats",
    ),
    true,
  );
});

test("offline shows the cached switches read-only with the note", () => {
  const offline = status({
    available: false,
    reason: "offline",
    prefs: on,
    global: doc,
  });
  const html = page(offline);
  assert.match(
    html,
    /You&#x27;re offline\. Changes will be available when you reconnect\./,
  );
  for (const item of switches(html)) {
    assert.match(item, /aria-checked="true"/);
    assert.match(item, /disabled/);
  }
  // Memory stays readable; Import waits.
  assert.equal(showsMemoryRows(offline), true);
  assert.match(html, /class="memory-manage"/);
  assert.match(html, /disabled="">Import<\/button>/);
});

test("Generate on adds the memory and Import rows; reset is in Turn off memory", () => {
  const html = page(status({ prefs: on, global: doc }));
  // One row that opens the memory.
  assert.match(html, /<button type="button" class="memory-manage">/);
  assert.match(html, /View and manage memory/);
  assert.match(html, /Updated <span class="reply-time">3 hours ago<\/span>/);
  assert.match(html, /Bring in memory from another AI assistant\./);
  // As in the original: no Reset row of its own.
  assert.doesNotMatch(html, /Reset memory/);
  const empty = page(status({ prefs: on }));
  assert.match(empty, /class="memory-manage empty"/);
  assert.match(empty, /Chat memory/);
  assert.match(empty, /No memory yet/);
  assert.doesNotMatch(empty, /View and manage memory/);
  const updating = page(status({ prefs: on, global: doc, synthesizing: true }));
  assert.match(updating, /Updating…/);
  assert.doesNotMatch(updating, /Updated /);
});

test("the service's limits still bound what Import may save", () => {
  assert.equal(memoryFits("x".repeat(16_000)), true);
  assert.equal(memoryFits("x".repeat(16_001)), false);
  // Within the counter but over the service's 16 KiB.
  assert.equal(memoryFits("记".repeat(6_000)), false);
});

test("Manage memory shows the memory read-only with the edit field and Manage edits", () => {
  const withLimits = {
    ...doc,
    content: "## Work context\nPrefers **short** answers.",
    edits: [
      { id: "e-1", text: "Call me Sam.", createdAt: 0 },
      { id: "e-2", text: "Use metric units.", createdAt: 0 },
    ],
    limits: { edits: 50, editChars: 500 },
  };
  const html = dialog(
    <ManageMemoryDialog
      scope={{ kind: "global" }}
      initial={withLimits}
      onClose={() => {}}
    />,
  );
  // The lg popup, title and description.
  assert.match(html, /class="modal [^"]*manage-memory-modal/);
  assert.match(html, /<h2[^>]*>Manage memory<\/h2>/);
  assert.match(html, /Here’s what Claudex remembers about you!/);
  // The memory is rendered Markdown, not a text field.
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /<strong>short<\/strong>/);
  assert.match(html, /style="height:460px"/);
  // The pencil field takes the service's length.
  assert.match(
    html,
    /<input maxLength="500" aria-label="Tell Claudex what to remember or forget"/,
  );
  // Manage edits with the count.
  assert.match(
    html,
    /class="manage-memory-edits-row"><span>Manage edits<\/span><span class="manage-memory-edits-count"><span>2<\/span>/,
  );
  // No editing, no saving, no counter: the Claudex-only text editor is gone.
  assert.doesNotMatch(html, /characters/);
  assert.doesNotMatch(html, />Save</);
  const readOnly = dialog(
    <ManageMemoryDialog
      scope={{ kind: "global" }}
      initial={withLimits}
      readOnly
      onClose={() => {}}
    />,
  );
  assert.doesNotMatch(readOnly, /memory-edit-field/);
  assert.match(readOnly, /Manage edits/);
  // A project's memory has its own title and description.
  const project = dialog(
    <ManageMemoryDialog
      scope={{ kind: "project", projectId: "p" }}
      initial={{ ...withLimits, edits: [] }}
      onClose={() => {}}
    />,
  );
  assert.match(project, /<h2[^>]*>Manage project memory<\/h2>/);
  assert.match(project, /Only you can see this memory/);
  assert.doesNotMatch(project, /manage-memory-edits-row/);
  assert.equal(manageMemoryTitle({ kind: "global" }, "edits"), "Manage edits");
  // Loading: the box's skeleton (six lines and the pencil's circle).
  const loading = dialog(<ManageMemorySkeleton />);
  assert.equal(loading.match(/manage-memory-skeleton-line/g)?.length, 6);
  assert.match(loading, /class="sk round" style="height:56px;width:56px"/);
});

test("the edit field cycles hints and says when edits are full", () => {
  const open = renderToStaticMarkup(
    <EditField full={false} maxChars={500} onSubmit={() => {}} open />,
  );
  assert.match(open, /data-open="true"/);
  assert.match(open, /Tell Claudex what to remember or forget\.\.\./);
  // Empty: the arrow waits.
  assert.match(open, /aria-label="Submit" disabled=""/);
  const full = renderToStaticMarkup(
    <EditField full maxChars={500} onSubmit={() => {}} open />,
  );
  assert.match(full, /Maximum edits reached/);
  const closed = renderToStaticMarkup(
    <EditField full={false} maxChars={500} onSubmit={() => {}} />,
  );
  assert.doesNotMatch(closed, /data-open/);
  assert.doesNotMatch(closed, /Submit/);
});

test("Manage edits lists the edits to remove; Save changes removes what is gone", () => {
  const edits = [
    { id: "e-1", text: "Call me Sam.", createdAt: 0 },
    { id: "e-2", text: "Use metric units.", createdAt: 0 },
  ];
  const html = renderToStaticMarkup(
    <EditsList
      edits={edits}
      readOnly={false}
      updating={false}
      onBack={() => {}}
      onSave={() => {}}
    />,
  );
  assert.match(html, /Back to memory/);
  // Nothing removed yet: Clear edits, not Save changes.
  assert.match(html, /Clear edits/);
  assert.doesNotMatch(html, /Save changes/);
  assert.equal(html.match(/aria-label="Remove edit"/g)?.length, 2);
  assert.match(html, /style="height:512px"/);
  const empty = renderToStaticMarkup(
    <EditsList
      edits={[]}
      readOnly={false}
      updating={false}
      onBack={() => {}}
      onSave={() => {}}
    />,
  );
  assert.match(empty, /All edits cleared/);
  const readOnly = renderToStaticMarkup(
    <EditsList
      edits={edits}
      readOnly
      updating={false}
      onBack={() => {}}
      onSave={() => {}}
    />,
  );
  assert.doesNotMatch(readOnly, /Remove edit|Clear edits/);
  assert.deepEqual(removedEdits(edits, [edits[1]]), ["e-1"]);
  assert.deepEqual(removedEdits(edits, []), ["e-1", "e-2"]);
});

test("a save another device overtook is recognised", () => {
  const conflict = new Error(
    "Error invoking remote method 'saveMemoryDoc': Error: Memory changed on another device. Reload it and try again.",
  );
  assert.equal(isConflict(conflict), true);
  assert.equal(
    memoryError(conflict),
    "Memory changed on another device. Reload it and try again.",
  );
  assert.equal(isConflict(new Error("Memory is full.")), false);
});

test("Import memory's result page is Manage memory's view, updating while the import runs", () => {
  const props = {
    scope: { kind: "global" as const },
    view: "synthesis" as const,
    onView() {},
    onUpdate() {},
  };
  const doc = {
    content: "Likes cats.",
    updatedAt: 1,
    source: "imported" as const,
    revision: 2,
    edits: [],
  };
  const running = renderToStaticMarkup(
    <ManageMemoryContent {...props} doc={doc} updating />,
  );
  assert.match(running, /data-updating="true"/);
  assert.match(running, /Updating memory\.\.\./);
  assert.doesNotMatch(running, /Manage edits/);
  const done = renderToStaticMarkup(
    <ManageMemoryContent {...props} doc={doc} updating={false} />,
  );
  assert.match(done, /Here’s what Claudex remembers about you!/);
  assert.match(done, /Likes cats\./);
});

test("Import dialog", () => {
  // The live import modal: two numbered steps, the prompt to copy in its box
  // with Copy, the paste field, Cancel and the add button.
  const importing = dialog(<MemoryImportDialog onClose={() => {}} />);
  assert.match(importing, /Import memory/);
  assert.match(
    importing,
    /class="memory-import-step-number">1<\/span>Copy this prompt into a chat with your other AI provider/,
  );
  assert.match(
    importing,
    /role="button" tabindex="0" aria-label="Copy prompt"/,
  );
  assert.match(importing, /I&#x27;m moving to another AI assistant/);
  assert.match(
    importing,
    /<svg[^>]*data-icon="Copy"[^>]*>.*?<\/svg>Copy<\/button>/,
  );
  assert.match(
    importing,
    /class="memory-import-step-number">2<\/span><span id="[^"]+">Paste the results below to add them to Claudex’s memory/,
  );
  assert.match(importing, /<textarea aria-labelledby="[^"]+" rows="6"/);
  assert.match(importing, /placeholder="Paste your memory details here"/);
  // Nothing pasted yet.
  assert.match(importing, /disabled=""[^>]*>Add to memory<\/button>/);
  assert.match(importing, /class="secondary">Cancel<\/button>/);
});

test("Settings search finds the memory rows", () => {
  assert.deepEqual(labels.memoryLabels, [
    "Memory",
    "Search and reference chats",
    "Generate memory from chats",
    "Import memory",
  ]);
});

test("Turn off memory offers pausing or resetting", async () => {
  const { TurnOffMemoryDialog } =
    await import("../../src/settings/tabs/TurnOffMemoryDialog");
  const props = { onPause: () => {}, onReset: () => {}, onClose: () => {} };
  const html = dialog(<TurnOffMemoryDialog canReset {...props} />);
  assert.match(html, /Turn off memory/);
  assert.match(html, /<strong>Pause memory<\/strong>/);
  assert.match(html, /keeps its existing memory but won’t use memory/);
  assert.match(html, /<strong>Reset memory<\/strong>/);
  assert.match(html, /permanently delete all memories/);
  // Pause is chosen first, and confirms with its own name.
  assert.match(html, /checked="" value="pause"/);
  assert.match(html, /class="primary"[^>]*>Pause memory<\/button>/);
  // Without a reachable memory only pausing is possible.
  const offline = dialog(<TurnOffMemoryDialog canReset={false} {...props} />);
  assert.match(offline, /disabled="" name="turn-off-memory" value="reset"/);
});

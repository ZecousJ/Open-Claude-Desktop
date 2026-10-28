import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { execFileSync } from "node:child_process";
import type { Conversation, Project } from "../../shared/types";
import type { AppController } from "../../src/app/AppContext";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { SurfaceSwitch } = await import("../../src/sidebar/SurfaceSwitch");
const { WebSidebarHeader } = await import("../../src/sidebar/WebSidebarHeader");
const { ConversationRow } = await import("../../src/sidebar/ConversationRow");
const { ConversationList } = await import("../../src/sidebar/ConversationList");
const { AppContext } = await import("../../src/app/AppContext");

const noop = () => {};
const row = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  mode: "chat",
  pinned: false,
  archived: false,
  providerId: "p",
  model: "m",
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...extra,
});
const running = row("code-running", {
  mode: "code",
  turns: [
    {
      id: "turn",
      prompt: "",
      items: [],
      attachments: [],
      status: "inProgress",
      createdAt: 1,
    },
  ],
});
const markup = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  parseHTML(renderToStaticMarkup(node)).document;
const radios = (
  mode: Conversation["mode"],
  conversations: Conversation[],
  approvalIds = new Set<string>(),
  codeUnavailable?: string,
) => [
  ...markup(
    createElement(SurfaceSwitch, {
      mode,
      conversations,
      approvalIds,
      codeUnavailable,
      onSwitch: noop,
    }),
  ).querySelectorAll('[role="radio"]'),
];

test("#13 only an inactive available web surface announces its real indicator", () => {
  assert.deepEqual(
    radios("chat", [running]).map((e) => e.getAttribute("aria-label")),
    ["Claudex", "Code, working"],
  );
  assert.deepEqual(
    radios("code", [running]).map((e) => e.getAttribute("aria-label")),
    ["Claudex", "Code"],
  );
  assert.deepEqual(
    radios("code", [
      row("legacy", { ...running, id: "legacy", mode: "cowork" }),
    ]).map((e) => e.getAttribute("aria-label")),
    ["Claudex, working", "Code"],
  );
  assert.equal(
    radios("chat", [running], new Set([running.id]))[1].getAttribute(
      "aria-label",
    ),
    "Code, awaiting your input",
  );
  assert.equal(
    radios("chat", [
      row("unread", { mode: "code", unread: true }),
    ])[1].getAttribute("aria-label"),
    "Code, unread activity",
  );
  assert.equal(
    radios("chat", [running], new Set(), "Unavailable")[1].getAttribute(
      "aria-label",
    ),
    "Code",
  );
  assert.equal(
    radios("chat", [
      { ...running, archived: true },
      { ...running, id: "private", incognito: true },
    ])[1].getAttribute("aria-label"),
    "Code",
  );
});

test("#13 web sidebar head forwards actual waiting approvals", () => {
  const document = markup(
    createElement(WebSidebarHeader, {
      mode: "chat",
      conversations: [running],
      approvalIds: new Set([running.id]),
      onToggleSidebar: noop,
      onSwitch: noop,
    }),
  );
  assert.ok(
    document.querySelector(
      '[role="radio"][aria-label="Code, awaiting your input"]',
    ),
  );
});

const dragControl = {
  click: () => false,
  pointerDown: noop,
  pointerMove: noop,
  pointerUp: noop,
  pointerCancel: noop,
  lostCapture: noop,
} as unknown as ComponentProps<typeof ConversationRow>["dragControl"];
const actions = {
  onOpen: noop,
  onTogglePin: noop,
  onRename: noop,
  onMoveToProject: noop,
  onToggleArchive: noop,
  onDelete: noop,
  onToggleUnread: noop,
  onOpenIn: noop,
};
const renderRow = (conversation: Conversation) =>
  createElement(ConversationRow, {
    conversation,
    projects: [],
    selected: true,
    actions,
    onKeyboardPin: noop,
    draggable: false,
    dragControl,
    onNewGroup: noop,
  });

test("#27 Code metadata is a separate full-width row; its place mark stays after the title and grouped places are omitted", () => {
  const render = (hidePlace = false) =>
    markup(
      createElement(ConversationRow, {
        conversation: row("metadata", {
          mode: "code",
          branch: "feature/parity",
          cwd: "/work/project",
          environment: { kind: "space", spaceId: "actual-cloud" },
        }),
        projects: [],
        selected: false,
        actions,
        onKeyboardPin: noop,
        draggable: false,
        dragControl,
        onNewGroup: noop,
        codeView: {
          groupBy: "none",
          sort: "updated",
          ascending: false,
          metadata: true,
          emptyGroups: false,
        },
        hidePlace,
      }),
    );
  const document = render(),
    main = document.querySelector(".conversation-link")!,
    line = document.querySelector(".code-row-metadata")!;
  assert.ok(document.querySelector("[data-code-described]"));
  assert.equal(line.parentElement, main);
  assert.ok(!line.closest(".row-title-slot"));
  assert.equal((line as HTMLElement).style.fontSize, "13px");
  assert.equal((line as HTMLElement).style.lineHeight, "16px");
  assert.deepEqual(
    [...line.querySelectorAll("bdi")].map((e) => e.textContent),
    ["feature/parity", "project"],
  );
  assert.ok(!line.textContent?.includes(" · "));
  // A cloud session ends in the Cloud glyph; a group that names the place ends
  // bare, and so does a session on this computer (cL drops "local").
  assert.ok(
    document.querySelector('.row-status-trailing [data-env-glyph="cloud"]'),
  );
  assert.ok(main.textContent?.includes("Cloud"));
  assert.ok(!render(true).querySelector(".row-status-trailing"));
  const local = markup(
    createElement(ConversationRow, {
      conversation: row("local", { mode: "code", cwd: "/work/project" }),
      projects: [],
      selected: false,
      actions,
      onKeyboardPin: noop,
      draggable: false,
      dragControl,
      onNewGroup: noop,
      codeView: {
        groupBy: "none",
        sort: "updated",
        ascending: false,
        metadata: true,
        emptyGroups: false,
      },
    }),
  );
  assert.equal(local.querySelector(".row-status-trailing"), null);
  assert.ok(!local.documentElement.textContent?.includes("This computer"));
});

test("#27 Code activity stays in the accessible title while the visual mark shares More's hover slot", () => {
  const document = markup(
    createElement(ConversationRow, {
      conversation: running,
      projects: [],
      selected: false,
      actions,
      onKeyboardPin: noop,
      draggable: false,
      dragControl,
      onNewGroup: noop,
      codeView: {
        groupBy: "none",
        sort: "updated",
        ascending: false,
        metadata: false,
        emptyGroups: false,
      },
    }),
  );
  assert.equal(
    document.querySelector(".row-title-slot [role=status]")?.textContent,
    "Running",
  );
  assert.equal(
    document.querySelector(".row-status-trailing")?.getAttribute("aria-hidden"),
    "true",
  );
});

test("#19 web conversations expose real Chat, legacy-task and Code link targets", () => {
  for (const mode of ["chat", "cowork", "code"] as const) {
    const document = markup(
      renderRow(row(`pin-${mode}`, { mode, pinned: true })),
    );
    const link = document.querySelector("a.conversation-link")!;
    assert.equal(
      link.getAttribute("href"),
      `/${mode === "code" ? "code" : "chat"}/pin-${mode}`,
    );
    assert.equal(link.getAttribute("aria-current"), "page");
    assert.equal(document.querySelector("button.conversation-link"), null);
    assert.ok(link.hasAttribute("data-roving-item"));
    assert.ok(
      document.querySelector(
        'button[aria-label="More options for pin-' + mode + '"]',
      ),
    );
  }
});

test("#19 the actual Pinned section combines project and conversation links", async () => {
  const project: Project = {
    id: "project-pin",
    name: "Project pin",
    description: "",
    instructions: "",
    createdAt: 1,
    pinned: true,
  };
  const controller = {
    snapshot: { approvals: [] },
    report: noop,
  } as unknown as AppController;
  const render = () =>
    createElement(
      AppContext.Provider,
      { value: controller },
      createElement(ConversationList, {
        conversations: [row("chat-pin", { pinned: true })],
        projects: [project],
        mode: "chat",
        page: "chat",
        approvalIds: new Set<string>(),
        onPageChange: noop,
        onReorder: async () => {},
        onError: noop,
        ...actions,
      }),
    );
  markup(render());
  await import("../../src/sidebar/PinnedProjects");
  await new Promise((resolve) => setImmediate(resolve));
  const document = markup(render());
  const section = document.querySelector('[data-drop-section="pinned"]')!;
  assert.ok(section.querySelector('a[href="/project/project-pin"]'));
  assert.ok(section.querySelector('a[href="/chat/chat-pin"]'));
  assert.ok(
    section.querySelector(
      'button[aria-label="Toggle sessions for Project pin"]',
    ),
  );
});

test("#13/#19 desktop announces inactive activity and keeps button rows and its existing gestures", () => {
  const script = `
    globalThis.__CLAUDEX_SURFACE__='desktop';
    const {createElement}=await import('react');
    const {renderToStaticMarkup}=await import('react-dom/server');
    const {parseHTML}=await import('linkedom');
    const {SurfaceSwitch}=await import('./src/sidebar/SurfaceSwitch.tsx');
    const {ConversationRow}=await import('./src/sidebar/ConversationRow.tsx');
    const noop=()=>{};
    const c=${JSON.stringify({ ...running, pinned: true })};
    const mode=parseHTML(renderToStaticMarkup(createElement(SurfaceSwitch,{mode:'chat',conversations:[c],onSwitch:noop}))).document;
    const actions={onOpen:noop,onTogglePin:noop,onRename:noop,onMoveToProject:noop,onToggleArchive:noop,onDelete:noop,onToggleUnread:noop,onOpenIn:noop};
    const dragControl={click:()=>false,pointerDown:noop,pointerMove:noop,pointerUp:noop,pointerCancel:noop,lostCapture:noop};
    const doc=parseHTML(renderToStaticMarkup(createElement(ConversationRow,{conversation:c,projects:[],selected:true,actions,onKeyboardPin:noop,draggable:false,dragControl,onNewGroup:noop}))).document;
    console.log(JSON.stringify({labels:[...mode.querySelectorAll('[role=radio]')].map(e=>e.getAttribute('aria-label')),button:!!doc.querySelector('button.conversation-link'),links:doc.querySelectorAll('a.conversation-link').length}));
  `;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/support/css-stub.mjs",
        "--input-type=module",
        "-e",
        script,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    ),
  );
  assert.deepEqual(result, {
    labels: ["Claudex", "Code, working"],
    button: true,
    links: 0,
  });
});

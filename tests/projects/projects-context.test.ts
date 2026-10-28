import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, createRef } from "react";
import type { Conversation, Project } from "../../shared/types";
import { webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ProjectContextLayout } from "../../src/collections/projects/ProjectContextLayout";
import { KnowledgeList } from "../../src/collections/projects/KnowledgeList";
import { ProjectOverview } from "../../src/collections/projects/ProjectOverview";
import { ProjectChats } from "../../src/collections/projects/ProjectChats";
import { ProjectSearchResults } from "../../src/collections/projects/ProjectChatSearch";
import { routineDom } from "../support/routine-dom";

const chat = (id = "chat α", extra: Partial<Conversation> = {}) =>
  ({
    id,
    title: "Actual row",
    mode: "chat",
    projectId: "project",
    turns: [],
    updatedAt: Date.now() - 7200000,
    createdAt: 1,
    ...extra,
  }) as Conversation;
const project: Project = {
  id: "project",
  name: "Project",
  instructions: "",
  description: "",
  createdAt: 1,
};
async function environment(narrow = true) {
  const env = await routineDom(
    { hostedShares: async () => [] },
    { jsdom: true },
  );
  const globals = {
    innerWidth: 390,
    innerHeight: 844,
    localStorage: env.window.localStorage,
    requestAnimationFrame: env.window.requestAnimationFrame.bind(env.window),
    cancelAnimationFrame: env.window.cancelAnimationFrame.bind(env.window),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const listeners = new Set<() => void>();
  const media = {
    matches: narrow,
    addEventListener: (_: string, callback: () => void) =>
      listeners.add(callback),
    removeEventListener: (_: string, callback: () => void) =>
      listeners.delete(callback),
  };
  env.window.matchMedia = (() => media) as never;
  return {
    ...env,
    async resize(value: boolean) {
      await act(async () => {
        media.matches = value;
        listeners.forEach((callback) => callback());
      });
    },
    async clean() {
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
      await env.clean();
    },
  };
}
function layout(key = "p") {
  return h(ProjectContextLayout, {
    key,
    rail: createRef<HTMLElement>(),
    main: h("input", { "aria-label": "Draft", defaultValue: "Retained draft" }),
    children: h(KnowledgeList, {
      files: [{ name: "docs/note.md", bytes: 2, addedAt: 1 }],
      busy: false,
      onPick() {},
      onRemove() {},
    }),
  });
}

test("narrow layout keeps composer and rail visible in source order without a separate Context navigation mode", async () => {
  const env = await environment();
  try {
    await env.render(layout());
    const main = env.document.querySelector<HTMLElement>(".prj-overview-main")!;
    const aside = env.document.querySelector("aside")!;
    assert.equal(main.hidden, false);
    assert.equal(aside.hidden, false);
    assert.equal(main.parentElement, aside.parentElement);
    assert.equal(main.nextElementSibling, aside);
    assert.equal(aside.getAttribute("data-stacked"), "after");
    assert.equal(env.document.querySelector(".prj-context-trigger"), null);
    assert.equal(env.document.querySelector(".prj-context-back"), null);
    await env.change('[aria-label="Draft"]', "Edited draft");
    await env.click('[aria-label="Open folder docs"]');
    assert.match(aside.textContent ?? "", /note.md/);
    assert.equal(
      env.document.querySelector<HTMLInputElement>('[aria-label="Draft"]')
        ?.value,
      "Edited draft",
    );
  } finally {
    await env.clean();
  }
});

test("responsive reflow preserves mounted composer draft, expanded knowledge, and current focus", async () => {
  const env = await environment();
  try {
    await env.render(layout());
    const draft = env.document.querySelector<HTMLInputElement>(
      '[aria-label="Draft"]',
    )!;
    const aside = env.document.querySelector("aside")!;
    await env.change('[aria-label="Draft"]', "Retained edit");
    await env.click('[aria-label="Open folder docs"]');
    draft.focus();
    for (const narrow of [false, true]) {
      await env.resize(narrow);
      await env.render(layout());
      assert.equal(env.document.querySelector('[aria-label="Draft"]'), draft);
      assert.equal(env.document.querySelector("aside"), aside);
      assert.equal(draft.value, "Retained edit");
      assert.equal(aside.hidden, false);
      assert.equal(
        draft.closest<HTMLElement>(".prj-overview-main")?.hidden,
        false,
      );
      assert.equal(
        env.document
          .querySelector('[aria-label="Open folder docs"]')
          ?.getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(env.document.activeElement, draft);
    }
  } finally {
    await env.clean();
  }
});

test("layout adds no Escape or focus behavior around existing rail dialogs", async () => {
  const env = await environment();
  try {
    await env.render(
      h(ProjectContextLayout, {
        rail: createRef<HTMLElement>(),
        main: h("input", { "aria-label": "Composer" }),
        children: h(
          "div",
          { role: "dialog" },
          h("button", { id: "nested" }, "Nested"),
        ),
      }),
    );
    const nested = env.document.querySelector<HTMLButtonElement>("#nested")!;
    nested.focus();
    const escape = await env.event(nested, "keydown", { key: "Escape" });
    assert.equal(escape.defaultPrevented, false);
    assert.equal(env.document.activeElement, nested);
    assert.equal(env.document.querySelector("aside")?.hidden, false);
    assert.equal(
      env.document.querySelector<HTMLElement>(".prj-overview-main")?.hidden,
      false,
    );
  } finally {
    await env.clean();
  }
});

async function rows(
  extra: Partial<Conversation> = {},
  bridge: Partial<Window["desktop"]> = {},
) {
  const env = await environment(false),
    row = chat(undefined, extra);
  Object.assign(env.window.desktop, bridge);
  const patched: Array<{ row: Conversation; patch: unknown }> = [],
    renamed: unknown[] = [],
    deleted: Conversation[] = [],
    opened: Conversation[] = [],
    upserted: Conversation[] = [],
    contexts: Array<string | undefined> = [];
  const reference = { current: undefined as AppController | undefined },
    scope = {};
  let snapshot = {
    conversations: [row],
    projects: [project, { ...project, id: "destination", name: "Destination" }],
  };
  const owner = {
    accountId: "row-owner",
    controllerScope: scope,
    currentController: reference,
    snapshot,
    latest: { current: snapshot },
    report() {},
    patchConversation: async (current: Conversation, patch: unknown) => {
      patched.push({ row: current, patch });
    },
    setRename: (value: unknown) => renamed.push(value),
    confirmDelete: (value: Conversation) => deleted.push(value),
    upsert: (value: Conversation) => upserted.push(value),
    startProject() {},
    setProjectId: (id: string | undefined) => contexts.push(id),
    setCwd() {},
  } as unknown as AppController;
  if (!bridge.updateConversation)
    env.window.desktop.updateConversation = async (_id, patch) => {
      patched.push({ row, patch });
      return { ...row, ...patch } as Conversation;
    };
  reference.current = owner;
  const render = async () =>
    env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(
          AppContext.Provider,
          { value: owner },
          h(ProjectChats, {
            chats: snapshot.conversations,
            onOpen: (value) => opened.push(value),
          }),
        ),
      ),
    );
  await render();
  const menu = async () => {
    (env.document.querySelector(".prj-chat-more") as HTMLElement).focus();
    await env.click(".prj-chat-more");
    for (let i = 0; i < 30 && !env.document.querySelector('[role="menu"]'); i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    assert.ok(env.document.querySelector('[role="menu"]'));
  };
  const choose = async (label: string) => {
    const button = [
      ...env.document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((element) => {
      // Icon-font glyphs are private-use characters, not the label.
      const text = element.textContent?.replace(/[\ue000-\uf8ff]/g, "");
      return (
        text?.replace(/[A-Z]$/, "").trim() === label ||
        element.querySelector(".menu-label")?.textContent === label ||
        text?.trim() === label
      );
    });
    assert.ok(
      button,
      `${label}: ${env.document.querySelector('[role="menu"]')?.textContent}`,
    );
    await env.event(button, "click", { button: 0 });
  };
  return {
    ...env,
    row,
    owner,
    reference,
    patched,
    upserted,
    contexts,
    renamed,
    deleted,
    opened,
    menu,
    choose,
    render,
    replace(next: Conversation) {
      snapshot = { ...snapshot, conversations: [next] };
      owner.snapshot = snapshot as never;
      owner.latest.current = snapshot as never;
    },
  };
}

test("real recent rows expose canonical links, last-message time, separate actions and native modified clicks", async () => {
  const env = await rows();
  try {
    const link = env.document.querySelector("a.prj-chat-row")!;
    assert.equal(link.getAttribute("href"), "/chat/chat%20%CE%B1");
    assert.ok(link.querySelector(".prj-chat-time")?.textContent);
    assert.equal(
      link.textContent?.includes("Last message"),
      false,
      "the live session table uses a date, unlike search-result snippets",
    );
    assert.equal(link.querySelector("button"), null);
    const modified = await env.event(link, "click", {
      button: 0,
      ctrlKey: true,
    });
    assert.equal(modified.defaultPrevented, false);
    assert.equal(env.opened.length, 0);
    const plain = await env.event(link, "click", { button: 0 });
    assert.equal(plain.defaultPrevented, true);
    assert.deepEqual(env.opened, [env.row]);
    await env.menu();
    assert.equal(env.opened.length, 1);
  } finally {
    await env.clean();
  }
});

test("actual Pin reads the latest record and the menu restores trigger focus", async () => {
  const env = await rows();
  try {
    await env.menu();
    const current = { ...env.row, pinned: true, title: "Latest title" };
    env.replace(current);
    await env.choose("Pin");
    assert.deepEqual(env.patched, [{ row: current, patch: { pinned: false } }]);
    assert.ok(
      env.document.activeElement ===
        env.document.querySelector(".prj-chat-more"),
    );
  } finally {
    await env.clean();
  }
});

test("real Rename, Remove from project, cowork Archive and Delete call existing controller operations without opening the row", async () => {
  const env = await rows({ mode: "cowork" });
  try {
    await env.menu();
    await env.choose("Rename");
    assert.deepEqual(env.renamed, [{ id: env.row.id, title: env.row.title }]);
    await env.menu();
    await env.choose("Remove from project");
    assert.deepEqual(env.patched.at(-1)?.patch, { projectId: null });
    await env.menu();
    await env.choose("Archive");
    assert.deepEqual(env.patched.at(-1)?.patch, { archived: true });
    await env.menu();
    await env.choose("Delete");
    assert.deepEqual(env.deleted, [env.row]);
    assert.equal(env.opened.length, 0);
  } finally {
    await env.clean();
  }
});

for (const retirement of [
  "account",
  "controller",
  "bridge",
  "deleted",
  "moved",
] as const)
  test(`retained row menu rejects ${retirement} before a mutation`, async () => {
    const env = await rows();
    try {
      await env.menu();
      if (retirement === "account")
        env.reference.current = { ...env.owner, accountId: "other" };
      if (retirement === "controller")
        env.reference.current = { ...env.owner, controllerScope: {} };
      if (retirement === "bridge")
        env.window.desktop = { ...env.window.desktop };
      if (retirement === "deleted")
        env.owner.latest.current = { ...env.owner.snapshot, conversations: [] };
      if (retirement === "moved")
        env.replace({ ...env.row, projectId: "destination" });
      await env.choose("Pin");
      assert.deepEqual(env.patched, []);
    } finally {
      await env.clean();
    }
  });

test("search rows keep highlights and canonical links; a result without a current snapshot keeps native navigation", async () => {
  const env = await environment(false);
  try {
    await env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(ProjectSearchResults, {
          query: "Actual",
          pending: false,
          results: [
            {
              conversationId: "code/id",
              mode: "code",
              title: "Actual code",
              snippet: "Actual content",
              updatedAt: Date.now(),
              archived: false,
            },
          ],
          onOpen: () => false as const,
        }),
      ),
    );
    const link = env.document.querySelector("a.prj-search-result")!;
    assert.equal(link.getAttribute("href"), "/code/code%2Fid");
    assert.equal(link.querySelector("strong")?.textContent, "Actual");
    assert.equal(
      (await env.event(link, "click", { button: 0 })).defaultPrevented,
      false,
    );
    assert.equal(env.document.querySelector(".prj-chat-more"), null);
  } finally {
    await env.clean();
  }
});

test("a null sharing capability never reads or offers a conversation share", async () => {
  let reads = 0;
  const env = await rows(
    {},
    {
      sharingStatus: async () => null,
      conversationShare: async () => {
        reads++;
        return null;
      },
    },
  );
  try {
    await env.menu();
    assert.equal(reads, 0);
    assert.equal(
      [...env.document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent?.trim() === "Share",
      ),
      false,
    );
  } finally {
    await env.clean();
  }
});

test("Copy link rechecks its real share and never copies a revoked link", async () => {
  const copied: string[] = [];
  let active = true;
  const share = {
    id: "share",
    kind: "conversation" as const,
    sourceKey: "chat α",
    title: "Actual row",
    url: "https://example.test/s/live",
    createdAt: 1,
    snapshotAt: 1,
    status: "active" as const,
  };
  const env = await rows(
    {},
    {
      sharingStatus: async () => ({
        conversations: true,
        artifacts: false,
        maxSnapshotBytes: 1000,
        maxArtifactBytes: 1000,
      }),
      conversationShare: async () => (active ? share : null),
      copyText: async (text) => {
        copied.push(text);
      },
    },
  );
  try {
    await env.menu();
    await env.choose("Copy link");
    assert.deepEqual(copied, [share.url]);
    await env.menu();
    active = false;
    await env.choose("Copy link");
    assert.deepEqual(copied, [share.url]);
  } finally {
    await env.clean();
  }
});

test("Share opens the existing dialog without opening the conversation", async () => {
  const env = await rows(
    {},
    {
      sharingStatus: async () => ({
        conversations: true,
        artifacts: false,
        maxSnapshotBytes: 1000,
        maxArtifactBytes: 1000,
      }),
      conversationShare: async () => null,
    },
  );
  try {
    await env.menu();
    await env.choose("Share");
    for (
      let i = 0;
      i < 40 && !env.document.querySelector('[role="dialog"]');
      i++
    )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    assert.equal(
      env.document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
      "Share session",
    );
    assert.equal(env.opened.length, 0);
    await env.click('[role="dialog"] [aria-label="Close"]');
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
  } finally {
    await env.clean();
  }
});

test("responsive reflow keeps an existing rail dialog visible and preserves its focus", async () => {
  const env = await environment(false);
  try {
    await env.render(
      h(ProjectContextLayout, {
        rail: createRef<HTMLElement>(),
        main: "Main",
        children: h(
          "div",
          { role: "dialog" },
          h("button", { id: "nested-dialog-control" }, "Nested"),
        ),
      }),
    );
    const button = env.document.querySelector<HTMLElement>(
      "#nested-dialog-control",
    )!;
    button.focus();
    await env.resize(true);
    assert.equal(env.document.querySelector("aside")?.hidden, false);
    assert.ok(env.document.activeElement === button);
  } finally {
    await env.clean();
  }
});

for (const retired of [false, true])
  test(`a project move response after menu close ${retired ? "rejects a retired owner" : "updates the current row and draft context"}`, async () => {
    let release!: (value: Conversation) => void;
    const gate = new Promise<Conversation>((resolve) => (release = resolve));
    const env = await rows({}, { updateConversation: async () => gate });
    try {
      env.owner.activeId = env.row.id;
      await env.menu();
      await env.choose("Remove from project");
      assert.equal(env.document.querySelector('[role="menu"]'), null);
      if (retired)
        env.reference.current = { ...env.owner, accountId: "replacement" };
      const response = { ...env.row, projectId: undefined };
      await act(async () => release(response));
      assert.deepEqual(env.upserted, retired ? [] : [response]);
      assert.deepEqual(env.contexts, retired ? [] : [undefined]);
    } finally {
      await env.clean();
    }
  });

test("the real narrow web overview keeps composer and hub mounted while Show context uses the existing dialog", async () => {
  const env = await environment(true);
  Object.assign(env.window.desktop, {
    memoryStatus: async () => ({
      available: false,
      reason: "unsupported",
      allowed: { searchChats: true, generate: true },
      prefs: { searchChats: true, generate: true },
      synthesizing: false,
    }),
    listProjectKnowledge: async () => ({
      files: [{ name: "actual.md", bytes: 2, addedAt: 1 }],
      bytes: 2,
      limit: 1000,
      fileLimit: 1000,
    }),
  });
  try {
    await env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(ProjectOverview, {
          project,
          chats: [],
          composer: h("textarea", {
            "aria-label": "Actual project composer",
            defaultValue: "Draft stays",
          }),
          menuOpen: false,
          onBack() {},
          onMenu() {},
          onSave: async () => {},
          onScheduled() {},
          onOpenConversation() {},
        }),
      ),
    );
    for (
      let i = 0;
      i < 40 && !env.document.querySelector('[aria-label="Show context"]');
      i++
    )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    assert.equal(env.document.querySelector("aside")?.hidden, false);
    assert.equal(env.document.querySelectorAll(".prj-hub-card").length, 3);
    assert.match(
      env.document.querySelector("aside")?.textContent ?? "",
      /1 file/,
    );
    const composer = env.document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Actual project composer"]',
    )!;
    assert.equal(
      composer.closest<HTMLElement>(".prj-overview-main")?.hidden,
      false,
    );
    assert.equal(env.document.querySelector(".prj-context-trigger"), null);
    assert.equal(env.document.querySelector(".prj-context-back"), null);
    await env.change(
      '[aria-label="Actual project composer"]',
      "Edited project draft",
    );
    const trigger = env.document.querySelector<HTMLButtonElement>(
      '[aria-label="Show context"]',
    )!;
    await env.click('[aria-label="Show context"]');
    assert.equal(
      env.document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
      "Context",
    );
    assert.ok(
      env.document.querySelector(
        '[role="dialog"] button[aria-label="actual.md"]',
      ),
    );
    await env.resize(false);
    await env.resize(true);
    assert.equal(
      env.document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
      "Context",
    );
    assert.equal(
      env.document.querySelector('[aria-label="Actual project composer"]'),
      composer,
    );
    assert.equal(composer.value, "Edited project draft");
    assert.equal(
      composer.closest<HTMLElement>(".prj-overview-main")?.hidden,
      false,
    );
    assert.equal(env.document.querySelector("aside")?.hidden, false);
    await env.click('[role="dialog"] [aria-label="Close"]');
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.equal(composer.value, "Edited project draft");
    assert.equal(env.document.activeElement, trigger);
  } finally {
    await env.clean();
  }
});

test("actual project row menu shows captured icons and single-key shortcuts, and P operates without opening the conversation", async () => {
  const env = await rows();
  try {
    await env.menu();
    assert.deepEqual(
      [...env.document.querySelectorAll('[role="menu"] kbd')].map(
        (e) => e.textContent,
      ),
      ["P", "R", "D"],
    );
    assert.equal(
      env.document.querySelectorAll(
        '[role="menuitem"] .menu-icon :is(svg, [data-icon])',
      ).length,
      5,
    );
    await env.event(env.document.querySelector('[role="menu"]')!, "keydown", {
      key: "p",
    });
    assert.equal(env.opened.length, 0);
    assert.deepEqual(
      env.patched.map((change) => change.patch),
      [{ pinned: true }],
    );
  } finally {
    await env.clean();
  }
});

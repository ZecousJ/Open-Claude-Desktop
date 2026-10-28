import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { parseHTML } from "linkedom";
import type { CustomizeSkill } from "../../shared/collections-api";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import { AppContext, type AppController } from "../../src/app/AppContext";
import {
  callableSkills,
  editSkillTokens,
  insertSkillToken,
  prependSkillDraft,
  validSkillTokens,
} from "../../src/composer/skill-tokens";
import { useSkillDraft } from "../../src/composer/useSkillDraft";
import {
  draftPlace,
  readDraft,
  writeDraft,
  resetDraftMemory,
  forgetAccountDrafts,
  usePlacedDraft,
  type DraftStorage,
} from "../../src/composer/draft-store";
import { skillMessage } from "../../src/composer/code/code-slash-commands";

const skill = (
  name: string,
  extra: Partial<CustomizeSkill> = {},
): CustomizeSkill => ({
  name,
  description: `Description of ${name}`,
  path: `/runtime/skills/${name}/SKILL.md`,
  scope: "user",
  enabled: true,
  own: true,
  ...extra,
});
class Storage implements DraftStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("only enabled, unambiguous runtime identities supported by the real $name protocol are callable", () => {
  assert.deepEqual(
    callableSkills([
      skill("off", { enabled: false }),
      skill("repeat"),
      skill("repeat", { path: "/another/SKILL.md" }),
      skill("unsupported name"),
      skill("unsafe\ncommand"),
      skill("missing", { path: "" }),
      skill("anthropic-skills:docs"),
      skill("actual-enabled"),
    ]).map((entry) => entry.name),
    ["actual-enabled", "anthropic-skills:docs"],
  );
});

test("skill insertion uses the existing transport spelling at the actual selection without sending", () => {
  const inserted = insertSkillToken(
    "Before chosen after",
    [],
    "actual-enabled",
    7,
    13,
  )!;
  assert.equal(
    inserted.text,
    `Before ${skillMessage("actual-enabled", "")}  after`,
  );
  assert.equal(
    inserted.text.slice(
      inserted.skillTokens[0]!.start,
      inserted.skillTokens[0]!.end,
    ),
    "$actual-enabled",
  );
  assert.equal(inserted.caret, inserted.skillTokens[0]!.end + 1);
  assert.equal(insertSkillToken("", [], "bad name", 0), undefined);
  const second = insertSkillToken(
    inserted.text,
    inserted.skillTokens,
    "another",
    inserted.text.length,
  )!;
  assert.equal(second.skillTokens.length, 2);
});

test("text edits shift intact atomic references and drop edited or deleted ones, including IME text", () => {
  const original = insertSkillToken("", [], "review", 0)!;
  const moved = editSkillTokens(
    original.text,
    `中文 ${original.text}`,
    original.skillTokens,
  );
  assert.deepEqual(moved, [{ name: "review", start: 3, end: 10 }]);
  assert.deepEqual(
    editSkillTokens(original.text, "$revise ", original.skillTokens),
    [],
  );
  assert.deepEqual(
    editSkillTokens(original.text, "$reviewer ", original.skillTokens),
    [],
    "extending the raw name cannot retain a reference to the old skill",
  );
  assert.deepEqual(
    editSkillTokens(
      original.text,
      `prefix${original.text}`,
      original.skillTokens,
    ),
    [],
    "removing a separating boundary cannot leave an in-word reference",
  );
  assert.deepEqual(
    editSkillTokens(original.text, "", original.skillTokens),
    [],
  );
  assert.deepEqual(
    validSkillTokens("$review ", [
      { name: "review", start: 0, end: 7, path: "/private/SKILL.md" },
      { name: "other", start: 0, end: 7 },
    ]),
    [{ name: "review", start: 0, end: 7 }],
  );
});

test("normal skill drafts persist per account while incognito and pane references remain memory-only", () => {
  resetDraftMemory();
  const storage = new Storage();
  const inserted = insertSkillToken("", [], "review", 0)!;
  const normal = draftPlace({ mode: "chat" });
  writeDraft("owner", normal, { ...inserted, attachments: [] }, storage);
  assert.equal(
    [...storage.values.values()].some((raw) => raw.includes("/runtime/")),
    false,
  );
  resetDraftMemory();
  assert.deepEqual(readDraft("owner", normal, storage), {
    text: "$review ",
    attachments: [],
    skillTokens: inserted.skillTokens,
  });
  assert.equal(readDraft("another", normal, storage), undefined);
  for (const place of [
    draftPlace({ mode: "chat", incognito: true }),
    draftPlace({ mode: "chat", pane: "pane" }),
  ]) {
    const before = storage.length;
    writeDraft("owner", place, { ...inserted, attachments: [] }, storage);
    assert.equal(storage.length, before);
    assert.equal(readDraft("owner", place, storage)?.skillTokens?.length, 1);
    resetDraftMemory();
    assert.equal(readDraft("owner", place, storage), undefined);
  }
  forgetAccountDrafts("owner", storage);
  assert.equal(storage.length, 0);
});

test("queue editing prepends both real command text and validated token ranges", () => {
  const queued = insertSkillToken("", [], "queued", 0)!;
  const current = insertSkillToken("", [], "current", 0)!;
  const next = prependSkillDraft(queued, current);
  assert.equal(next.text, "$queued \n$current ");
  assert.deepEqual(
    next.skillTokens.map((token) => next.text.slice(token.start, token.end)),
    ["$queued", "$current"],
  );
  assert.deepEqual(
    prependSkillDraft(queued, { text: "   " }).skillTokens,
    queued.skillTokens,
  );
});

async function environment(
  run: (env: {
    window: Window & typeof globalThis;
    document: Document;
    render(element: ReactElement): Promise<void>;
    click(selector: string): Promise<void>;
    settle(): Promise<void>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.innerWidth = 1440;
  window.innerHeight = 900;
  window.desktop = {
    customizeSkills: async () => [],
    listDesignSystems: async () => [],
    setSkillEnabled: assert.fail,
    send: assert.fail,
  } as never;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 100,
    top: 200,
    right: 326,
    bottom: 451,
    width: 226,
    height: 251,
    x: 100,
    y: 200,
    toJSON() {},
  });
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    getComputedStyle: () => ({ overflow: "visible", overflowX: "visible" }),
    requestAnimationFrame: () => 1,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    await run({
      window: window as never,
      document,
      render: (element) => act(async () => root.render(element)),
      click: async (selector) => {
        const node = document.querySelector<HTMLElement>(selector);
        assert.ok(node, selector);
        await act(async () => node.click());
        await settle();
      },
      settle,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}
const unexpectedSkill = () =>
  assert.fail("A menu read must not invoke a skill");
function menu(
  onSkill: (value: CustomizeSkill) => void = unexpectedSkill,
  accountId = "owner",
  onBrowseSkills?: () => void,
) {
  return createElement(
    AppContext.Provider,
    { value: { accountId, snapshot: { settings: {} } } as AppController },
    createElement(ComposerAddMenu, {
      presentation: "web-chat",
      platform: "darwin",
      projects: [],
      webSearch: false,
      webSearchAvailable: false,
      onWebSearch() {},
      onClose() {},
      onFiles() {},
      onSkill,
      onBrowseSkills,
      onProject() {},
      onCreateProject() {},
      onSettings() {},
      onUnavailable() {},
    }),
  );
}

test("actual Skills menu separates pending, bridge failure, retry and a settled empty response", async () => {
  await environment(async ({ window, document, render, click, settle }) => {
    let reject!: (error: Error) => void;
    let requests = 0;
    window.desktop.customizeSkills = () => {
      requests++;
      return new Promise((_, fail) => {
        reject = fail;
      });
    };
    await render(menu());
    await click('[data-add-branch="skills"]');
    assert.equal(
      document
        .querySelector('[data-add-panel="skills"]')
        ?.getAttribute("data-add-state"),
      "pending",
    );
    assert.ok(document.querySelector('[role="status"][aria-label="Loading"]'));
    await act(async () => reject(Error("Actual skill bridge refusal")));
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Something went wrong/,
    );
    assert.doesNotMatch(
      document.querySelector('[role="alert"]')!.textContent!,
      /Actual skill bridge refusal/,
    );
    window.desktop.customizeSkills = async () => {
      requests++;
      return [];
    };
    await click('[role="alert"] button');
    await settle();
    assert.equal(requests, 2);
    assert.equal(
      document
        .querySelector('[data-add-panel="skills"]')
        ?.getAttribute("data-add-state"),
      "empty",
    );
    assert.equal(
      document.querySelector('[role="alert"], [role="status"]'),
      null,
    );
    assert.match(
      document.querySelector('[data-add-panel="skills"]')!.textContent!,
      /Manage skills/,
    );
  });
});

test("actual skill row inserts the enabled identity through its callback without installation changes or sending", async () => {
  await environment(async ({ window, document, render, click }) => {
    window.desktop.customizeSkills = async () => [
      skill("off", { enabled: false }),
      skill("repeat"),
      skill("repeat", { path: "/second/SKILL.md" }),
      skill("actual"),
    ];
    const chosen: string[] = [];
    await render(menu((value) => chosen.push(value.name)));
    await click('[data-add-branch="skills"]');
    const rows = [
      ...document.querySelectorAll('[data-add-panel="skills"] button'),
    ];
    assert.deepEqual(
      rows.map(
        (row) => row.querySelector("span:not([aria-hidden])")?.textContent,
      ),
      ["actual", "Manage skills"],
    );
    assert.ok(rows.every((row) => row.getAttribute("role") === "menuitem"));
    assert.equal(
      document.querySelector(
        '[data-add-panel="skills"] [role="menuitemcheckbox"]',
      ),
      null,
    );
    await click('[data-add-panel="skills"] button');
    assert.deepEqual(chosen, ["actual"]);
  });
});

test("a late previous-account skills response cannot replace the current account's menu", async () => {
  await environment(async ({ window, document, render, click }) => {
    let first!: (value: CustomizeSkill[]) => void;
    window.desktop.customizeSkills = () =>
      new Promise((resolve) => {
        first = resolve;
      });
    await render(menu(unexpectedSkill, "old"));
    await click('[data-add-branch="skills"]');
    window.desktop.customizeSkills = async () => [skill("current")];
    await render(menu(unexpectedSkill, "new"));
    await act(async () => first([skill("previous-private")]));
    assert.match(
      document.querySelector('[data-add-panel="skills"]')!.textContent!,
      /current/,
    );
    assert.doesNotMatch(document.body.textContent!, /previous-private/);
  });
});

test("the source Browse skills footer delegates only to its real directory callback", async () => {
  await environment(async ({ document, render, click }) => {
    let browsed = 0;
    await render(
      menu(unexpectedSkill, "owner", () => {
        browsed++;
      }),
    );
    await click('[data-add-branch="skills"]');
    const browse = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-add-panel="skills"] button',
      ),
    ].find((button) => button.textContent?.endsWith("Browse skills"));
    assert.ok(browse);
    await act(async () => browse.click());
    assert.equal(browsed, 1);
  });
});

test("the real atomic draft hook handles programmatic edits and failed-send restoration together", async () => {
  await environment(async ({ render }) => {
    let live!: ReturnType<typeof useSkillDraft>;
    function Harness() {
      live = useSkillDraft();
      return null;
    }
    await render(createElement(Harness));
    const selected = insertSkillToken("", [], "actual", 0)!;
    await act(async () => {
      live.setText(selected.text);
      live.setSkillTokens(selected.skillTokens);
    });
    assert.deepEqual(live.skillTokens, selected.skillTokens);
    await act(async () => live.setText((value) => `Prefix ${value}`));
    assert.equal(live.skillTokens[0]!.start, 7);
    const saved = { text: live.text, skillTokens: live.skillTokens };
    await act(async () => live.setText(""));
    assert.deepEqual(live.skillTokens, []);
    await act(async () => {
      live.setText(saved.text);
      live.setSkillTokens(saved.skillTokens);
    });
    assert.deepEqual(live.skillTokens, saved.skillTokens);
  });
});

test("actual placed drafts restore skill references across conversations without crossing account boundaries", async () => {
  resetDraftMemory();
  await environment(async ({ render }) => {
    let live!: ReturnType<typeof useSkillDraft>;
    const attachments: [] = [];
    function Harness({ owner, id }: { owner: string; id?: string }) {
      live = useSkillDraft();
      usePlacedDraft({
        owner,
        place: draftPlace({ mode: "chat", conversationId: id }),
        ...live,
        attachments,
        setAttachments() {},
      });
      return null;
    }
    const selected = insertSkillToken("", [], "review", 0)!;
    await render(createElement(Harness, { owner: "first" }));
    await act(async () => {
      live.setText(selected.text);
      live.setSkillTokens(selected.skillTokens);
    });
    await render(createElement(Harness, { owner: "first", id: "other" }));
    assert.equal(live.text, "");
    assert.deepEqual(live.skillTokens, []);
    await act(async () => live.setText("Other conversation draft"));
    await render(createElement(Harness, { owner: "first" }));
    assert.equal(live.text, selected.text);
    assert.deepEqual(live.skillTokens, selected.skillTokens);
    await render(createElement(Harness, { owner: "second" }));
    assert.equal(live.text, "");
    assert.deepEqual(live.skillTokens, []);
    await render(createElement(Harness, { owner: "first" }));
    assert.equal(live.text, selected.text);
    assert.deepEqual(live.skillTokens, selected.skillTokens);
  });
});

test("Design system loading and retry remain independent of an already loaded Skills list", async () => {
  await environment(async ({ window, document, render, click }) => {
    let reject!: (error: Error) => void;
    window.desktop.customizeSkills = async () => [skill("actual")];
    window.desktop.listDesignSystems = () =>
      new Promise((_, fail) => {
        reject = fail;
      });
    await render(menu());
    await click('[data-add-branch="design"]');
    assert.equal(
      document
        .querySelector('[data-add-panel="design"]')
        ?.getAttribute("data-add-state"),
      "pending",
    );
    await act(async () => reject(Error("Actual design bridge refusal")));
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Design systems couldn’t be loaded\. Refresh to try again\./,
    );
    assert.doesNotMatch(
      document.querySelector('[role="alert"]')!.textContent!,
      /Actual design bridge refusal/,
    );
    window.desktop.listDesignSystems = async () => [];
    await click('[role="alert"] button');
    assert.equal(
      document
        .querySelector('[data-add-panel="design"]')
        ?.getAttribute("data-add-state"),
      "empty",
    );
    await click('[data-add-branch="skills"]');
    assert.equal(
      document
        .querySelector('[data-add-panel="skills"]')
        ?.getAttribute("data-add-state"),
      "loaded",
    );
    assert.match(
      document.querySelector('[data-add-panel="skills"]')!.textContent!,
      /actual/,
    );
  });
});

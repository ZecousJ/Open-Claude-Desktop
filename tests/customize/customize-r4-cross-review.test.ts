import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { webHost, resolveHost } from "../../shared/host";
import type { DesktopAPI } from "../../shared/types";
import type {
  CustomizeSkill,
  SkillContents,
} from "../../shared/collections-api";
import { setLocale } from "../../src/i18n";
import { startDomTranslation } from "../../src/i18n/dom";

const params = () => new URLSearchParams("skills=some");
const base = "/customize/skills/yours";
const detail = (name: string, contents = false) =>
  `${base}/id/${encodeURIComponent(name)}${contents ? "/contents" : ""}`;
const deferred = <T>() => {
  let finish!: (value: T) => void, fail!: (reason: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, finish, fail };
};

async function realRoute() {
  // Render the actual module and its imports; no copied route or synthetic
  // import list that can silently omit a newly added production hook.
  return (await import("../../src/app/CollectionPages")).CustomizeRoute;
}

async function fixture(
  address: string,
  run: (f: {
    bridge: DesktopAPI;
    document: Document;
    url(): string;
    confirms: { action: () => Promise<void> }[];
    click(selector: string): Promise<void>;
    pop(path: string): Promise<void>;
    dispatchPop(path: string): void;
    hash(hash: string): Promise<void>;
    flush(): Promise<void>;
    switchAccount(accountId: string, bridge: DesktopAPI): Promise<void>;
  }) => Promise<void>,
  configure?: (bridge: DesktopAPI) => void,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const location = new URL(address, "http://customize-cross.test");
  let historyState: unknown = { claudex: 1 };
  const history = {
    get state() {
      return historyState;
    },
    pushState(value: unknown, _title: string, destination: string) {
      historyState = value;
      location.href = new URL(destination, location).href;
    },
    replaceState(value: unknown, _title: string, destination: string) {
      historyState = value;
      location.href = new URL(destination, location).href;
    },
  };
  const bridge = createFixtureDesktop({}, params());
  configure?.(bridge);
  Object.assign(window, {
    desktop: bridge,
    location,
    history,
    innerWidth: 1440,
    innerHeight: 900,
  });
  let focused: HTMLElement | undefined;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 20,
    y: 50,
    top: 50,
    bottom: 82,
    left: 20,
    right: 52,
    width: 32,
    height: 32,
    toJSON() {},
  });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused,
  });
  const globals = {
    window,
    document,
    location,
    history,
    navigator: { userAgent: "node-test", language: "en-US" },
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Element: window.Element,
    Event: window.Event,
    MutationObserver: window.MutationObserver,
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ overflow: "visible", overflowX: "visible" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const before = new Map(
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
  const confirms: { action: () => Promise<void> }[] = [];
  const flush = async () => {
    for (let i = 0; i < 8; i++)
      await act(async () => new Promise((resolve) => setImmediate(resolve)));
  };
  try {
    const Route = await realRoute();
    let app = {
      accountId: "cross-review-account",
      snapshot: await bridge.snapshot(),
      openSettingsTab() {},
      newChat() {},
      setText() {},
      report(error: unknown) {
        throw error;
      },
      setConfirm: (value: { action: () => Promise<void> }) =>
        confirms.push(value),
    } as unknown as AppController;
    const mount = () =>
      act(async () =>
        root.render(
          createElement(
            HostContext.Provider,
            {
              value: resolveHost("web", app.snapshot.host),
              key: app.accountId,
            },
            createElement(
              AppContext.Provider,
              { value: app },
              createElement(Route),
            ),
          ),
        ),
      );
    await mount();
    await flush();
    await run({
      bridge,
      document,
      confirms,
      flush,
      url: () => location.pathname + location.hash,
      click: async (selector) => {
        const node = document.querySelector<
          HTMLButtonElement | HTMLAnchorElement
        >(selector);
        assert.ok(node, selector);
        await act(async () => node.click());
        await flush();
      },
      pop: async (path) => {
        location.href = new URL(path, location).href;
        await act(async () =>
          window.dispatchEvent(new window.Event("popstate")),
        );
        await flush();
      },
      dispatchPop: (path) => {
        location.href = new URL(path, location).href;
        window.dispatchEvent(new window.Event("popstate"));
      },
      hash: async (hash) => {
        location.hash = hash;
        await act(async () =>
          window.dispatchEvent(new window.Event("hashchange")),
        );
        await flush();
      },
      switchAccount: async (accountId, next) => {
        window.desktop = next;
        app = { ...app, accountId, snapshot: await next.snapshot() };
        await mount();
        await flush();
      },
    });
  } finally {
    await act(() => root.unmount());
    for (const [key, value] of before) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("review: createFixtureDesktop whole bridge keeps each Customize skill's real contents and mutations coherent", async () => {
  const bridge = createFixtureDesktop({}, params());
  const list = await bridge.customizeSkills();
  const skill = list.find((item) => item.name === "release-notes")!;
  assert.ok(skill);
  const contents = await bridge.readSkill(skill.path);
  assert.match(contents.markdown, /release-notes/);
  assert.doesNotMatch(contents.markdown, /# Skill Creator/);
  await bridge.setSkillEnabled(skill.path, false);
  assert.equal(
    (await bridge.customizeSkills()).find((item) => item.path === skill.path)
      ?.enabled,
    false,
  );
  await assert.rejects(bridge.readSkillFile(skill.path, "../private.txt"));
  await assert.rejects(bridge.readSkill("/not/a/listed/skill/SKILL.md"));
  await bridge.deleteSkill(skill.path);
  assert.equal(
    (await bridge.customizeSkills()).some((item) => item.path === skill.path),
    false,
  );
  const legacy = (await bridge.listSkills()).flatMap((group) => group.skills);
  const sameNameDifferentPath = legacy.find((item) => item.name === skill.name);
  assert.ok(sameNameDifferentPath);
  assert.notEqual(sameNameDifferentPath.path, skill.path);
  assert.ok(
    (await bridge.listSkills())
      .flatMap((group) => group.skills)
      .some((item) => item.path === sameNameDifferentPath.path),
    "deleting a Customize path cannot remove another store’s same-name skill",
  );
  const shared = list.find((item) =>
    legacy.some((old) => old.path === item.path),
  )!;
  assert.ok(
    shared,
    "the fixture genuinely contains an overlapping system path",
  );
  assert.match(
    (await bridge.readSkill(shared.path)).markdown,
    /^# Skill Creator/,
    "the pre-existing Settings sample remains the owner of its known read path",
  );
  await bridge.setSkillEnabled(shared.path, false);
  assert.equal(
    (await bridge.customizeSkills()).find((item) => item.path === shared.path)
      ?.enabled,
    false,
  );
  assert.equal(
    (await bridge.listSkills())
      .flatMap((group) => group.skills)
      .find((item) => item.path === shared.path)?.enabled,
    false,
    "overlapping system paths reflect one toggle in both real assembled stores",
  );
});

test("review: full page follows Contents, Settings hash, popstate and Your skills with the assembled fixture bridge", async () => {
  await fixture(
    detail("release-notes") + "#settings/data-privacy-controls",
    async ({ click, document, url, pop, hash }) => {
      assert.equal(
        document.querySelector(".installed-skill-page h2")?.textContent,
        "release-notes",
      );
      assert.equal(document.querySelector('[role="dialog"]'), null);
      await click('.installed-skill-tabs a[href$="/contents"]');
      assert.equal(
        url(),
        detail("release-notes", true) + "#settings/data-privacy-controls",
      );
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /release-notes/,
      );
      await hash("#settings/general");
      assert.equal(
        document
          .querySelector('.installed-skill-tabs [aria-current="page"]')
          ?.getAttribute("href"),
        detail("release-notes", true),
      );
      await pop(detail("sql-review", true) + "#settings/general");
      assert.equal(
        document.querySelector(".installed-skill-page h2")?.textContent,
        "sql-review",
      );
      assert.doesNotMatch(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /release-notes/,
      );
      await click(".installed-skill-back");
      assert.equal(url(), base + "#settings/general");
      assert.equal(document.querySelector(".installed-skill-page"), null);
    },
  );
});

test("review: a completed A removal cannot close the B skill opened while deletion was pending", async () => {
  const deletion = deferred<void>();
  await fixture(
    detail("release-notes"),
    async ({ click, document, confirms, pop, url, flush }) => {
      await click(".installed-skill-more");
      const remove = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button'),
      ].find((item) => item.textContent?.trim() === "Remove")!;
      assert.ok(remove);
      await act(async () => remove.click());
      assert.equal(confirms.length, 1);
      let operation!: Promise<void>;
      await act(async () => {
        operation = confirms[0].action();
      });
      await pop(detail("sql-review"));
      assert.equal(
        document.querySelector(".installed-skill-page h2")?.textContent,
        "sql-review",
      );
      await act(async () => {
        deletion.finish();
        await operation;
      });
      await flush();
      assert.equal(
        url(),
        detail("sql-review"),
        "finishing A must not navigate away from B",
      );
      assert.equal(
        document.querySelector(".installed-skill-page h2")?.textContent,
        "sql-review",
      );
    },
    (bridge) => {
      const remove = bridge.deleteSkill.bind(bridge);
      bridge.deleteSkill = async (path) => {
        await deletion.promise;
        await remove(path);
      };
    },
  );
});

test("review: out-of-order A and B toggle catalogue reads cannot restore B's stale enabled value", async () => {
  const catalogues: ReturnType<typeof deferred<CustomizeSkill[]>>[] = [];
  let source!: () => Promise<CustomizeSkill[]>;
  let reads = 0;
  await fixture(
    detail("release-notes"),
    async ({ document, click, pop, flush }) => {
      await click('[role="switch"]');
      assert.equal(catalogues.length, 1);
      await pop(detail("sql-review"));
      await click('[role="switch"]');
      assert.equal(catalogues.length, 2);
      const latest = await source();
      assert.equal(
        latest.find((skill) => skill.name === "sql-review")?.enabled,
        false,
      );
      await act(async () => catalogues[1].finish(latest));
      await flush();
      assert.equal(
        document.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
        "false",
      );
      const stale = latest.map((skill) =>
        skill.name === "sql-review" ? { ...skill, enabled: true } : skill,
      );
      await act(async () => catalogues[0].finish(stale));
      await flush();
      assert.equal(
        document.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
        "false",
        "older catalogue response must not roll back a later completed toggle",
      );
    },
    (bridge) => {
      source = bridge.customizeSkills.bind(bridge);
      bridge.customizeSkills = () => {
        if (++reads === 1) return source();
        const value = deferred<CustomizeSkill[]>();
        catalogues.push(value);
        return value.promise;
      };
    },
  );
});

test("review: late A contents and file reads never replace B's selected reader", async () => {
  const aContents = deferred<SkillContents>();
  const aFile = deferred<{
    text: string;
    binary: boolean;
    truncated: boolean;
  }>();
  const body = (name: string): SkillContents => ({
    markdown: name + "_BODY",
    files: [
      { path: "SKILL.md", bytes: 8 },
      { path: "notes.txt", bytes: 8 },
    ],
    truncated: false,
  });
  await fixture(
    detail("release-notes", true),
    async ({ document, pop, flush }) => {
      await pop(detail("sql-review", true));
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /B_BODY/,
      );
      await act(async () => aContents.finish(body("A")));
      await flush();
      assert.doesNotMatch(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /A_BODY/,
      );
      await pop(detail("release-notes", true));
      const chooseNotes = async () => {
        const notes = [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".installed-skill-contents > ul button",
          ),
        ].find((node) => node.textContent === "notes.txt");
        assert.ok(notes);
        await act(async () => notes.click());
        await flush();
      };
      await chooseNotes();
      await pop(detail("sql-review", true));
      await chooseNotes();
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /B_FILE/,
      );
      await act(async () =>
        aFile.finish({ text: "A_LATE_FILE", binary: false, truncated: false }),
      );
      await flush();
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /B_FILE/,
      );
      assert.doesNotMatch(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /A_LATE/,
      );
    },
    (bridge) => {
      bridge.readSkill = (path) =>
        path.includes("release-notes")
          ? aContents.promise
          : Promise.resolve(body("B"));
      bridge.readSkillFile = (path) =>
        path.includes("release-notes")
          ? aFile.promise
          : Promise.resolve({
              text: "B_FILE",
              binary: false,
              truncated: false,
            });
    },
  );
});

test("review: account-owned page remount prevents same-path late contents from the old account", async () => {
  assert.match(
    readFileSync(
      new URL("../../src/app/AuthGate.tsx", import.meta.url),
      "utf8",
    ),
    /<ProfileStepGate\s+key=\{status\.account\.id\}/,
  );
  const late = deferred<SkillContents>();
  await fixture(
    detail("release-notes", true),
    async ({ document, switchAccount, flush }) => {
      const next = createFixtureDesktop({}, params());
      next.readSkill = async () => ({
        markdown: "ACCOUNT_B",
        files: [{ path: "SKILL.md", bytes: 9 }],
        truncated: false,
      });
      await switchAccount("account-B", next);
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /ACCOUNT_B/,
      );
      await act(async () =>
        late.finish({
          markdown: "ACCOUNT_A_LATE",
          files: [{ path: "SKILL.md", bytes: 9 }],
          truncated: false,
        }),
      );
      await flush();
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /ACCOUNT_B/,
      );
      assert.doesNotMatch(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /ACCOUNT_A_LATE/,
      );
    },
    (bridge) => {
      bridge.readSkill = () => late.promise;
    },
  );
});

test("review: binary, malformed and rejected file reads remain honest and Retry uses the same real path", async () => {
  let retry = 0;
  const reads: string[] = [];
  await fixture(
    detail("release-notes", true),
    async ({ document, flush }) => {
      const choose = async (file: string) => {
        const node = [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".installed-skill-contents > ul button",
          ),
        ].find((node) => node.textContent === file);
        assert.ok(node);
        await act(async () => node.click());
        await flush();
      };
      await choose("image.bin");
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /isn’t text/,
      );
      assert.doesNotMatch(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /BINARY_PAYLOAD/,
      );
      await choose("bad.txt");
      assert.match(
        document.querySelector('.installed-skill-reader [role="alert"]')
          ?.textContent ?? "",
        /Couldn’t load file/,
      );
      const again = document.querySelector<HTMLButtonElement>(
        '.installed-skill-reader [role="alert"] button',
      )!;
      await act(async () => again.click());
      await flush();
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /RECOVERED/,
      );
      await choose("unknown.txt");
      assert.match(
        document.querySelector('.installed-skill-reader [role="alert"]')
          ?.textContent ?? "",
        /not in bundle/,
      );
      assert.deepEqual(reads, [
        "image.bin",
        "bad.txt",
        "bad.txt",
        "unknown.txt",
      ]);
    },
    (bridge) => {
      bridge.readSkill = async () => ({
        markdown: "MAIN",
        files: ["SKILL.md", "image.bin", "bad.txt", "unknown.txt"].map(
          (path) => ({ path, bytes: 1 }),
        ),
        truncated: false,
      });
      bridge.readSkillFile = async (_path, file) => {
        reads.push(file);
        if (file === "unknown.txt") throw Error("not in bundle");
        if (file === "image.bin")
          return { text: "BINARY_PAYLOAD", binary: true, truncated: false };
        if (++retry === 1)
          return {
            text: 123,
            binary: false,
            truncated: false,
          } as unknown as Awaited<ReturnType<DesktopAPI["readSkillFile"]>>;
        return { text: "RECOVERED", binary: false, truncated: false };
      };
    },
  );
});

test("review: same-tick popstate invalidates A removal before B's React commit", async () => {
  const deletion = deferred<void>();
  await fixture(
    detail("release-notes"),
    async ({ click, document, confirms, dispatchPop, url, flush }) => {
      await click(".installed-skill-more");
      const remove = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button'),
      ].find((item) => item.textContent?.trim() === "Remove")!;
      await act(async () => remove.click());
      let operation!: Promise<void>;
      await act(async () => {
        operation = confirms[0].action();
      });
      await act(async () => {
        deletion.finish();
        dispatchPop(detail("sql-review"));
        await operation;
      });
      await flush();
      assert.equal(url(), detail("sql-review"));
      assert.equal(
        document.querySelector(".installed-skill-page h2")?.textContent,
        "sql-review",
      );
    },
    (bridge) => {
      const remove = bridge.deleteSkill.bind(bridge);
      bridge.deleteSkill = async (path) => {
        await deletion.promise;
        await remove(path);
      };
    },
  );
});

test("review: a same-path file read from the old account cannot replace the new account reader", async () => {
  const file = deferred<{
    text: string;
    binary: boolean;
    truncated: boolean;
  }>();
  const contents: SkillContents = {
    markdown: "MAIN",
    files: [
      { path: "SKILL.md", bytes: 4 },
      { path: "notes.txt", bytes: 6 },
    ],
    truncated: false,
  };
  await fixture(
    detail("release-notes", true),
    async ({ document, switchAccount, flush }) => {
      const pick = async () => {
        const notes = [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".installed-skill-contents > ul button",
          ),
        ].find((node) => node.textContent === "notes.txt")!;
        await act(async () => notes.click());
        await flush();
      };
      await pick();
      const next = createFixtureDesktop({}, params());
      next.readSkill = async () => contents;
      next.readSkillFile = async () => ({
        text: "ACCOUNT_B_FILE",
        binary: false,
        truncated: false,
      });
      await switchAccount("account-B-file", next);
      await pick();
      await act(async () =>
        file.finish({
          text: "ACCOUNT_A_LATE_FILE",
          binary: false,
          truncated: false,
        }),
      );
      await flush();
      assert.match(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /ACCOUNT_B_FILE/,
      );
      assert.doesNotMatch(
        document.querySelector(".installed-skill-reader")?.textContent ?? "",
        /ACCOUNT_A/,
      );
    },
    (bridge) => {
      bridge.readSkill = async () => contents;
      bridge.readSkillFile = () => file.promise;
    },
  );
});

for (const action of ["toggle", "remove"] as const) {
  test(`review: old-account pending ${action} cannot close, mutate or refresh the new account's same-path page`, async () => {
    const gate = deferred<void>();
    let operation!: Promise<void>;
    await fixture(
      detail("release-notes"),
      async ({ document, click, confirms, switchAccount, url, flush }) => {
        if (action === "toggle") await click('[role="switch"]');
        else {
          await click(".installed-skill-more");
          const remove = [
            ...document.querySelectorAll<HTMLButtonElement>(
              '[role="menu"] button',
            ),
          ].find((node) => node.textContent?.trim() === "Remove")!;
          await act(async () => remove.click());
          await act(async () => {
            operation = confirms[0].action();
          });
        }
        const next = createFixtureDesktop({}, params());
        const actualList = next.customizeSkills.bind(next);
        let reads = 0;
        next.customizeSkills = async () => {
          reads++;
          return actualList();
        };
        await switchAccount("account-B-" + action, next);
        assert.equal(reads, 1);
        await act(async () => {
          gate.finish();
          await operation;
        });
        await flush();
        assert.equal(url(), detail("release-notes"));
        assert.equal(
          document.querySelector(".installed-skill-page h2")?.textContent,
          "release-notes",
        );
        assert.equal(
          document
            .querySelector('[role="switch"]')
            ?.getAttribute("aria-checked"),
          "true",
        );
        assert.equal(
          reads,
          1,
          "the old account operation must not issue a refresh through the new account bridge",
        );
        assert.ok(
          (await actualList()).some((skill) => skill.name === "release-notes"),
        );
      },
      (bridge) => {
        if (action === "toggle") {
          const update = bridge.setSkillEnabled.bind(bridge);
          bridge.setSkillEnabled = (path, enabled) =>
            (operation = gate.promise.then(() => update(path, enabled)));
        } else {
          const remove = bridge.deleteSkill.bind(bridge);
          bridge.deleteSkill = async (path) => {
            await gate.promise;
            await remove(path);
          };
        }
      },
    );
  });
}

test("review: assembled page exposes each tab's specific Add name and the actual 20/16 glyph sizes", async () => {
  await fixture("/customize/connectors/yours", async ({ document }) => {
    assert.equal(
      document.querySelector('[aria-label="Add connector"]'),
      null,
      "the default web host has no custom-connector editing capability",
    );
  });
  await fixture(
    base,
    async ({ document, pop }) => {
      for (const [section, label] of [
        ["skills", "Add skill"],
        ["plugins", "Add plugin"],
        ["connectors", "Add connector"],
      ] as const) {
        await pop(`/customize/${section}/yours`);
        const add = document.querySelector<HTMLButtonElement>(
          `.customize-add[aria-label="${label}"]`,
        );
        assert.ok(add, label);
        assert.equal(add.getAttribute("aria-haspopup"), "menu");
        assert.equal(
          add.querySelector('[data-icon="Add"]')?.getAttribute("width"),
          "20",
        );
        assert.equal(
          add.querySelector('[data-icon="CaretDown"]')?.getAttribute("width"),
          "16",
        );
      }
    },
    (bridge) => {
      const snapshot = bridge.snapshot.bind(bridge);
      bridge.snapshot = async () => ({
        ...(await snapshot()),
        host: {
          ...webHost,
          capabilities: { ...webHost.capabilities, customConnectors: true },
        },
      });
    },
  );
});

test("review: translated installed UI preserves user names, descriptions and file body values", async () => {
  const named: CustomizeSkill = {
    name: "Settings",
    description: "Search",
    path: "/user/Settings/SKILL.md",
    own: true,
    enabled: true,
    scope: "user",
  };
  await fixture(
    detail("Settings", true),
    async ({ document, flush }) => {
      try {
        await act(async () => {
          await setLocale("zh-CN");
          startDomTranslation();
        });
        await flush();
        assert.equal(
          document.querySelector(".installed-skill-page h2")?.textContent,
          "Settings",
        );
        assert.match(
          document.querySelector(".installed-skill-reader")?.textContent ?? "",
          /Settings[\s\S]*Search/,
        );
        const overview = document.querySelector<HTMLAnchorElement>(
          ".installed-skill-tabs a:not([aria-current])",
        )!;
        await act(async () => overview.click());
        await flush();
        assert.equal(
          document.querySelector(".installed-skill-overview section > p")
            ?.textContent,
          "Search",
        );
        assert.match(
          document.querySelector(".installed-skill-tabs")?.textContent ?? "",
          /概览|概述/,
        );
      } finally {
        await act(async () => setLocale("en-US"));
        await flush();
      }
    },
    (bridge) => {
      bridge.customizeSkills = async () => [named];
      bridge.readSkill = async () => ({
        markdown: "Settings\n\nSearch",
        files: [{ path: "SKILL.md", bytes: 16 }],
        truncated: false,
      });
    },
  );
});

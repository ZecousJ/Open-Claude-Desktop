import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, Fragment, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { nativePickerBodyLimit } from "../../src/composer/native-picker-geometry";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import type { Conversation, Project } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { CoworkOptions } from "../../src/composer/CoworkOptions";
import { createNativeProjectPickerShell } from "../../src/composer/NativeProjectPickerShell";
import { createProjectPickerShell } from "../../src/composer/ProjectPicker";
import { setLocale } from "../../src/i18n";
import {
  defaultProjectId,
  setDefaultProjectId,
} from "../../src/composer/project-picker-preferences";
import { nativeDefaultFolder } from "../../src/composer/native-place-preferences";
import {
  useFolderAccessRequest,
  type FolderAccessRequest,
} from "../../src/cowork/useFolderAccess";

const alpha: Project = {
  id: "native-chat-project",
  name: "Native reference",
  createdAt: 1,
  instructions: "",
  description: "",
};
const localConversation = {
  id: "local-folder",
  mode: "code",
  cwd: "/tmp/native-chat-folder",
  updatedAt: 9,
} as Conversation;
function picker(
  host: HostInfo,
  overrides: Partial<Parameters<typeof CoworkOptions>[0]> = {},
  cloudSync = false,
) {
  const app = {
    accountId: "native-chat-test",
    mode: "chat",
    snapshot: { settings: { cloudSync }, conversations: [localConversation] },
    notify() {},
    report(error: unknown) {
      throw error;
    },
  } as unknown as AppController;
  return createElement(
    HostContext.Provider,
    { value: host },
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(CoworkOptions, {
        variant: "chat",
        platform: "darwin",
        projects: [alpha],
        setCwd() {},
        onProject() {},
        onCreateProject() {},
        async pickFolder() {},
        ...overrides,
      }),
    ),
  );
}

test("native Chat uses the real project-or-folder branch, independently of cloud synchronization", () => {
  for (const sync of [false, true]) {
    const { document } = parseHTML(
      renderToStaticMarkup(picker(desktopHost, {}, sync)),
    );
    const trigger = document.querySelector(".cowork-options > button")!;
    assert.equal(trigger.firstElementChild?.textContent, "Project or folder");
    assert.equal(trigger.getAttribute("aria-haspopup"), "listbox");
    assert.equal(trigger.getAttribute("type"), "button");
    assert.equal(
      document
        .querySelector(".cowork-options")
        ?.getAttribute("data-picker-surface"),
      "desktop-chat",
    );
  }
});

test("web Chat and desktop hosts without local folders retain the projects-only picker", () => {
  for (const host of [
    webHost,
    {
      ...desktopHost,
      capabilities: { ...desktopHost.capabilities, localFolders: false },
    },
  ]) {
    const { document } = parseHTML(renderToStaticMarkup(picker(host)));
    const trigger = document.querySelector(".cowork-options > button")!;
    assert.equal(trigger.textContent?.startsWith("Project"), true);
    assert.equal(trigger.textContent?.includes("folder"), false);
    assert.equal(trigger.getAttribute("aria-haspopup"), "listbox");
    assert.equal(document.querySelector("[data-picker-surface]"), null);
  }
});

test("native projects-only Chat never lists or authorizes folders while ordinary project selection preserves defaults", async () => {
  await environment(async ({ document, render, click }) => {
    const selected: string[] = [];
    const forbidden = () =>
      assert.fail("Projects-only Chat cannot use a local folder bridge");
    const localProject = { ...alpha, cwd: "/tmp/project-private-folder" };
    setDefaultProjectId("native-chat-test", alpha.id);
    const before = {
      project: defaultProjectId("native-chat-test"),
      folder: nativeDefaultFolder("native-chat-test"),
      history: structuredClone(localConversation),
    };
    await render(
      picker(desktopHost, {
        projectsOnly: true,
        projects: [localProject],
        cwd: localConversation.cwd,
        onProject: (id) => selected.push(id),
        setCwd: forbidden,
        pickFolder: async () => forbidden(),
      }),
    );
    const trigger = document.querySelector(".cowork-options > button")!;
    assert.equal(
      trigger.querySelector(":scope > span:not([data-icon])")
        ?.textContent,
      "Project or folder",
    );
    assert.equal(trigger.getAttribute("title"), null);
    await click(".cowork-options > button");
    await act(async () => {
      await import("../../src/composer/ProjectPickerPopup");
    });
    assert.equal(document.querySelector(".native-project-picker"), null);
    assert.equal(
      document
        .querySelector('.project-picker[role="menu"]')
        ?.getAttribute("aria-label"),
      "Project or folder",
    );
    assert.equal(
      document.querySelector('[role="listbox"]')?.getAttribute("aria-label"),
      "Search or create a project",
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /Add folder|native-chat-folder|project-private-folder/,
    );
    assert.ok(
      document.querySelector(".project-picker-default"),
      "explicit official Set as default action remains available",
    );
    await click('[data-place-key="project:native-chat-project"]');
    assert.deepEqual(selected, [alpha.id]);
    assert.equal(defaultProjectId("native-chat-test"), before.project);
    assert.equal(nativeDefaultFolder("native-chat-test"), before.folder);
    assert.deepEqual(localConversation, before.history);
    setDefaultProjectId("native-chat-test", undefined);
  });
});

test("native Chat labels a selected folder and keeps the native plain trigger free of a leading icon", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(
      picker(desktopHost, { cwd: "/tmp/native-chat-folder" }),
    ),
  );
  const trigger = document.querySelector(".cowork-options > button")!;
  assert.equal(trigger.firstElementChild?.textContent, "native-chat-folder");
  assert.equal(trigger.firstElementChild?.tagName, "SPAN");
  assert.equal(trigger.getAttribute("aria-haspopup"), "listbox");
});

async function environment(
  run: (env: {
    document: Document;
    window: ReturnType<typeof parseHTML>["window"];
    render(element: ReactElement): Promise<void>;
    click(selector: string): Promise<void>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  const prototypeSaved = new Map(
    ["focus", "getBoundingClientRect", "scrollHeight"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, key),
    ]),
  );
  let focused: HTMLElement | undefined;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 1100,
    y: 610,
    left: 1100,
    top: 610,
    right: 1230,
    bottom: 634,
    width: 130,
    height: 24,
    toJSON() {},
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 300,
  });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused,
  });
  const storage = new Map<string, string>();
  const globals = {
    window,
    document,
    Event: window.Event,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    innerWidth: 1280,
    innerHeight: 720,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
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
  try {
    await run({
      document,
      window,
      render: (element) =>
        act(async () => {
          root.render(element);
        }),
      click: (selector) =>
        act(async () => {
          const button = document.querySelector<HTMLButtonElement>(selector);
          assert.ok(button, selector);
          button.click();
          // Wait for an actual lazy popup after interaction, not before the
          // trigger's first render. Cold-node tests use a blocked loader.
          await import("../../src/composer/NativeProjectPicker");
        }),
    });
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of prototypeSaved) {
      if (descriptor)
        Object.defineProperty(window.HTMLElement.prototype, key, descriptor);
      else Reflect.deleteProperty(window.HTMLElement.prototype, key);
    }
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("native Chat opens only real local recents, routes browse to the real callback, and creates through the form callback", async () => {
  await environment(async ({ document, render, click }) => {
    let browsed = 0,
      created = 0,
      directCreated = 0;
    await render(
      picker(desktopHost, {
        async pickFolder() {
          browsed++;
        },
        onNewProject() {
          created++;
        },
        onCreateProject() {
          directCreated++;
        },
      }),
    );
    await click(".cowork-options > button");
    const menu = document.querySelector('[role="menu"]')!;
    assert.equal(menu.getAttribute("aria-label"), "Project or folder");
    assert.equal(
      menu.parentElement,
      document.body,
      "the native popup is outside composer clipping",
    );
    assert.equal(
      (menu as HTMLElement).style.left,
      "945px",
      "the right edge remains 8px inside the viewport",
    );
    assert.equal(
      (menu as HTMLElement).style.bottom,
      "114px",
      "a low chin flips the menu above the trigger",
    );
    assert.ok(menu.textContent?.includes("native-chat-folder"));
    assert.ok(menu.textContent?.includes("Native reference"));
    await click('[data-place-key="browse"]');
    assert.equal(browsed, 1);
    assert.equal(document.querySelector('[role="menu"]'), null);
    await click(".cowork-options > button");
    await click('[data-place-key="create"]');
    assert.equal(created, 1);
    assert.equal(directCreated, 0);
  });
});

test("a recent folder is applied only after the existing access check grants it", async () => {
  await environment(async ({ window, render, click }) => {
    const selected: (string | undefined)[] = [];
    let checks = 0;
    window.desktop = {
      async coworkFolderAccess() {
        checks++;
        return { state: "refused" };
      },
    } as never;
    await render(
      picker(desktopHost, {
        setCwd(value) {
          selected.push(value);
        },
      }),
    );
    await click(".cowork-options > button");
    await click('[data-place-key="folder:/tmp/native-chat-folder"]');
    assert.equal(checks, 1);
    assert.deepEqual(selected, []);
    window.desktop = {
      async coworkFolderAccess() {
        checks++;
        return { state: "trusted" };
      },
    } as never;
    await click(".cowork-options > button");
    await click('[data-place-key="folder:/tmp/native-chat-folder"]');
    assert.equal(checks, 2);
    assert.deepEqual(selected, ["/tmp/native-chat-folder"]);
  });
});

test("native Chat authorizes a cwd project before the real project callback can replace an existing folder", async () => {
  await environment(async ({ window, render, click }) => {
    const localProject = { ...alpha, cwd: "/tmp/native-chat-project-folder" };
    const state = { projectId: "old-project", cwd: "/tmp/old-folder" };
    const calls: unknown[][] = [];
    const picks: string[] = [];
    let trusted = false;
    window.desktop = {
      async coworkFolderAccess(...args: unknown[]) {
        calls.push(args);
        return { state: trusted ? "trusted" : "refused" };
      },
    } as never;
    await render(
      picker(desktopHost, {
        projects: [localProject],
        cwd: state.cwd,
        onProject(id) {
          picks.push(id);
          state.projectId = id;
          state.cwd = localProject.cwd;
        },
        setCwd() {
          assert.fail("project selection must retain the project callback");
        },
      }),
    );
    await click(".cowork-options > button");
    await click('[data-place-key="project:native-chat-project"]');
    assert.deepEqual(calls, [[localProject.cwd, undefined, localProject.id]]);
    assert.deepEqual(picks, []);
    assert.deepEqual(state, {
      projectId: "old-project",
      cwd: "/tmp/old-folder",
    });
    trusted = true;
    await click(".cowork-options > button");
    await click('[data-place-key="project:native-chat-project"]');
    assert.deepEqual(picks, [localProject.id]);
    assert.deepEqual(state, {
      projectId: localProject.id,
      cwd: localProject.cwd,
    });
  });
});

test("native Chat project cancellation preserves both old contexts and Allow waits for the real grant", async () => {
  await environment(async ({ window, render, click }) => {
    const localProject = {
      ...alpha,
      cwd: "/tmp/native-chat-confirmed-project",
    };
    const state = {
      projectId: "previous-project",
      cwd: "/tmp/previous-folder",
    };
    let request: FolderAccessRequest | undefined;
    function AccessHost() {
      request = useFolderAccessRequest();
      return null;
    }
    let resolveGrant: ((access: unknown) => void) | undefined;
    const grants: unknown[][] = [];
    window.desktop = {
      async coworkFolderAccess() {
        return { state: "ask", folder: localProject.cwd, home: false };
      },
      grantCoworkFolder(...args: unknown[]) {
        grants.push(args);
        return new Promise((resolve) => {
          resolveGrant = resolve;
        });
      },
    } as never;
    await render(
      createElement(
        Fragment,
        null,
        picker(desktopHost, {
          projects: [localProject],
          cwd: state.cwd,
          onProject(id) {
            state.projectId = id;
            state.cwd = localProject.cwd;
          },
        }),
        createElement(AccessHost),
      ),
    );
    await click(".cowork-options > button");
    await click('[data-place-key="project:native-chat-project"]');
    assert.ok(request);
    assert.equal(request.target.projectId, localProject.id);
    await act(() => request!.answer("cancel"));
    assert.deepEqual(state, {
      projectId: "previous-project",
      cwd: "/tmp/previous-folder",
    });
    assert.deepEqual(grants, []);
    await click(".cowork-options > button");
    await click('[data-place-key="project:native-chat-project"]');
    assert.ok(request);
    let allowing: Promise<void> | undefined;
    await act(async () => {
      allowing = request!.answer("allow");
      await Promise.resolve();
    });
    assert.deepEqual(grants, [
      [localProject.cwd, "session", { projectId: localProject.id }],
    ]);
    assert.deepEqual(state, {
      projectId: "previous-project",
      cwd: "/tmp/previous-folder",
    });
    assert.ok(resolveGrant);
    await act(async () => {
      resolveGrant!({
        state: "granted",
        folder: localProject.cwd,
        home: false,
      });
      await allowing;
    });
    assert.deepEqual(state, {
      projectId: localProject.id,
      cwd: localProject.cwd,
    });
  });
});

test("a native project without cwd preserves an already chosen folder and requires no extra folder grant", async () => {
  await environment(async ({ window, render, click }) => {
    const state = { projectId: "previous-project", cwd: "/tmp/kept-folder" };
    let checks = 0;
    window.desktop = {
      async coworkFolderAccess() {
        checks++;
        throw Error("a context-only project has no folder to authorize");
      },
    } as never;
    await render(
      picker(desktopHost, {
        cwd: state.cwd,
        onProject(id) {
          state.projectId = id;
        },
        setCwd() {
          assert.fail(
            "a context-only project must not clear the existing folder",
          );
        },
      }),
    );
    await click(".cowork-options > button");
    await click('[data-place-key="project:native-chat-project"]');
    assert.equal(checks, 0);
    assert.deepEqual(state, { projectId: alpha.id, cwd: "/tmp/kept-folder" });
  });
});

test("native Chat displays both real contexts without losing either checked state", async () => {
  await environment(async ({ document, render, click }) => {
    for (const specimen of [
      { project: alpha, cwd: "/tmp/independent-folder", extra: true },
      {
        project: { ...alpha, cwd: "/tmp/project-folder" },
        cwd: "/tmp/another-folder",
        extra: true,
      },
      {
        project: { ...alpha, cwd: "/tmp/project-folder" },
        cwd: "/tmp/project-folder",
        extra: false,
      },
      { project: alpha, cwd: undefined, extra: false },
    ]) {
      await render(
        picker(desktopHost, {
          projects: [specimen.project],
          project: specimen.project,
          cwd: specimen.cwd,
        }),
      );
      const trigger = document.querySelector<HTMLButtonElement>(
        ".cowork-options > button",
      )!;
      assert.equal(
        trigger.firstElementChild?.textContent,
        `${alpha.name}${specimen.extra ? " +1" : ""}`,
      );
      assert.equal(
        trigger.firstElementChild?.tagName,
        "SPAN",
        "the native plain trigger keeps its icon hidden",
      );
      await click(".cowork-options > button");
      const projectRow = document.querySelector(
        '[data-place-key="project:native-chat-project"]',
      )!;
      assert.equal(projectRow.getAttribute("aria-selected"), "true");
      if (specimen.cwd) {
        const folderRow = document.querySelector(
          `[data-place-key="folder:${specimen.cwd}"]`,
        );
        if (specimen.extra)
          assert.equal(folderRow?.getAttribute("aria-selected"), "true");
        else
          assert.equal(
            folderRow,
            null,
            "the project folder is represented once by its project row",
          );
      }
      assert.equal(
        document.querySelectorAll(
          '.project-picker-options [role="option"][aria-selected="true"]',
        ).length,
        specimen.extra ? 2 : 1,
      );
      await click(".cowork-options > button");
    }
  });
});

test("native trigger truncation stays scoped and does not restyle web or Code controls", () => {
  const css = readFileSync(
    new URL("../../src/composer/native-chat-composer.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /data-picker-surface="desktop-chat"/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(css, /\.model-button|\.workspace-chip|\.composer\s*\{/);
  const leaf = readFileSync(
    new URL("../../src/composer/CoworkOptions.tsx", import.meta.url),
    "utf8",
  );
  const entry = readFileSync(
    new URL("../../src/main.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(leaf, /import\s+["']\.\/native-chat-composer\.css/);
  assert.match(
    entry,
    /if \(surface !== "web"\)\s*\{[^}]+await import\("\.\/composer\/native-chat-composer\.css"\)/s,
  );
});

test("native Filter/sort, Pinned, default keys, folder filtering and typed creation operate on actual rows", async () => {
  await environment(async ({ document, window, render, click }) => {
    const forms: (string | undefined)[] = [];
    setDefaultProjectId("native-chat-test", undefined);
    await render(
      picker(desktopHost, {
        projects: [
          alpha,
          { ...alpha, id: "pinned", name: "Pinned project", pinned: true },
        ],
        onNewProject: (name) => forms.push(name),
      }),
    );
    await click(".cowork-options > button");
    assert.equal(
      document.querySelector(".project-picker-section")?.textContent,
      "Pinned",
    );
    assert.equal(
      document.querySelector(
        '[data-place-key="project:pinned"] .project-picker-default',
      ),
      null,
    );
    await click(".project-picker-filter-trigger");
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        '[data-picker-control="updated"]',
      )?.disabled,
      true,
    );
    await click('[data-picker-control="name"]');
    assert.equal(
      document
        .querySelector('[data-picker-control="name"]')
        ?.getAttribute("aria-checked"),
      "true",
    );
    assert.ok(
      document.querySelector(
        '[data-place-key="folder:/tmp/native-chat-folder"]',
      ),
    );
    await click('[data-picker-control="folders"]');
    assert.equal(
      document.querySelector(
        '[data-place-key="folder:/tmp/native-chat-folder"]',
      ),
      null,
    );
    const input = () =>
      document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const key = (value: string, extra = {}) =>
      act(async () => {
        const event = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { key: value, ...extra });
        input().dispatchEvent(event);
      });
    const change = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input(), value);
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    await key("Escape");
    assert.ok(document.querySelector('input[role="combobox"]'));
    await change("Native reference");
    await key("ArrowDown");
    await key("Enter", { altKey: true, isComposing: true });
    assert.equal(defaultProjectId("native-chat-test"), undefined);
    await key("Enter", { altKey: true });
    assert.equal(defaultProjectId("native-chat-test"), alpha.id);
    assert.equal(
      document.querySelector(".project-picker-section")?.textContent,
      "Default",
    );
    await change("  Brand new native project  ");
    assert.match(
      document.querySelector('[data-place-key="create"]')?.textContent ?? "",
      /Create.*Brand new native project/,
    );
    await key("Enter", { isComposing: true });
    assert.deepEqual(forms, []);
    await key("Enter");
    assert.deepEqual(forms, ["Brand new native project"]);
    await click(".cowork-options > button");
    await click(".project-picker-filter-trigger");
    await click('[data-picker-control="folders"]');
    await key("Escape");
    await change("/tmp/native-chat-folder");
    await key("ArrowDown");
    await key("Enter", { altKey: true });
    assert.equal(
      nativeDefaultFolder("native-chat-test"),
      "/tmp/native-chat-folder",
    );
    assert.equal(defaultProjectId("native-chat-test"), undefined);
  });
});

test("cold native popup loading preserves the same localized, selected and collapsed trigger node", async () => {
  for (const specimen of [
    { locale: "en-US", project: undefined, cwd: undefined, collapsed: false },
    { locale: "zh-CN", project: undefined, cwd: undefined, collapsed: false },
    {
      locale: "zh-CN",
      project: alpha,
      cwd: "/tmp/independent",
      collapsed: false,
    },
    {
      locale: "en-US",
      project: alpha,
      cwd: "/tmp/independent",
      collapsed: true,
    },
  ])
    await environment(async ({ document, render }) => {
      await act(async () => {
        await setLocale(specimen.locale);
      });
      let release!: (
        module: typeof import("../../src/composer/NativeProjectPicker"),
      ) => void;
      let loads = 0;
      const Shell = createNativeProjectPickerShell(() => {
        loads++;
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const app = {
        accountId: "cold-native",
        mode: "chat",
        snapshot: { settings: {}, conversations: [] },
      } as unknown as AppController;
      try {
        await render(
          createElement(
            AppContext.Provider,
            { value: app },
            createElement(Shell, {
              ...specimen,
              platform: "darwin",
              projects: [alpha],
              onProject() {},
              onCreateProject() {},
              setCwd() {},
              async pickFolder() {},
            }),
          ),
        );
        const button = document.querySelector<HTMLButtonElement>(
          ".cowork-options > button",
        )!;
        const content = button.innerHTML;
        if (specimen.locale === "zh-CN" && !specimen.project && !specimen.cwd)
          assert.equal(button.firstElementChild?.textContent, "项目或文件夹");
        assert.equal(
          loads,
          0,
          "rendering the real trigger must not load the popup",
        );
        await act(() => button.click());
        assert.equal(loads, 1);
        assert.equal(
          document.querySelector(".cowork-options > button"),
          button,
        );
        assert.equal(button.innerHTML, content);
        const pendingClass = button.className,
          pendingRoot = button.parentElement!.getAttribute("data-collapsed");
        assert.equal(
          document.querySelector('[role="combobox"]'),
          null,
          "the module is genuinely blocked",
        );
        await act(async () => {
          release(await import("../../src/composer/NativeProjectPicker"));
        });
        assert.ok(document.querySelector('[role="combobox"]'));
        assert.equal(
          document.querySelector(".cowork-options > button"),
          button,
          "the trigger DOM node survives module resolution",
        );
        assert.equal(button.innerHTML, content);
        assert.equal(button.className, pendingClass);
        assert.equal(
          button.parentElement!.getAttribute("data-collapsed"),
          pendingRoot,
        );
      } finally {
        await act(async () => {
          await setLocale("en-US");
        });
      }
    });
});

test("Escape or an outside press cancels a genuinely pending native popup without a late focus grab", async () => {
  for (const dismiss of ["escape", "outside"] as const)
    await environment(async ({ document, window, render }) => {
      let release!: (
        module: typeof import("../../src/composer/NativeProjectPicker"),
      ) => void;
      const Shell = createNativeProjectPickerShell(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await render(
        createElement(Shell, {
          platform: "darwin",
          projects: [],
          collapsed: false,
          onProject() {},
          onCreateProject() {},
          setCwd() {},
          async pickFolder() {},
        }),
      );
      const button = document.querySelector<HTMLButtonElement>(
        ".cowork-options > button",
      )!;
      await act(() => button.click());
      assert.equal(button.getAttribute("aria-expanded"), "true");
      await act(() => {
        const event = new window.Event(
          dismiss === "escape" ? "keydown" : "pointerdown",
          { bubbles: true, cancelable: true },
        );
        if (dismiss === "escape") Object.assign(event, { key: "Escape" });
        document.body.dispatchEvent(event);
      });
      assert.equal(button.getAttribute("aria-expanded"), "false");
      await act(async () => {
        release(await import("../../src/composer/NativeProjectPicker"));
      });
      assert.equal(document.querySelector('[role="combobox"]'), null);
      assert.equal(document.querySelector(".cowork-options > button"), button);
      assert.equal(button.getAttribute("aria-expanded"), "false");
    });
});

test("web popup is genuinely lazy while the localized trigger survives pending, resolve and cancellation", async () => {
  for (const outcome of ["resolve", "escape", "outside"] as const)
    await environment(async ({ document, window, render }) => {
      await act(async () => {
        await setLocale("zh-CN");
      });
      let release!: (
        module: typeof import("../../src/composer/ProjectPickerPopup"),
      ) => void;
      let loads = 0;
      const Shell = createProjectPickerShell(() => {
        loads++;
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const app = {
        accountId: "cold-web",
        snapshot: { conversations: [] },
      } as unknown as AppController;
      try {
        await render(
          createElement(
            AppContext.Provider,
            { value: app },
            createElement(Shell, {
              platform: "darwin",
              projects: [alpha],
              collapsed: false,
              onProject() {},
              onCreateProject() {},
            }),
          ),
        );
        const button = document.querySelector<HTMLButtonElement>(
          ".cowork-options > button",
        )!;
        const content = button.innerHTML;
        assert.equal(button.firstElementChild?.textContent, "项目");
        assert.equal(loads, 0);
        await act(() => button.click());
        assert.equal(loads, 1);
        assert.equal(document.querySelector('[role="combobox"]'), null);
        const pendingClass = button.className;
        if (outcome !== "resolve")
          await act(() => {
            const event = new window.Event(
              outcome === "escape" ? "keydown" : "pointerdown",
              { bubbles: true, cancelable: true },
            );
            if (outcome === "escape") Object.assign(event, { key: "Escape" });
            document.body.dispatchEvent(event);
          });
        await act(async () => {
          release(await import("../../src/composer/ProjectPickerPopup"));
        });
        assert.equal(
          document.querySelector(".cowork-options > button"),
          button,
        );
        assert.equal(button.innerHTML, content);
        assert.equal(
          Boolean(document.querySelector('[role="combobox"]')),
          outcome === "resolve",
        );
        if (outcome === "resolve") assert.equal(button.className, pendingClass);
        else assert.equal(button.getAttribute("aria-expanded"), "false");
      } finally {
        await act(async () => {
          await setLocale("en-US");
        });
      }
    });
  const eager = readFileSync(
    new URL("../../src/composer/ProjectPicker.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    eager,
    /from ["']\.\/PlacePickerSurface|from ["']\.\/project-picker-model/,
  );
});

test("native folder paths with spaces and non-Latin names keep a valid active option reference", async () => {
  await environment(async ({ document, window, render, click }) => {
    await render(picker(desktopHost, { cwd: "/tmp/folder with 空格" }));
    await click(".cowork-options > button");
    const input =
      document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "/tmp/folder with 空格");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(() => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { key: "ArrowDown" });
      input.dispatchEvent(event);
    });
    const active = input.getAttribute("aria-activedescendant")!;
    assert.ok(active);
    assert.doesNotMatch(active, /\s/);
    assert.equal(
      document.getElementById(active)?.getAttribute("data-place-key"),
      "folder:/tmp/folder with 空格",
    );
  });
});
test("fresh cwd projects can be defaults, but an unrecorded generic cwd offers only its truthful limitation", async () => {
  await environment(async ({ document, window, render, click }) => {
    setDefaultProjectId("native-chat-test", undefined);
    await render(
      picker(desktopHost, {
        projects: [{ ...alpha, cwd: "/tmp/fresh-project-folder" }],
        cwd: "/tmp/unrecorded-selected-folder",
      }),
    );
    await click(".cowork-options > button");
    const fresh = document.querySelector(
      '[data-place-key="project:native-chat-project"]',
    )!;
    assert.ok(
      fresh.querySelector(".project-picker-default"),
      "a real current local project does not require a prior conversation",
    );
    const folder = document.querySelector(
      '[data-place-key="folder:/tmp/unrecorded-selected-folder"]',
    )!;
    assert.equal(folder.querySelector(".project-picker-default"), null);
    assert.equal(
      folder.getAttribute("aria-description"),
      "Use this folder in a conversation before setting it as default.",
    );
    const input =
      document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "/tmp/unrecorded-selected-folder");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(() => {
      for (const details of [
        { key: "ArrowDown" },
        { key: "Enter", altKey: true },
      ]) {
        const event = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, details);
        input.dispatchEvent(event);
      }
    });
    assert.equal(nativeDefaultFolder("native-chat-test"), undefined);
    assert.equal(defaultProjectId("native-chat-test"), undefined);
  });
});

test("native real CSS and mounted DOM use the CDS 200px body cap, 32px search and 318px shell contract", async () => {
  await environment(async ({ document, render, click }) => {
    const sheets = [
      "../../src/composer/cowork-options.css",
      "../../src/composer/native-chat-composer.css",
    ].map((file) =>
      postcss.parse(readFileSync(new URL(file, import.meta.url), "utf8")),
    );
    const value = (element: HTMLElement, name: string): string => {
      let result = "";
      for (const sheet of sheets)
        sheet.walkRules((rule) => {
          if (rule.parent?.type === "atrule") return;
          const matches = postcss.list.comma(rule.selector).some((selector) => {
            try {
              return element.matches(selector);
            } catch {
              return false;
            }
          });
          if (matches)
            rule.walkDecls((declaration) => {
              if (declaration.prop === name) result = declaration.value;
            });
        });
      const inline = element.style.getPropertyValue(name);
      if (inline) result = inline;
      if (!result && name.startsWith("--") && element.parentElement)
        result = value(element.parentElement, name);
      return result.replace(/var\((--[\w-]+)\)/g, (_match, key) =>
        value(element, key),
      );
    };
    const computed = (element: HTMLElement) =>
      ({
        getPropertyValue: (name: string) => value(element, name),
      }) as CSSStyleDeclaration;
    const saved = Object.getOwnPropertyDescriptor(
      globalThis,
      "getComputedStyle",
    );
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: computed,
    });
    try {
      const conversations = Array.from({ length: 8 }, (_, i) => ({
        ...localConversation,
        id: `geometry-${i}`,
        mode: "chat",
        cwd: `/tmp/geometry-folder-${i}`,
        updatedAt: i,
        archived: false,
        incognito: false,
      }));
      const app = {
        accountId: "native-real-css-geometry",
        mode: "chat",
        snapshot: { settings: {}, conversations },
      } as unknown as AppController;
      await render(
        createElement(
          HostContext.Provider,
          { value: desktopHost },
          createElement(
            AppContext.Provider,
            { value: app },
            createElement(CoworkOptions, {
              variant: "chat",
              platform: "darwin",
              projects: [],
              setCwd() {},
              onProject() {},
              onCreateProject() {},
              async pickFolder() {},
            }),
          ),
        ),
      );
      await click(".cowork-options > button");
      const popup = document.querySelector<HTMLElement>(
        ".native-project-picker",
      )!;
      const list = popup.querySelector<HTMLElement>(".project-picker-options")!;
      const search = popup.querySelector<HTMLElement>(
        ".project-picker-search",
      )!;
      const input = popup.querySelector<HTMLInputElement>('[role="combobox"]')!;
      const footer = popup.querySelector<HTMLElement>(
        ".native-project-picker-footer",
      )!;
      const separator = popup.querySelector<HTMLElement>(
        ".cowork-menu-separator",
      )!;
      assert.equal(list.querySelectorAll('[data-detail="true"]').length, 8);
      assert.equal(
        value(
          list.querySelector<HTMLElement>('[data-detail="true"]')!,
          "height",
        ),
        "49px",
      );
      assert.equal(
        list.style.maxHeight,
        "200px",
        "six 49px path rows must not produce a 294px or row-measured cap",
      );
      assert.equal(value(search, "height"), "32px");
      assert.equal(value(input, "height"), "32px");
      assert.equal(value(footer, "display"), "flow-root");
      assert.equal(value(footer, "margin-top"), "-4px");
      assert.equal(value(list, "box-sizing"), "border-box");
      assert.equal(value(list, "padding-bottom"), "4px");
      const px = (element: HTMLElement, property: string) =>
        Number.parseFloat(value(element, property));
      const separatorSize =
        2 * px(separator, "margin") + px(separator, "height");
      const footerRows = Array.from(
        footer.querySelectorAll<HTMLElement>(".project-picker-row"),
      );
      const shellHeight =
        2 * px(popup, "padding") +
        px(search, "height") +
        separatorSize +
        Number.parseFloat(list.style.maxHeight) +
        separatorSize +
        footerRows.reduce((sum, row) => sum + px(row, "height"), 0) +
        px(footer, "margin-top") +
        2 * px(popup, "border");
      assert.equal(
        shellHeight,
        318,
        "the actual CSS box-model contract matches the official comfortable popup",
      );
      assert.equal(
        nativePickerBodyLimit(popup, 250, 118, computed(popup)),
        132,
        "viewport chrome clips the token cap",
      );
      assert.equal(nativePickerBodyLimit(popup, 80, 118, computed(popup)), 0);
      popup.style.setProperty("--cds-leading-body", "40px");
      assert.equal(
        nativePickerBodyLimit(popup, 1000, 118, computed(popup)),
        248,
        "the formula uses max(control, leading), not a fixed 200 or actual row heights",
      );
    } finally {
      if (saved) Object.defineProperty(globalThis, "getComputedStyle", saved);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
    }
  });
});

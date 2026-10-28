import test from "node:test";
import assert from "node:assert/strict";
import { act, StrictMode, createElement as h } from "react";
import { routineDom } from "../support/routine-dom";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost, webHost } from "../../shared/host";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { CoworkTaskFolderButton } from "../../src/cowork/CoworkTaskFolderButton";
import { TaskFolderBrowser } from "../../src/cowork/TaskFolderBrowser";
import { FolderAccessHost } from "../../src/cowork/FolderAccessDialog";
import {
  useTaskFolderState,
  addCoworkTaskFolder,
} from "../../src/cowork/task-folders";
import {
  resetFolderAccessForTests,
  pendingFolderAccess,
} from "../../src/cowork/useFolderAccess";
import type { Conversation } from "../../shared/types";
import type {
  TaskFolderDirectory,
  TaskFolderSnapshot,
} from "../../shared/folder-browser";

const conversation: Conversation = {
  id: "folder-chat",
  mode: "chat",
  title: "Chat",
  providerId: "p",
  model: "m",
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  archived: false,
  turns: [],
};
const remote = {
  ...conversation,
  environment: { kind: "space" as const, spaceId: "own-space" },
};
const host = {
  ...webHost,
  capabilities: { ...webHost.capabilities, cloudCowork: true },
};
const capability = {
  kind: "execution" as const,
  root: "/execution",
  initialPath: "/execution",
};
const wrap = (
  child: ReturnType<typeof h>,
  native = false,
  app?: AppController,
) =>
  h(
    HostContext.Provider,
    { value: native ? desktopHost : host },
    h(AppContext.Provider, { value: app }, child),
  );
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

test("33/34: retiring the real button removes its pending permission dialog and retained Allow cannot grant", async () => {
  resetFolderAccessForTests();
  let grants = 0;
  const access = {
    state: "ask" as const,
    folder: "/private-old-folder",
    name: "Old folder",
  };
  const env = await routineDom({
    coworkFolders: async () => ({ extra: [], browser: { kind: "native" } }),
    chooseFolder: async () => access.folder,
    coworkFolderAccess: async () => access,
    grantCoworkFolder: async () => {
      grants++;
      return { ...access, state: "granted" };
    },
  });
  const view = (show: boolean) =>
    wrap(
      h(
        "div",
        null,
        show ? h(CoworkTaskFolderButton, { conversation }) : null,
        h(FolderAccessHost),
      ),
      true,
    );
  try {
    await env.render(view(true));
    await env.click('[aria-label="Add folder"]');
    const request = pendingFolderAccess();
    assert.ok(request);
    assert.match(
      env.document.body.textContent!,
      /Old folder|private-old-folder/,
    );
    await env.render(view(false));
    assert.equal(pendingFolderAccess(), undefined);
    assert.doesNotMatch(env.document.body.textContent!, /private-old-folder/);
    await act(async () => request.answer("allow"));
    assert.equal(grants, 0);
  } finally {
    await env.clean();
    resetFolderAccessForTests();
  }
});

test("33/34: StrictMode effect replay grants the live button a new usable lease", async () => {
  let grants = 0;
  const env = await routineDom({
    coworkFolders: async () => ({ extra: [], browser: { kind: "native" } }),
    chooseFolder: async () => "/chosen",
    coworkFolderAccess: async () => ({
      state: "trusted",
      folder: "/chosen",
      name: "chosen",
    }),
    grantCoworkFolder: async () => {
      grants++;
      return { state: "granted", folder: "/chosen", name: "chosen" };
    },
  });
  try {
    await env.render(
      wrap(
        h(StrictMode, null, h(CoworkTaskFolderButton, { conversation })),
        true,
      ),
    );
    await env.click('[aria-label="Add folder"]');
    assert.equal(grants, 1);
  } finally {
    await env.clean();
  }
});

for (const retirement of ["unmount", "account-before-render"] as const) {
  test(`33/34: a real native chooser pending across ${retirement} cannot read or grant a replacement owner's folder`, async () => {
    const picker = deferred<string>();
    let reads = 0,
      grants = 0;
    const env = await routineDom({
      coworkFolders: async () => ({ extra: [], browser: { kind: "native" } }),
      chooseFolder: () => picker.promise,
      coworkFolderAccess: async () => {
        reads++;
        return { state: "trusted", folder: "/chosen", name: "chosen" };
      },
      grantCoworkFolder: async () => {
        grants++;
        return { state: "granted", folder: "/chosen", name: "chosen" };
      },
    });
    const app = {
      accountId: "A",
      controllerScope: {},
      active: conversation,
      currentController: { current: undefined },
    } as unknown as AppController;
    app.currentController!.current = app;
    try {
      await env.render(
        wrap(h(CoworkTaskFolderButton, { conversation }), true, app),
      );
      await env.click('[aria-label="Add folder"]');
      if (retirement === "unmount") await env.render(wrap(h("div"), true, app));
      else
        app.currentController!.current = {
          ...app,
          accountId: "B",
          controllerScope: {},
        };
      await act(async () => picker.resolve("/chosen"));
      assert.equal(reads, 0);
      assert.equal(grants, 0);
    } finally {
      await env.clean();
    }
  });
}

test("33/35: actual native Chat button announces pending/read failure/retry and uses native chooser only after advertised support", async () => {
  const initial = deferred<TaskFolderSnapshot>();
  let reads = 0,
    picks = 0,
    grants = 0;
  const env = await routineDom({
    coworkFolders: () =>
      ++reads === 1
        ? initial.promise
        : Promise.resolve({ extra: [], browser: { kind: "native" } }),
    chooseFolder: async () => {
      picks++;
      return "/native/notes";
    },
    coworkFolderAccess: async () => ({
      state: "trusted",
      folder: "/native/notes",
      name: "notes",
    }),
    grantCoworkFolder: async () => {
      grants++;
      return { state: "granted", folder: "/native/notes", name: "notes" };
    },
  });
  try {
    await env.render(wrap(h(CoworkTaskFolderButton, { conversation }), true));
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Loading folders…"]:disabled',
      ),
    );
    await act(async () => initial.reject(Error("runner disconnected")));
    assert.ok(env.document.querySelector('[role="alert"]'));
    await env.click('button[aria-label="Retry folder access"]');
    await env.click('button[aria-label="Add folder"]');
    assert.equal(picks, 1);
    assert.equal(grants, 1);
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
  } finally {
    await env.clean();
  }
});

test("33/34: remote composer lazy dialog navigates execution folders then actual confirmation host grants; native chooser is never called", async () => {
  let granted = false;
  const listed: string[] = [];
  const calls: string[] = [];
  const env = await routineDom(
    {
      coworkFolders: async () => ({
        extra: granted ? ["/execution/notes"] : [],
        browser: capability,
      }),
      chooseFolder: async () => {
        throw Error("must never choose a browser device folder");
      },
      listTaskFolderDirectory: async (_id, path) => {
        listed.push(path);
        return path === "/execution/notes/"
          ? { path: "/execution/notes", parent: "/execution", directories: [] }
          : { path: "/execution", directories: ["notes"] };
      },
      coworkFolderAccess: async (folder) => ({
        state: granted ? "granted" : "ask",
        folder,
        name: "notes",
      }),
      grantCoworkFolder: async (folder, scope, target) => {
        calls.push(`${scope}:${target?.conversationId}:${folder}`);
        granted = true;
        return { state: "granted", folder, name: "notes" };
      },
    },
    { jsdom: true },
  );
  try {
    await env.render(
      wrap(
        h(
          "div",
          null,
          h(CoworkTaskFolderButton, { conversation: remote }),
          h(FolderAccessHost, { platform: "linux" }),
        ),
      ),
    );
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    await env.click('button[aria-label="Add folder"]');
    await settle();
    assert.ok(env.document.querySelector('input[role="combobox"]'));
    await env.click('[role="option"]');
    assert.ok(listed.includes("/execution/notes/"));
    assert.equal(
      env.document.querySelector(".task-folder-list > p")?.textContent,
      "No folders",
    );
    await env.click(".task-folder-browser .primary");
    assert.ok(env.document.querySelector(".cowork-access-dialog"));
    assert.equal(
      env.document.querySelector('.task-folder-browser[aria-modal="true"]'),
      null,
      "the non-modal access card must not sit outside an active aria-modal picker",
    );
    await env.click(".cowork-access-allow");
    assert.deepEqual(calls, ["session:folder-chat:/execution/notes"]);
    assert.equal(env.document.querySelector(".task-folder-browser"), null);
  } finally {
    await env.clean();
    resetFolderAccessForTests();
  }
});

test("34: real path combobox supports down/up, open, parent, exact typed selection, Tab completion, Enter and IME guards", async () => {
  const chosen: string[] = [];
  let closes = 0;
  const listDirectory = async (
    directory: string,
  ): Promise<TaskFolderDirectory> =>
    directory === "/execution/notes/"
      ? {
          path: "/execution/notes",
          parent: "/execution",
          directories: ["inner"],
        }
      : { path: "/execution", directories: ["notes", "news", "empty"] };
  const env = await routineDom({}, { jsdom: true });
  try {
    await env.render(
      h(TaskFolderBrowser, {
        capability,
        listDirectory,
        onSelect: async (path) => {
          chosen.push(path);
          return true;
        },
        onClose: () => {
          closes++;
        },
      }),
    );
    const input = () => env.document.querySelector('input[role="combobox"]')!;
    await env.event(input(), "keydown", { key: "ArrowDown" });
    assert.equal(
      env.document.querySelector('[aria-selected="true"] span')?.textContent,
      "notes",
    );
    await env.event(input(), "keydown", { key: "ArrowRight" });
    assert.equal((input() as HTMLInputElement).value, "/execution/notes/");
    await env.event(input(), "keydown", { key: "ArrowUp" });
    assert.ok(
      env.document.querySelector(
        '[aria-label="Parent folder"][aria-selected="true"]',
      ),
    );
    await env.event(input(), "keydown", { key: "Enter" });
    assert.equal((input() as HTMLInputElement).value, "/execution/");
    await env.change('input[role="combobox"]', "/execution/ne");
    await env.event(input(), "keydown", { key: "Tab" });
    assert.equal((input() as HTMLInputElement).value, "/execution/news/");
    await env.event(input(), "keydown", { key: "Tab", shiftKey: true });
    await env.change('input[role="combobox"]', "/execution/notes");
    await env.event(input(), "keydown", { key: "Enter", isComposing: true });
    assert.deepEqual(chosen, []);
    await env.event(input(), "keydown", { key: "Enter" });
    assert.deepEqual(chosen, ["/execution/notes"]);
    assert.equal(closes, 1);
  } finally {
    await env.clean();
  }
});

test("34/35: directory loading/error is distinct from empty, Retry keeps old rows and failed select remains retryable", async () => {
  const pending = deferred<TaskFolderDirectory>();
  let reads = 0,
    selections = 0;
  const listDirectory = async () => {
    reads++;
    if (reads === 1) return pending.promise;
    return { path: "/execution", directories: ["notes"] };
  };
  const env = await routineDom({}, { jsdom: true });
  try {
    await env.render(
      h(TaskFolderBrowser, {
        capability,
        listDirectory,
        onSelect: async () => {
          selections++;
          throw Error("permission refused");
        },
        onClose() {},
      }),
    );
    assert.ok(env.document.querySelector('[role="listbox"][aria-busy="true"]'));
    assert.equal(env.document.querySelector(".task-folder-list > p"), null);
    assert.ok(env.document.querySelector(".primary:disabled"));
    await act(async () => pending.reject(Error("path not available")));
    assert.equal(
      env.document.querySelector('[role="alert"] p')?.textContent,
      "path not available",
    );
    await env.click(".task-folder-error button");
    assert.equal(reads, 2);
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    await env.click(".primary");
    assert.equal(selections, 1);
    assert.ok(
      env.document
        .querySelector('[role="alert"]')
        ?.textContent?.includes("permission refused"),
    );
    assert.ok(env.document.querySelector('[role="option"]'));
    await env.click(".primary");
    assert.equal(selections, 2);
  } finally {
    await env.clean();
  }
});

test("35: event refresh/retry retains loaded context; account and bridge replacement reject earlier results and events", async () => {
  let callback: ((event: any) => void) | undefined;
  const next = deferred<TaskFolderSnapshot>();
  let reads = 0;
  const env = await routineDom({
    coworkFolders: () =>
      ++reads === 1
        ? Promise.resolve({ primary: "/execution", extra: ["/execution/old"] })
        : next.promise,
    onEvent: (fn) => {
      callback = fn;
      return () => {
        callback = undefined;
      };
    },
  });
  function Context() {
    const state = useTaskFolderState(remote, true);
    return h(
      "div",
      null,
      h(
        "output",
        { "data-state": state.status },
        state.folders?.extra.join(","),
      ),
      h("button", { onClick: state.retry }, "Retry"),
    );
  }
  const first = { accountId: "first", controllerScope: {} } as AppController;
  try {
    await env.render(wrap(h(Context), false, first));
    await act(async () =>
      callback!({ type: "cowork-folders", conversationId: remote.id }),
    );
    assert.equal(
      env.document.querySelector("output")?.getAttribute("data-state"),
      "loading",
    );
    assert.equal(
      env.document.querySelector("output")?.textContent,
      "/execution/old",
    );
    await act(async () => next.reject(Error("connection lost")));
    assert.equal(
      env.document.querySelector("output")?.getAttribute("data-state"),
      "error",
    );
    assert.equal(
      env.document.querySelector("output")?.textContent,
      "/execution/old",
    );
    const stale = deferred<TaskFolderSnapshot>();
    env.window.desktop = {
      ...env.window.desktop,
      coworkFolders: () => stale.promise,
    };
    await env.render(wrap(h(Context), false, first));
    assert.equal(env.document.querySelector("output")?.textContent, "");
    env.window.desktop = {
      ...env.window.desktop,
      coworkFolders: async () => ({ extra: ["/execution/new"] }),
    };
    await env.render(
      wrap(h(Context), false, {
        accountId: "second",
        controllerScope: {},
      } as AppController),
    );
    await act(async () => stale.resolve({ extra: ["/other-account/leaked"] }));
    assert.equal(
      env.document.querySelector("output")?.textContent,
      "/execution/new",
    );
  } finally {
    await env.clean();
  }
});

test("33/34: unknown remote capability is explicit unsupported; malformed grant answer rejects without declaring success", async () => {
  const env = await routineDom({ coworkFolders: async () => ({ extra: [] }) });
  try {
    await env.render(wrap(h(CoworkTaskFolderButton, { conversation: remote })));
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Folder access is unavailable for this session."]:disabled',
      ),
    );
    await assert.rejects(
      addCoworkTaskFolder(conversation, {
        folder: "/chosen",
        api: {
          chooseFolder: async () => {
            throw Error("unexpected chooser");
          },
          coworkFolderAccess: async () => ({
            state: "trusted",
            folder: "/chosen",
            name: "chosen",
          }),
          grantCoworkFolder: async () => ({
            state: "refused",
            folder: "/chosen",
            name: "chosen",
            reason: "grant rejected",
          }),
        },
      }),
      /grant rejected/,
    );
  } finally {
    await env.clean();
  }
});

test("35: a failed directory revisit preserves its successful cached rows through Retry without enabling selection", async () => {
  let rootReads = 0;
  const revisit = deferred<TaskFolderDirectory>();
  const listDirectory = async (
    directory: string,
  ): Promise<TaskFolderDirectory> => {
    if (directory === "/execution/notes/")
      return {
        path: "/execution/notes",
        parent: "/execution",
        directories: [],
      };
    rootReads++;
    if (rootReads === 2) return revisit.promise;
    return { path: "/execution", directories: ["notes"] };
  };
  const env = await routineDom({}, { jsdom: true });
  try {
    await env.render(
      h(TaskFolderBrowser, {
        capability,
        listDirectory,
        onSelect: async () => true,
        onClose() {},
      }),
    );
    await env.click('[role="option"]');
    await env.click('[aria-label="Parent folder"]');
    assert.ok(env.document.querySelector('[role="listbox"][aria-busy="true"]'));
    assert.equal(
      env.document.querySelector('[role="option"] span')?.textContent,
      "notes",
    );
    await act(async () => revisit.reject(Error("connection lost")));
    assert.equal(
      env.document.querySelector('[role="option"] span')?.textContent,
      "notes",
    );
    assert.ok(env.document.querySelector(".primary:disabled"));
    assert.equal(env.document.querySelector(".task-folder-list > p"), null);
    await env.click(".task-folder-error button");
    assert.equal(rootReads, 3);
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.ok(env.document.querySelector(".primary:not(:disabled)"));
  } finally {
    await env.clean();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import type { AppController } from "../../src/app/AppContext";
import type { Conversation, Project } from "../../shared/types";
import { desktopHost, webHost } from "../../shared/host";
import {
  applyNativeDefaultPlace,
  invalidateNativeDefaultPlace,
} from "../../src/composer/native-default-place";
import {
  nativeDefaultFolder,
  setNativeDefaultFolder,
} from "../../src/composer/native-place-preferences";
import {
  setDefaultProjectId,
  writeProjectPickerPreference,
} from "../../src/composer/project-picker-preferences";
import { readFileSync } from "node:fs";
import { readSource } from "../support/read-source";

let next = 0;
function fixture() {
  const folder = "/tmp/native-default-reference";
  const selected: string[] = [];
  const app = {
    accountId: `native-default-${++next}`,
    controllerScope: {},
    draftSession: "one",
    host: desktopHost,
    mode: "chat",
    page: "chat",
    incognitoShown: false,
    sending: false,
    activeId: undefined,
    projectId: undefined,
    cwd: undefined,
    snapshot: {
      conversations: [
        {
          id: "history",
          mode: "chat",
          cwd: folder,
          updatedAt: 1,
          archived: false,
          incognito: false,
        } as Conversation,
      ],
      projects: [] as Project[],
    },
    notify() {},
    setCwd(this: AppController, value: string) {
      this.cwd = value;
      selected.push(value);
    },
    async addConversationToProject(this: AppController, id: string) {
      this.projectId = id;
      this.setCwd(this.snapshot.projects.find((p) => p.id === id)!.cwd!);
    },
  } as unknown as AppController;
  const ref = { current: app as AppController | undefined };
  const expected = {
    accountId: app.accountId,
    scope: app.controllerScope!,
    draftSession: app.draftSession,
  };
  setNativeDefaultFolder(app.accountId, folder, app.snapshot.conversations);
  return { app, ref, expected, folder, selected };
}
test("a native remembered folder is actually applied only after authorization and one request survives effect replay", async () => {
  const f = fixture();
  let calls = 0;
  let settle!: (value: "granted" | "cancelled") => void;
  const auth = async () => {
    calls++;
    return new Promise<"granted" | "cancelled">((resolve) => {
      settle = resolve;
    });
  };
  const one = applyNativeDefaultPlace(f.ref, f.expected, auth),
    two = applyNativeDefaultPlace(f.ref, f.expected, auth);
  assert.equal(one, two);
  assert.equal(calls, 1);
  assert.equal(f.app.cwd, undefined);
  settle("granted");
  assert.equal(await one, true);
  assert.deepEqual(f.selected, [f.folder]);
});
test("cancelled or failed native default authorization never writes cwd", async () => {
  const cancelled = fixture();
  assert.equal(
    await applyNativeDefaultPlace(
      cancelled.ref,
      cancelled.expected,
      async () => "cancelled",
    ),
    false,
  );
  assert.equal(cancelled.app.cwd, undefined);
  const failed = fixture();
  await assert.rejects(
    applyNativeDefaultPlace(failed.ref, failed.expected, async () => {
      throw Error("rejected");
    }),
    /rejected/,
  );
  assert.equal(failed.app.cwd, undefined);
});
test("missing and other-account defaults never request permission", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.app.accountId = "another-account";
      f.expected.accountId = f.app.accountId;
    },
    (f: ReturnType<typeof fixture>) => {
      setNativeDefaultFolder(
        f.app.accountId,
        undefined,
        f.app.snapshot.conversations,
      );
    },
    (f: ReturnType<typeof fixture>) => {
      writeProjectPickerPreference(f.app.accountId, "folder", "/tmp/unknown");
    },
  ]) {
    const f = fixture();
    mutate(f);
    let calls = 0;
    assert.equal(
      await applyNativeDefaultPlace(f.ref, f.expected, async () => {
        calls++;
        return "granted";
      }),
      false,
    );
    assert.equal(calls, 0);
  }
});
const invalidations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  account: (f) => {
    f.app.accountId = "switched";
  },
  scope: (f) => {
    f.app.controllerScope = {};
  },
  draft: (f) => {
    f.app.draftSession = "two";
  },
  incognito: (f) => {
    f.app.incognitoShown = true;
  },
  code: (f) => {
    f.app.mode = "code";
  },
  web: (f) => {
    f.app.host = webHost;
  },
  conversation: (f) => {
    f.app.activeId = "opened";
  },
  sending: (f) => {
    f.app.sending = true;
  },
  folder: (f) => {
    f.app.cwd = "/tmp/explicit";
  },
  project: (f) => {
    f.app.projectId = "explicit";
  },
  page: (f) => {
    f.app.page = "artifacts";
  },
  unmount: (f) => {
    f.ref.current = undefined;
  },
  history: (f) => {
    f.app.snapshot.conversations = [];
  },
  space: (f) => {
    f.app.snapshot.conversations[0].environment = {
      kind: "space",
      spaceId: "cloud",
    };
  },
  ssh: (f) => {
    f.app.snapshot.conversations[0].environment = {
      kind: "ssh",
      hostId: "remote",
    };
  },
  privateHistory: (f) => {
    f.app.snapshot.conversations[0].incognito = true;
  },
  preference: (f) => {
    setNativeDefaultFolder(
      f.app.accountId,
      undefined,
      f.app.snapshot.conversations,
    );
  },
  explicitChoice: (f) => {
    invalidateNativeDefaultPlace(f.app);
  },
};
for (const [name, mutate] of Object.entries(invalidations))
  test(`late native default grant is discarded after ${name}`, async () => {
    const f = fixture();
    let settle!: (value: "granted") => void;
    const pending = applyNativeDefaultPlace(
      f.ref,
      f.expected,
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    mutate(f);
    settle("granted");
    assert.equal(await pending, false);
    assert.deepEqual(f.selected, []);
  });
test("invalid initial native history (space, SSH, incognito, remote device) never reaches local authorization", async () => {
  for (const extra of [
    { environment: { kind: "space", spaceId: "s" } },
    { environment: { kind: "ssh", hostId: "r" } },
    { incognito: true },
    { linkedToComputer: true },
  ]) {
    const f = fixture();
    Object.assign(f.app.snapshot.conversations[0], extra);
    let calls = 0;
    assert.equal(
      await applyNativeDefaultPlace(f.ref, f.expected, async () => {
        calls++;
        return "granted";
      }),
      false,
    );
    assert.equal(calls, 0);
  }
});
test("a cwd project default preserves its project context but still waits for folder authorization", async () => {
  const f = fixture();
  const project = {
    id: "default-project",
    name: "Project",
    createdAt: 1,
    cwd: f.folder,
    description: "",
    instructions: "context",
  };
  f.app.snapshot.projects = [project];
  setDefaultProjectId(f.app.accountId, project.id);
  assert.equal(nativeDefaultFolder(f.app.accountId), undefined);
  let args: unknown;
  const accepted = await applyNativeDefaultPlace(
    f.ref,
    f.expected,
    async (path, options) => {
      args = [path, options?.projectId];
      assert.equal(f.app.projectId, undefined);
      assert.equal(f.app.cwd, undefined);
      return "granted";
    },
  );
  assert.equal(accepted, true);
  assert.deepEqual(args, [f.folder, project.id]);
  assert.equal(f.app.projectId, project.id);
  assert.equal(f.app.cwd, f.folder);
});
function freshProjectFixture() {
  const f = fixture();
  f.app.snapshot.conversations = [];
  const project: Project = {
    id: "fresh-project",
    name: "Fresh project",
    createdAt: 1,
    cwd: f.folder,
    description: "",
    instructions: "fresh context",
    environment: { kind: "local" },
  };
  f.app.snapshot.projects = [project];
  setDefaultProjectId(f.app.accountId, project.id);
  return { ...f, project };
}
test("a live local cwd project without any conversation history is authorized before its default is applied", async () => {
  const f = freshProjectFixture();
  let settle!: (value: "granted") => void;
  let target: unknown;
  const pending = applyNativeDefaultPlace(
    f.ref,
    f.expected,
    (path, options) => {
      target = [path, options?.projectId];
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  );
  assert.deepEqual(target, [f.folder, f.project.id]);
  assert.equal(f.app.projectId, undefined);
  assert.equal(f.app.cwd, undefined);
  settle("granted");
  assert.equal(await pending, true);
  assert.equal(f.app.projectId, f.project.id);
  assert.equal(f.app.cwd, f.folder);
});
test("cancelling authorization for a fresh cwd project does not select it or its folder", async () => {
  const f = freshProjectFixture();
  assert.equal(
    await applyNativeDefaultPlace(f.ref, f.expected, async () => "cancelled"),
    false,
  );
  assert.equal(f.app.projectId, undefined);
  assert.equal(f.app.cwd, undefined);
});
test("a real refused folder-access result rejects a fresh project default before either context changes", async () => {
  const f = freshProjectFixture();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  let calls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        async coworkFolderAccess(
          path: string,
          _conversation: unknown,
          projectId: string,
        ) {
          calls++;
          assert.equal(path, f.folder);
          assert.equal(projectId, f.project.id);
          return { state: "refused", reason: "Unavailable" };
        },
      },
    },
  });
  try {
    assert.equal(await applyNativeDefaultPlace(f.ref, f.expected), false);
    assert.equal(calls, 1);
    assert.equal(f.app.projectId, undefined);
    assert.equal(f.app.cwd, undefined);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
const changedProjects: Record<
  string,
  (f: ReturnType<typeof freshProjectFixture>) => void
> = {
  deleted: (f) => {
    f.app.snapshot.projects = [];
  },
  cwd: (f) => {
    f.project.cwd = "/tmp/replaced-project-folder";
  },
  archived: (f) => {
    f.project.archivedAt = 1;
  },
  id: (f) => {
    f.project.id = "replaced-project";
  },
  space: (f) => {
    f.project.environment = { kind: "space", spaceId: "cloud" };
  },
  ssh: (f) => {
    f.project.environment = { kind: "ssh", hostId: "remote" };
  },
  environment: (f) => {
    f.project.environment = undefined;
  },
};
for (const [change, mutate] of Object.entries(changedProjects))
  test(`fresh project default grant is discarded after project ${change}`, async () => {
    const f = freshProjectFixture();
    let settle!: (value: "granted") => void;
    const pending = applyNativeDefaultPlace(
      f.ref,
      f.expected,
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    mutate(f);
    settle("granted");
    assert.equal(await pending, false);
    assert.equal(f.app.projectId, undefined);
    assert.equal(f.app.cwd, undefined);
  });
test("App starts native default application after committed draft and defers cwd-project defaults", () => {
  const app = readSource("src/app/App.tsx").replace(/\s+/g, " ");
  assert.match(app, /defaultId: buildSurface !== "web"[^\n]+p\.cwd/);
  assert.match(
    app,
    /if \(buildSurface === "web" \|\| activeId \|\| mode === "code" \|\| incognito\) return/,
  );
  assert.match(
    app,
    /applyNativeDefaultPlace\( ?currentController, \{ accountId, scope: controllerScope, draftSession,? \}\)/,
  );
});

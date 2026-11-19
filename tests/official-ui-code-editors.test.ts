/** No OS editor inventory or launches: all services below are inert mocks. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCodeEditors,
  registerCodeEditors,
} from "../electron/official-ui/native/code-editors";
import type { AdapterContext } from "../electron/official-ui/api/context";
import type { Conversation } from "../shared/types";
function fixture() {
  const c: Conversation = {
    id: "code",
    mode: "code",
    title: "Code",
    cwd: "/owned/work",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    providerId: "p",
    model: "m",
    turns: [],
  };
  let owner = "a",
    identity = {},
    rows = [c],
    inventory: unknown = [
      { kind: "vscode", name: "VS Code", installed: true },
      { kind: "cursor", name: "Cursor", installed: false },
    ],
    result: unknown = true,
    fail = false,
    readOnly = false,
    gate: Promise<void> | undefined;
  const calls: unknown[][] = [];
  const ctx = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    isCurrent: () => true,
    get readOnly() {
      return readOnly;
    },
    localListConversations: async () => {
      await gate;
      return rows;
    },
    localLoadConversation: async (id: string) => rows.find((c) => c.id === id),
    localCall: async (name: string, ...args: unknown[]) => {
      calls.push([name, ...args]);
      if (fail) throw Error("service unavailable");
      if (name === "installedEditors") {
        await gate;
        return inventory;
      }
      assert.equal(name, "openConversationInEditor");
      return result;
    },
  } as unknown as AdapterContext;
  return {
    c,
    ctx,
    calls,
    api: createCodeEditors(ctx),
    rows: (value: Conversation[]) => {
      rows = value;
    },
    inventory: (value: unknown) => {
      inventory = value;
    },
    result: (value: unknown) => {
      result = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    gate: (value: Promise<void>) => {
      gate = value;
    },
    retire: () => {
      identity = {};
    },
    switch: () => {
      owner = "b";
      identity = {};
    },
    readOnly: () => {
      readOnly = true;
    },
  };
}
test("actual inventory maps official type/name/installed and errors are not empty success", async () => {
  const f = fixture();
  assert.deepEqual(await f.api.list(), [
    { type: "vscode", name: "VS Code", installed: true },
    { type: "cursor", name: "Cursor", installed: false },
  ]);
  f.fail(true);
  await assert.rejects(f.api.list(), /service unavailable/);
  f.fail(false);
  f.inventory([]);
  assert.deepEqual(await f.api.list(), []);
  for (const rows of [
    null,
    [{ kind: "vscode", name: "Code" }],
    [{ kind: "arbitrary", name: "Other", installed: true }],
    [
      { kind: "vscode", name: "A", installed: true },
      { kind: "vscode", name: "B", installed: false },
    ],
  ]) {
    f.inventory(rows);
    await assert.rejects(f.api.list());
  }
});
test("folder Open uses unique real session identity, never forwards the supplied path", async () => {
  const f = fixture();
  assert.equal(await f.api.open("/owned/work", "vscode"), true);
  assert.deepEqual(f.calls, [["openConversationInEditor", "code", "vscode"]]);
  f.result(false);
  assert.equal(await f.api.open("/owned/work", "vscode"), false);
  f.result(undefined);
  await assert.rejects(f.api.open("/owned/work", "vscode"), /outcome/);
});
test("the active Code window opens its files and shared workspace by session identity", async () => {
  const f = fixture();
  f.rows([f.c, { ...f.c, id: "second" }]);
  let current = true;
  const api = createCodeEditors(f.ctx, () => ({
    sessionId: "second",
    current: () => current,
  }));
  assert.equal(
    await api.open("/owned/work/note.txt", "vscode", undefined, 4),
    true,
  );
  assert.equal(await api.open("/owned/work", "vscode"), true);
  const calls = f.calls as [
    string,
    string,
    string,
    undefined,
    { target: string; line?: number; current(): boolean },
  ][];
  assert.deepEqual(
    calls.map(([name, id, editor, , request]) => [
      name,
      id,
      editor,
      request.target,
      request.line,
    ]),
    [
      [
        "openConversationInEditor",
        "second",
        "vscode",
        "/owned/work/note.txt",
        4,
      ],
      [
        "openConversationInEditor",
        "second",
        "vscode",
        "/owned/work",
        undefined,
      ],
    ],
  );
  current = false;
  assert.equal(calls[0][4].current(), false);
  await assert.rejects(api.open("/owned/work/note.txt", "vscode"));
});
test("an active Code window preserves exact folder choices from other owned session entries", async () => {
  const f = fixture();
  f.rows([f.c, { ...f.c, id: "other", cwd: "/owned/other" }]);
  const api = createCodeEditors(f.ctx, () => ({
    sessionId: f.c.id,
    current: () => true,
  }));
  assert.equal(await api.open("/owned/other", "vscode"), true);
  assert.deepEqual(f.calls[0].slice(0, 3), [
    "openConversationInEditor",
    "other",
    "vscode",
  ]);
  f.result(false);
  assert.equal(
    await api.open("/owned/other/note.txt", "vscode", undefined, 3),
    false,
  );
  assert.deepEqual(f.calls[1].slice(0, 3), [
    "openConversationInEditor",
    "code",
    "vscode",
  ]);
});
test("the window binds saved SSH editor targets and refuses unrelated hosts", async () => {
  const f = fixture();
  f.c.environment = { kind: "ssh", hostId: "saved" };
  const resolved = f.ctx.localCall!;
  let hostId = "saved";
  f.ctx.localCall = async (name, ...args) =>
    name === "officialSshTarget"
      ? { kind: "ssh", hostId }
      : resolved(name, ...args);
  const api = createCodeEditors(f.ctx, () => ({
    sessionId: f.c.id,
    current: () => true,
  }));
  const ssh = { sshHost: "user@host", sshPort: 2222 };
  assert.equal(await api.open("/owned/work/note.txt", "vscode", ssh, 3), true);
  const request = f.calls[0].at(-1);
  assert.ok(request && typeof request === "object" && "ssh" in request);
  assert.deepEqual(request.ssh, { hostId, ...ssh });
  hostId = "other";
  await assert.rejects(
    api.open("/owned/work/note.txt", "vscode", ssh),
    /SSH connection changed/,
  );
  assert.equal(f.calls.length, 1);
});
test("arbitrary paths, files, ambiguous roots, unsupported editors/options, remote and readonly targets never launch", async () => {
  for (const target of [
    "/outside",
    "/owned/work/note.txt",
    "/owned/work/link",
    "relative",
    null,
    "/owned/work\0",
  ]) {
    const f = fixture();
    await assert.rejects(f.api.open(target, "vscode"));
    assert.equal(f.calls.length, 0);
  }
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.rows([f.c, { ...f.c, id: "other" }]),
    (f: ReturnType<typeof fixture>) => {
      f.c.mode = "cowork";
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.cloudHosted = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.environment = { kind: "ssh", hostId: "remote" };
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.sessionAuthors = {
        ownerAccountUuid: "other",
        viewerAccountUuid: "a",
      };
    },
    (f: ReturnType<typeof fixture>) => f.readOnly(),
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.api.open("/owned/work", "vscode"));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.api.open("/owned/work", "not-editor"));
  await assert.rejects(f.api.open("/owned/work", "vscode", 1));
  assert.equal(f.calls.length, 0);
});
test("account switch and same-account reactivation retire delayed inventories and folder opens", async () => {
  for (const op of ["list", "open"] as const)
    for (const change of ["retire", "switch"] as const) {
      const f = fixture();
      let release!: () => void;
      f.gate(new Promise<void>((r) => (release = r)));
      const pending = assert.rejects(
        op === "list" ? f.api.list() : f.api.open("/owned/work", "vscode"),
        /account changed/,
      );
      f[change]();
      release();
      await pending;
      assert.equal(
        f.calls.filter((c) => c[0] === "openConversationInEditor").length,
        0,
      );
    }
});
test("changed cwd after inventory cannot select a replacement folder; exact native names are registered", async () => {
  const f = fixture();
  f.ctx.localListConversations = async () => [structuredClone(f.c)];
  f.ctx.localLoadConversation = async () => ({ ...f.c, cwd: "/different" });
  await assert.rejects(f.api.open("/owned/work", "vscode"), /session changed/);
  assert.equal(f.calls.length, 0);
  const handlers = new Map<string, unknown>();
  registerCodeEditors({
    ctx: f.ctx,
    on: (name: string, fn: unknown) => handlers.set(name, fn),
  } as never);
  assert.deepEqual(
    [...handlers.keys()],
    ["LocalSessions.getInstalledEditors", "LocalSessions.openInEditor"],
  );
});

test("mutable inventory objects cannot change the captured editor target during refresh", async () => {
  const f = fixture();
  f.ctx.localLoadConversation = async () => {
    f.c.cwd = "/replacement";
    return f.c;
  };
  await assert.rejects(f.api.open("/owned/work", "vscode"), /session changed/);
  assert.equal(f.calls.length, 0);
});

test("bounded PNG data-URL fields map to official iconDataUrl; arbitrary URL/CSS payloads fail", async () => {
  const f = fixture();
  const icon =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  f.inventory([{ kind: "windsurf", name: "Windsurf", installed: true, icon }]);
  assert.deepEqual(await f.api.list(), [
    { type: "windsurf", name: "Windsurf", installed: true, iconDataUrl: icon },
  ]);
  for (const bad of [
    "https://untrusted.test/icon.png",
    'data:image/png;base64,x" );url(https://untrusted.test)',
    "data:image/svg+xml;base64,aGVsbG8=",
  ]) {
    f.inventory([
      { kind: "windsurf", name: "Windsurf", installed: true, icon: bad },
    ]);
    await assert.rejects(f.api.list());
  }
});

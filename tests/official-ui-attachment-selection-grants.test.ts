import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import {
  AttachmentSelectionGrants,
  CoworkDraftSelectionTransition,
  attachmentSelectionRoute,
  observeAttachmentSelectionNavigation,
  acceptAttachmentSelection,
  verifyAttachmentSelectionFrame,
} from "../electron/official-ui/native/attachment-selection-grants";

test("Cowork draft selection survives only its one optimistic session transition", () => {
  const transition = new CoworkDraftSelectionTransition();
  const window = {};
  const origin = "http://localhost:1234";
  const id = "local_11111111-1111-4111-8111-111111111111";
  const destination = `${origin}/cowork/${id}`;
  transition.selected(window, "1:/new", origin);
  assert.equal(transition.navigate(window, destination, "start"), true);
  assert.equal(transition.navigate(window, destination, "in-page"), true);
  assert.equal(transition.take(window, destination, id), "1:/new");
  assert.equal(transition.take(window, destination, id), undefined);
  transition.selected(window, "1:/new", origin);
  assert.equal(transition.navigate(window, destination, "in-page"), true);
  assert.equal(transition.take(window, destination, "local_other"), undefined);
  assert.equal(transition.take(window, destination, id), undefined);
  for (const [url, phase] of [
    [destination, "document"],
    [`${origin}/new`, "in-page"],
    [`https://evil.invalid/cowork/${id}`, "in-page"],
  ] as const) {
    transition.selected(window, "1:/new", origin);
    assert.equal(transition.navigate(window, url, phase), false);
    assert.equal(transition.take(window, destination, id), undefined);
  }
  transition.selected(window, "1:/new", origin);
  assert.equal(transition.navigate(window, destination, "in-page"), true);
  assert.equal(transition.navigate(window, `${origin}/new`, "in-page"), false);
  assert.equal(transition.take(window, destination, id), undefined);
});

test("private selection IPC independently enforces top frame, exact origin and Cowork surface", () => {
  const frame = { url: "http://localhost:1234/task/new" };
  const event = { sender: { mainFrame: frame }, senderFrame: frame };
  assert.doesNotThrow(() =>
    verifyAttachmentSelectionFrame(event, "http://localhost:1234"),
  );
  frame.url = "http://localhost:1234/cowork/local_11111111-1111-4111-8111-111111111111";
  assert.doesNotThrow(() =>
    verifyAttachmentSelectionFrame(event, "http://localhost:1234"),
  );
  for (const query of ["?mode=cowork", "?mode=cowork&surface=cowork"]) {
    frame.url = `http://localhost:1234/new${query}`;
    assert.doesNotThrow(() =>
      verifyAttachmentSelectionFrame(event, "http://localhost:1234"),
    );
  }
  assert.throws(
    () =>
      verifyAttachmentSelectionFrame(
        { ...event, senderFrame: null },
        "http://localhost:1234",
      ),
    /frame/,
  );
  assert.throws(
    () =>
      verifyAttachmentSelectionFrame(
        { ...event, senderFrame: { ...frame } },
        "http://localhost:1234",
      ),
    /frame/,
  );
  for (const url of [
    "https://evil.invalid/task/new",
    "http://localhost:4321/task/new",
    "http://localhost:1234/settings",
    "http://localhost:1234/task-other",
    "http://localhost:1234/cowork/new",
    "http://localhost:1234/new",
    "http://localhost:1234/new?surface=cowork",
    "http://localhost:1234/new?mode=chat",
    "http://localhost:1234/new?mode=cowork&surface=chat",
    "http://localhost:1234/new?mode=cowork&mode=chat",
  ]) {
    frame.url = url;
    assert.throws(
      () => verifyAttachmentSelectionFrame(event, "http://localhost:1234"),
      /origin or surface/,
    );
  }
});
import { storeCoworkAttachments } from "../electron/official-ui/native/cowork-attachments";
import { registerOfficialAttachmentHandlers } from "../electron/ipc/official-attachments";
import { openPolicy } from "../shared/client-policy";

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "file-selection-unit-")),
  );
  const file = path.join(root, "selected.txt");
  fs.writeFileSync(file, "selected fixture");
  let identity: { owner: string; activation: object } = {
      owner: "a",
      activation: {},
    },
    now = 1000;
  const grants = new AttachmentSelectionGrants(
      () => identity,
      () => now,
    ),
    window = {};
  return {
    root,
    file,
    grants,
    window,
    expire: () => {
      now += 120001;
    },
    switch: (owner = "b") => {
      identity = { owner, activation: {} };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("optimistic transition does not bypass attachment expiry or account identity", () => {
  for (const invalidate of ["expire", "switch"] as const) {
    const f = fixture();
    try {
      const transition = new CoworkDraftSelectionTransition();
      const origin = "http://localhost:1234";
      const id = "local_11111111-1111-4111-8111-111111111111";
      const destination = `${origin}/cowork/${id}`;
      f.grants.grant(f.window, [f.file], "1:/new");
      transition.selected(f.window, "1:/new", origin);
      assert.equal(transition.navigate(f.window, destination, "in-page"), true);
      f[invalidate]();
      const scope = transition.take(f.window, destination, id);
      assert.equal(scope, "1:/new");
      assert.throws(
        () => f.grants.take(f.window, [f.file], 100, scope),
        /Select/,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("selected-file grants are single-use, window-bound and expire", () => {
  const f = fixture();
  try {
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
    f.grants.grant(f.window, [f.file]);
    assert.throws(() => f.grants.take({}, [f.file]), /Select/);
    assert.equal(
      Buffer.from(f.grants.take(f.window, [f.file])[0].data).toString(),
      "selected fixture",
    );
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
    f.grants.grant(f.window, [f.file]);
    f.expire();
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
  } finally {
    f.cleanup();
  }
});

test("account reactivation and window close revoke selected-file grants", () => {
  const f = fixture();
  try {
    f.grants.grant(f.window, [f.file]);
    f.switch("a");
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
    f.grants.grant(f.window, [f.file]);
    f.switch();
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
    f.grants.grant(f.window, [f.file]);
    f.grants.revokeWindow(f.window);
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
  } finally {
    f.cleanup();
  }
});

test("changed files, symlinks, invalid counts and batches fail closed", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.grants.grant(f.window, [f.file, f.file]),
      /Duplicate/,
    );
    assert.throws(
      () => f.grants.grant(f.window, Array(13).fill(f.file)),
      /Invalid/,
    );
    f.grants.grant(f.window, [f.file]);
    fs.writeFileSync(f.file, "changed contents");
    assert.throws(() => f.grants.take(f.window, [f.file]), /changed/);
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
    const link = path.join(f.root, "link.txt");
    fs.symlinkSync(f.file, link);
    assert.throws(() => f.grants.grant(f.window, [link]), /regular/);
    f.grants.grant(f.window, [f.file]);
    assert.throws(() => f.grants.take(f.window, [f.file], 1), /64 MB/);
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
  } finally {
    f.cleanup();
  }
});

test("a symlink swap between lstat and open cannot redirect the authorized file read", () => {
  const f = fixture(),
    original = fs.openSync;
  try {
    const other = path.join(f.root, "not-selected.txt");
    fs.writeFileSync(other, "must not read");
    f.grants.grant(f.window, [f.file]);
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === f.file) {
        fs.unlinkSync(f.file);
        fs.symlinkSync(other, f.file);
      }
      return Reflect.apply(original, fs, args);
    }) as typeof fs.openSync;
    assert.throws(() => f.grants.take(f.window, [f.file]));
    assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
  } finally {
    fs.openSync = original;
    f.cleanup();
  }
});

test("the dedicated IPC gate cannot mint grants when sender verification fails", () => {
  const f = fixture();
  try {
    for (const cause of [
      "unowned window",
      "subframe",
      "wrong origin",
      "destroyed window",
    ]) {
      assert.throws(
        () =>
          acceptAttachmentSelection(
            {},
            [f.file],
            () => {
              throw Error(cause);
            },
            f.grants,
          ),
        new RegExp(cause),
      );
      assert.throws(() => f.grants.take(f.window, [f.file]), /Select/);
    }
    assert.equal(
      acceptAttachmentSelection({}, [f.file], () => f.window, f.grants),
      true,
    );
    assert.equal(f.grants.take(f.window, [f.file]).length, 1);
  } finally {
    f.cleanup();
  }
});

test("selected OS files use the existing host type policy, account storage and consume grants", async () => {
  const f = fixture();
  try {
    const accountRoot = path.join(f.root, "account");
    const handlers = new Map<string, (...args: any[]) => any>(),
      registry = new Map();
    registerOfficialAttachmentHandlers((n, fn) => handlers.set(n, fn), {
      store: { root: accountRoot },
      selectedAttachments: registry,
      policy: () => openPolicy,
    } as never);
    const call = async (n: string, ...args: unknown[]) =>
      handlers.get(n)!(...args);
    const selected = (paths: string[], budget: number) =>
      f.grants.take(f.window, paths, budget);
    f.grants.grant(f.window, [f.file]);
    const stored = await storeCoworkAttachments(
      accountRoot,
      call,
      [],
      [f.file],
      selected,
    );
    assert.equal(stored.length, 1);
    assert.ok(
      stored[0].path.startsWith(
        path.join(accountRoot, "attachments") + path.sep,
      ),
    );
    assert.equal(fs.readFileSync(stored[0].path, "utf8"), "selected fixture");
    await assert.rejects(
      storeCoworkAttachments(accountRoot, call, [], [f.file], selected),
      /Select/,
    );
    const blocked = path.join(f.root, "blocked.exe");
    fs.writeFileSync(blocked, "not executable test bytes");
    f.grants.grant(f.window, [blocked]);
    await assert.rejects(
      storeCoworkAttachments(accountRoot, call, [], [blocked], selected),
    );
    assert.equal(registry.size, 1);
    assert.throws(() => f.grants.take(f.window, [blocked]), /Select/);
  } finally {
    f.cleanup();
  }
});

test("isolated preload capture ignores forged events, fake paths and non-Cowork surfaces", () => {
  const source = fs.readFileSync(
    new URL("../electron/official-ui/page-shim.cjs", import.meta.url),
    "utf8",
  );
  const snippet = source.slice(
    source.indexOf("// The official preload's getPathForFile"),
  );
  const listeners = new Map<string, (event: any) => void>(),
    sent: unknown[][] = [];
  class RealFile {
    constructor(
      readonly size: number,
      readonly nativePath: string,
    ) {}
  }
  class Input {
    type = "file";
    files: unknown[] = [];
  }
  const window: any = {
    addEventListener: (n: string, f: any) => listeners.set(n, f),
  };
  window.top = window;
  const location = { pathname: "/task/new", search: "" };
  vm.runInNewContext(snippet, {
    process: { isMainFrame: false },
    window,
    location,
    URLSearchParams,
    File: RealFile,
    HTMLInputElement: Input,
    require: () => ({
      webUtils: { getPathForFile: (f: RealFile) => f.nativePath },
      ipcRenderer: {
        sendSync: (...a: unknown[]) => {
          sent.push(a);
        },
      },
    }),
  });
  const input = new Input();
  input.files = [new RealFile(1, "/selected.txt")];
  listeners.get("change")!({ type: "change", isTrusted: false, target: input });
  listeners.get("drop")!({
    type: "drop",
    isTrusted: true,
    dataTransfer: { files: [{ path: "/etc/passwd", size: 1 }] },
  });
  input.files = [new RealFile(1, "")];
  listeners.get("change")!({ type: "change", isTrusted: true, target: input });
  input.files = [new RealFile(1, "/selected.txt")];
  location.pathname = "/settings";
  listeners.get("change")!({ type: "change", isTrusted: true, target: input });
  assert.equal(sent.length, 0);
  location.pathname = "/task/new";
  listeners.get("change")!({ type: "change", isTrusted: true, target: input });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "claudex:trusted-file-selection");
  assert.equal(JSON.stringify(sent[0][1]), '["/selected.txt"]');
  location.pathname = "/new";
  for (const search of [
    "",
    "?surface=cowork",
    "?mode=chat",
    "?mode=cowork&surface=chat",
    "?mode=cowork&mode=chat",
  ]) {
    location.search = search;
    listeners.get("change")!({
      type: "change",
      isTrusted: true,
      target: input,
    });
  }
  assert.equal(sent.length, 1);
  location.search = "?mode=cowork";
  listeners.get("change")!({ type: "change", isTrusted: false, target: input });
  assert.equal(sent.length, 1);
  listeners.get("change")!({ type: "change", isTrusted: true, target: input });
  assert.equal(sent.length, 2);
  assert.deepEqual(Object.keys(window).sort(), ["addEventListener", "top"]);
});

test("mixed stored and freshly selected Cowork files retain the user's original order", async () => {
  const f = fixture();
  try {
    const accountRoot = path.join(f.root, "account"),
      last = path.join(f.root, "last.txt");
    fs.writeFileSync(last, "last fixture");
    const handlers = new Map<string, (...args: any[]) => any>();
    registerOfficialAttachmentHandlers((n, fn) => handlers.set(n, fn), {
      store: { root: accountRoot },
      selectedAttachments: new Map(),
      policy: () => openPolicy,
    } as never);
    const call = async (n: string, ...args: unknown[]) =>
      handlers.get(n)!(...args);
    const [one, two] = await call("officialStoreCodeAttachments", [
      { name: "one.txt", data: new Uint8Array([49]) },
      { name: "two.txt", data: new Uint8Array([50]) },
    ]);
    f.grants.grant(f.window, [f.file, last]);
    const result = await storeCoworkAttachments(
      accountRoot,
      call,
      [{ base64: "YQ==", mimeType: "image/png" }],
      [one.path, f.file, two.path, last],
      (files, budget) => f.grants.take(f.window, files, budget),
    );
    assert.deepEqual(
      result.map((a) => a.name),
      ["image-1.png", "one.txt", "selected.txt", "two.txt", "last.txt"],
    );
    assert.equal(result[1].id, one.id);
    assert.equal(result[3].id, two.id);
    assert.equal(fs.readFileSync(result[2].path, "utf8"), "selected fixture");
    assert.equal(fs.readFileSync(result[4].path, "utf8"), "last fixture");
  } finally {
    f.cleanup();
  }
});

test("Cowork keeps the filename when a trusted OS image also arrives inline", async () => {
  const f = fixture();
  try {
    const accountRoot = path.join(f.root, "account");
    const photo = path.join(f.root, "selected-photo.png");
    fs.writeFileSync(photo, new Uint8Array([97]));
    f.grants.grant(f.window, [photo]);
    const handlers = new Map<string, (...args: any[]) => any>();
    registerOfficialAttachmentHandlers((name, fn) => handlers.set(name, fn), {
      store: { root: accountRoot },
      selectedAttachments: new Map(),
      policy: () => openPolicy,
    } as never);
    const result = await storeCoworkAttachments(
      accountRoot,
      async (name, ...args) => handlers.get(name)!(...args),
      [{ base64: "YQ==", mimeType: "image/png" }],
      [photo],
      (files, budget) => f.grants.take(f.window, files, budget),
    );
    assert.deepEqual(
      result.map((file) => file.name),
      ["selected-photo.png"],
    );
    assert.throws(() => f.grants.take(f.window, [photo]), /Select/);
  } finally {
    f.cleanup();
  }
});

test("trusted main-frame route limits selected files to the exact existing or new session", () => {
  const origin = "http://localhost:1234";
  const a = "local_11111111-1111-4111-8111-111111111111";
  const b = "local_22222222-2222-4222-8222-222222222222";
  assert.equal(
    attachmentSelectionRoute(`${origin}/task/${a}`, origin, a),
    `/task/${a}`,
  );
  assert.equal(
    attachmentSelectionRoute(`${origin}/cowork/${a}`, origin, a, "task"),
    `/cowork/${a}`,
  );
  assert.throws(() => attachmentSelectionRoute(`${origin}/cowork/${a}`, origin, a, "epitaxy"));
  assert.equal(
    attachmentSelectionRoute(`${origin}/task/new`, origin, "new"),
    "/task/new",
  );
  for (const query of ["?mode=cowork", "?mode=cowork&surface=cowork"]) {
    assert.equal(
      attachmentSelectionRoute(`${origin}/new${query}`, origin, "new", "task"),
      "/new",
    );
    assert.throws(() =>
      attachmentSelectionRoute(
        `${origin}/new${query}`,
        origin,
        "new",
        "epitaxy",
      ),
    );
    assert.throws(() =>
      attachmentSelectionRoute(`${origin}/new${query}`, origin, a, "task"),
    );
  }
  for (const [url, target] of [
    [`${origin}/task/${a}`, b],
    [`${origin}/cowork/${a}`, b],
    [`${origin}/cowork/${a}`, "new"],
    [`${origin}/task/new`, a],
    [`${origin}/task/${a}`, "new"],
    [`${origin}/task`, "new"],
    [`${origin}/task/${a}/extra`, a],
    [`https://evil.invalid/task/${a}`, a],
    [`${origin}/new`, "new"],
    [`${origin}/new?surface=cowork`, "new"],
    [`${origin}/new?mode=cowork&surface=chat`, "new"],
    [`${origin}/new?mode=cowork&mode=chat`, "new"],
  ])
    assert.throws(() => attachmentSelectionRoute(url, origin, target));
});

test("same-window selection cannot cross session scopes or navigation epochs", () => {
  const f = fixture();
  try {
    f.grants.grant(f.window, [f.file], "1:/task/session-a");
    assert.throws(
      () => f.grants.take(f.window, [f.file], 100, "1:/task/session-b"),
      /Select/,
    );
    assert.throws(
      () => f.grants.take(f.window, [f.file], 100, "2:/task/session-a"),
      /Select/,
    );
    f.grants.revokeWindow(f.window); // production navigation handler revokes before a new page can use it
    assert.throws(
      () => f.grants.take(f.window, [f.file], 100, "1:/task/session-a"),
      /Select/,
    );
    f.grants.grant(f.window, [f.file], "3:/task/new");
    assert.equal(
      f.grants.take(f.window, [f.file], 100, "3:/task/new").length,
      1,
    );
    assert.throws(
      () => f.grants.take(f.window, [f.file], 100, "4:/task/session-a"),
      /Select/,
    );
  } finally {
    f.cleanup();
  }
});

test("production navigation observer revokes main-frame and SPA selections but not subframes", () => {
  const contents = new EventEmitter();
  let epoch = 0;
  const stop = observeAttachmentSelectionNavigation(contents, () => {
    epoch++;
  });
  contents.emit(
    "did-start-navigation",
    {},
    "http://localhost/task/new",
    false,
    false,
  );
  contents.emit("did-navigate-in-page", {}, "http://localhost/task/new", false);
  assert.equal(epoch, 0);
  contents.emit(
    "did-start-navigation",
    {},
    "http://localhost/task/new",
    false,
    true,
  );
  contents.emit("did-navigate-in-page", {}, "http://localhost/task/new", true);
  assert.equal(epoch, 2);
  stop();
  contents.emit(
    "did-start-navigation",
    {},
    "http://localhost/task/new",
    false,
    true,
  );
  assert.equal(epoch, 2);
  assert.equal(contents.listenerCount("did-start-navigation"), 0);
  assert.equal(contents.listenerCount("did-navigate-in-page"), 0);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { build } from "esbuild";

const source = fileURLToPath(new URL("../../", import.meta.url));
const bundleRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "skill-upload-bundle-"),
);
let runtime: any;
before(async () => {
  const outfile = path.join(bundleRoot, "runtime.mjs");
  await build({
    stdin: {
      contents:
        'export {registerSkillHandlers} from "./electron/ipc/skills"; export {Store} from "./electron/store/store"; export {boundary} from "electron";',
      resolveDir: source,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    banner: {
      js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "synthetic-desktop-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `
        export const boundary = {};
        export const dialog = {showOpenDialog: (...args) => boundary.dialog(...args)};
        export const shell = {};
        class Notification {
          static isSupported() { return boundary.supported(); }
          constructor(notice) { this.notice = notice; this.events = {}; boundary.notifications.push(this); }
          on(name, fn) { this.events[name] = fn; }
          show() { boundary.shown.push(this.notice); }
        }
        export default {Notification};
      `,
          }));
        },
      },
    ],
  });
  runtime = await import(pathToFileURL(outfile).href);
});
after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const operations = ["installSkillFiles", "importSkillFiles"] as const;
type Operation = (typeof operations)[number];
const changes = ["switch", "retire", "reactivate"] as const;
type Change = (typeof changes)[number];
function upload(name = "fixture") {
  return {
    name: `${name}.md`,
    data: Buffer.from(`---\nname: ${name}\n---\nSynthetic upload ${name}\n`),
  };
}
function fixture(t: test.TestContext, desktop = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-upload-owned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = new runtime.Store(path.join(root, "account-a"));
  const b = new runtime.Store(path.join(root, "account-b"));
  const events: string[] = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => events.push("show"),
    focus: () => events.push("focus"),
    webContents: { send: () => events.push("send") },
  };
  const context: any = {
    store: a,
    engine: {},
    remote: undefined,
    window: desktop ? window : undefined,
    accountActivationIdentity: {},
    accountRetiring: false,
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  runtime.registerSkillHandlers(
    (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    context,
  );
  Object.assign(runtime.boundary, {
    dialog: async () => ({ filePaths: [] }),
    supported: () => true,
    notifications: [],
    shown: [],
  });
  const skillPath = (store: any, name = "fixture") =>
    path.join(store.root, "codex-home", "skills", name, "SKILL.md");
  for (const store of [a, b]) {
    fs.mkdirSync(path.dirname(skillPath(store, "existing")), {
      recursive: true,
    });
    fs.writeFileSync(skillPath(store, "existing"), "Original existing skill");
  }
  const unchanged = (names = ["fixture"]) => {
    for (const store of [a, b]) {
      for (const name of names)
        assert.equal(
          fs.existsSync(skillPath(store, name)),
          false,
          `${path.basename(store.root)} must not receive ${name}`,
        );
      assert.equal(
        fs.readFileSync(skillPath(store, "existing"), "utf8"),
        "Original existing skill",
      );
    }
  };
  const change = (kind: Change) => {
    if (kind === "switch") {
      context.store = b;
      context.engine = {};
      context.accountActivationIdentity = {};
    }
    if (kind === "retire") context.accountRetiring = true;
    if (kind === "reactivate") {
      context.accountRetiring = true;
      context.accountActivationIdentity = {};
      context.accountRetiring = false;
    }
  };
  const calls: any[] = [];
  const remote = (
    scan: (body: any) => Promise<any> = async () => ({ passed: true }),
    authorize?: (action: (token: string) => Promise<any>) => Promise<any>,
  ) => {
    context.remote = {
      session: {
        authorized: authorize ?? ((action: any) => action("synthetic-token")),
      },
      backend: {
        client: {
          directoryRequest: async (token: string, route: string, init: any) => {
            calls.push({ token, route, body: init.body });
            return scan(init.body);
          },
        },
      },
    };
  };
  const call = (name: string, ...args: any[]) => {
    assert.ok(handlers.has(name));
    return Promise.resolve().then(() => handlers.get(name)!(...args));
  };
  const start = (name: string, ...args: any[]) =>
    handlers.get(name)!(...args) as Promise<any>;
  return {
    root,
    a,
    b,
    context,
    events,
    skillPath,
    unchanged,
    change,
    calls,
    remote,
    call,
    start,
  };
}
async function outcome(promise: Promise<any>) {
  try {
    return { value: await promise, error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}
function refused(
  operation: Operation,
  result: Awaited<ReturnType<typeof outcome>>,
  initiallyInvalid = false,
) {
  if (operation === "installSkillFiles")
    assert.ok(result.error, "stale install must reject");
  else if (!initiallyInvalid || !result.error) {
    assert.equal(result.error, undefined);
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0].ok, false);
    assert.equal(typeof result.value[0].message, "string");
  }
}

for (const operation of operations) {
  for (const useRemote of [false, true]) {
    test(`${operation} succeeds with ${useRemote ? "remote" : "local-only"} scanning`, async (t) => {
      const f = fixture(t);
      if (useRemote) f.remote();
      const result = await f.call(operation, [upload()]);
      assert.deepEqual(
        result,
        operation === "installSkillFiles"
          ? ["fixture"]
          : [{ file: "fixture.md", name: "fixture", ok: true }],
      );
      assert.equal(
        fs.readFileSync(f.skillPath(new runtime.Store(f.a.root)), "utf8"),
        upload().data.toString(),
      );
      assert.equal(fs.existsSync(f.skillPath(f.b)), false);
      assert.equal(f.calls.length, useRemote ? 1 : 0);
      if (useRemote) {
        assert.equal(f.calls[0].route, "/claudex/skills/scan");
        assert.equal(
          Buffer.from(f.calls[0].body.files[0].data, "base64").toString(),
          upload().data.toString(),
        );
      }
    });
    for (const change of changes) {
      test(`${operation} refuses ${change} while ${useRemote ? "service scan" : "local scan continuation"} is pending`, async (t) => {
        const f = fixture(t);
        const gate = deferred();
        if (useRemote)
          f.remote(async () => {
            await gate.promise;
            return { passed: true };
          });
        const pending = outcome(f.start(operation, [upload()]));
        f.change(change);
        gate.resolve();
        const result = await pending;
        f.unchanged();
        assert.equal(f.calls.length, useRemote ? 1 : 0);
        refused(operation, result);
      });
    }
  }
  for (const invalid of [
    "retired",
    "missing-identity",
    "missing-retirement",
  ] as const) {
    test(`${operation} refuses ${invalid} before entry without dispatch`, async (t) => {
      const f = fixture(t);
      f.remote();
      if (invalid === "retired") f.context.accountRetiring = true;
      if (invalid === "missing-identity")
        delete f.context.accountActivationIdentity;
      if (invalid === "missing-retirement") delete f.context.accountRetiring;
      const result = await outcome(f.call(operation, [upload()]));
      f.unchanged();
      assert.equal(f.calls.length, 0);
      refused(operation, result, true);
    });
  }
  for (const change of changes) {
    test(`${operation} does not dispatch after ${change} during authorization`, async (t) => {
      const f = fixture(t);
      const gate = deferred();
      f.remote(undefined, async (action) => {
        await gate.promise;
        return action("synthetic-token");
      });
      const pending = outcome(f.start(operation, [upload()]));
      f.change(change);
      gate.resolve();
      const result = await pending;
      assert.equal(
        f.calls.length,
        0,
        "stale bytes must not reach scan service",
      );
      f.unchanged();
      refused(operation, result);
    });
  }
  test(`${operation} preserves the first write but refuses later writes after retirement`, async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const gate = deferred();
    f.remote(async () => {
      if (f.calls.length === 2) {
        entered.resolve();
        await gate.promise;
      }
      return { passed: true };
    });
    const pending = outcome(
      f.start(operation, [upload("first"), upload("second"), upload("third")]),
    );
    await entered.promise;
    assert.equal(
      fs.readFileSync(f.skillPath(f.a, "first"), "utf8"),
      upload("first").data.toString(),
    );
    f.change("retire");
    gate.resolve();
    const result = await pending;
    f.unchanged(["second", "third"]);
    assert.equal(f.calls.length, 2, "third file must not reach scan service");
    assert.equal(
      fs.readFileSync(f.skillPath(f.a, "first"), "utf8"),
      upload("first").data.toString(),
    );
    if (operation === "installSkillFiles") assert.ok(result.error);
    else {
      assert.equal(result.error, undefined);
      assert.deepEqual(
        result.value.map((item: any) => [item.file, item.ok]),
        [
          ["first.md", true],
          ["second.md", false],
          ["third.md", false],
        ],
      );
    }
  });
  test(`${operation} preserves existing files on service rejection`, async (t) => {
    const f = fixture(t);
    f.remote(async () => {
      throw Error("synthetic scan rejection");
    });
    const result = await outcome(
      f.call(operation, [upload("existing")], { replace: true }),
    );
    f.unchanged();
    assert.equal(f.calls.length, 1);
    if (operation === "installSkillFiles") assert.ok(result.error);
    else {
      assert.equal(result.error, undefined);
      assert.equal(result.value[0].ok, false);
    }
  });
}

test("import returns per-file failures and continues valid files", async (t) => {
  const f = fixture(t);
  f.remote(async (body) => {
    if (body.name === "rejected") throw Error("synthetic scan rejection");
    return { passed: true };
  });
  const result = await f.call("importSkillFiles", [
    upload("first"),
    { name: "invalid.md", data: Buffer.from("no frontmatter") },
    upload("rejected"),
    upload("existing"),
    upload("last"),
  ]);
  assert.deepEqual(
    result.map((item: any) => [item.file, item.ok]),
    [
      ["first.md", true],
      ["invalid.md", false],
      ["rejected.md", false],
      ["existing.md", false],
      ["last.md", true],
    ],
  );
  for (const name of ["first", "last"])
    assert.equal(
      fs.readFileSync(f.skillPath(f.a, name), "utf8"),
      upload(name).data.toString(),
    );
  f.unchanged(["rejected", "invalid"]);
});

for (const useRemote of [false, true]) {
  test(`desktop folder upload succeeds ${useRemote ? "with remote scan" : "without remote"}`, async (t) => {
    const f = fixture(t, true);
    const folder = path.join(f.root, "source");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "SKILL.md"), upload().data);
    runtime.boundary.dialog = async () => ({ filePaths: [folder] });
    if (useRemote) f.remote();
    assert.equal(await f.call("uploadSkill"), "fixture");
    assert.equal(
      fs.readFileSync(f.skillPath(f.a), "utf8"),
      upload().data.toString(),
    );
    assert.equal(f.calls.length, useRemote ? 1 : 0);
  });
}
for (const change of changes) {
  test(`desktop folder upload refuses ${change} during dialog before scanning`, async (t) => {
    const f = fixture(t, true);
    f.remote();
    const folder = path.join(f.root, "source");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "SKILL.md"), upload().data);
    const gate = deferred<{ filePaths: string[] }>();
    runtime.boundary.dialog = () => gate.promise;
    const pending = outcome(f.start("uploadSkill"));
    f.change(change);
    gate.resolve({ filePaths: [folder] });
    const result = await pending;
    f.unchanged();
    assert.equal(f.calls.length, 0);
    assert.ok(result.error);
  });
}
test("desktop folder dialog cancellation remains null", async (t) => {
  const f = fixture(t, true);
  f.remote();
  assert.equal(await f.call("uploadSkill"), null);
  assert.equal(f.calls.length, 0);
  f.unchanged();
});
test("desktop import shows a notification and focuses its current window", async (t) => {
  const f = fixture(t, true);
  const result = await f.call("importSkillFiles", [upload()]);
  assert.equal(result[0].ok, true);
  assert.equal(runtime.boundary.shown.length, 1);
  runtime.boundary.notifications[0].events.click();
  assert.deepEqual(f.events, ["show", "focus", "send"]);
});
for (const change of changes) {
  test(`desktop import suppresses notification after ${change} during localized notice await`, async (t) => {
    const f = fixture(t, true);
    runtime.boundary.supported = () => {
      queueMicrotask(() => f.change(change));
      return true;
    };
    const result = await f.call("importSkillFiles", [upload()]);
    assert.deepEqual(result, [
      { file: "fixture.md", name: "fixture", ok: true },
    ]);
    assert.equal(
      fs.readFileSync(f.skillPath(f.a), "utf8"),
      upload().data.toString(),
    );
    assert.equal(fs.existsSync(f.skillPath(f.b)), false);
    assert.equal(runtime.boundary.shown.length, 0);
    assert.deepEqual(f.events, []);
  });
}

for (const change of changes) {
  test(`desktop import notification click is inert after ${change}`, async (t) => {
    const f = fixture(t, true);
    const result = await f.call("importSkillFiles", [upload()]);
    assert.equal(result[0].ok, true);
    assert.equal(runtime.boundary.shown.length, 1);
    f.change(change);
    runtime.boundary.notifications[0].events.click();
    assert.deepEqual(f.events, []);
  });
  test(`desktop folder upload refuses ${change} while remote scan is pending`, async (t) => {
    const f = fixture(t, true);
    const folder = path.join(f.root, "source");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "SKILL.md"), upload().data);
    runtime.boundary.dialog = async () => ({ filePaths: [folder] });
    const entered = deferred();
    const gate = deferred();
    f.remote(async () => {
      entered.resolve();
      await gate.promise;
      return { passed: true };
    });
    const pending = outcome(f.start("uploadSkill"));
    await entered.promise;
    f.change(change);
    gate.resolve();
    const result = await pending;
    f.unchanged();
    assert.equal(f.calls.length, 1);
    assert.ok(result.error);
  });
}
for (const invalid of [
  "retired",
  "missing-identity",
  "missing-retirement",
] as const) {
  test(`desktop folder upload refuses ${invalid} before opening dialog`, async (t) => {
    const f = fixture(t, true);
    let dialogs = 0;
    runtime.boundary.dialog = async () => {
      dialogs++;
      return { filePaths: [] };
    };
    if (invalid === "retired") f.context.accountRetiring = true;
    if (invalid === "missing-identity")
      delete f.context.accountActivationIdentity;
    if (invalid === "missing-retirement") delete f.context.accountRetiring;
    const result = await outcome(f.call("uploadSkill"));
    assert.equal(dialogs, 0);
    assert.ok(result.error);
    f.unchanged();
  });
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Run after the official resources have been assembled, or supply that assets/v1
// directory explicitly. These are original functions, not src/composer substitutes.
const resources = path.resolve(
  process.env.CLAUDEX_F021_ORIGINAL_RESOURCES ??
    "build/official-ui/ui/assets/v1",
);
const pins = {
  "shared-m-2-DfdOu-fU.js":
    "d0037b48d11e1a8232b57ded7fb51992d39d1ddbed02a0a640cb2c47be586750",
  "shared-l-p-m-w-1-O9prfPUL.js":
    "0d020fb34017fdd0b57526e6dba0a57ec3826209a4f35b4ba026c4d435aad5dc",
  "shared-3-f8anTwq9.js":
    "9b9d6471a82ab5a1a2869a91312451de9be029c6ec95b15157484e54128f14f6",
};
const sources = Object.entries(pins).map(([name, expected]) => {
  const text = fs.readFileSync(path.join(resources, name), "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), expected, name);
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
});
const [composer, storage, lifecycle] = sources;
function find(node, predicate) {
  const result = [];
  const visit = (item) => {
    if (predicate(item)) result.push(item);
    ts.forEachChild(item, visit);
  };
  visit(node);
  return result;
}
function one(items, label) {
  assert.equal(items.length, 1, label);
  return items[0];
}
function declaration(source, name) {
  return one(
    find(source, (n) => ts.isFunctionDeclaration(n) && n.name?.text === name),
    name,
  );
}
const code = (source, name) => declaration(source, name).getText(source);
const u0 = declaration(composer, "u0");
const partialize = one(
  find(
    u0,
    (n) =>
      ts.isPropertyAssignment(n) && n.name.getText(composer) === "partialize",
  ),
  "u0 partialize",
).initializer.getText(composer);
const mount = one(
  find(
    declaration(lifecycle, "wE"),
    (n) =>
      ts.isBinaryExpression(n) &&
      n.left.getText(lifecycle) === "f" &&
      ts.isArrowFunction(n.right),
  ),
  "wE mount effect",
).right.getText(lifecycle);
const normalize = (value) => JSON.parse(JSON.stringify(value));
const key = vm.runInNewContext(`(${code(composer, "Q$")})`);
const serialize = vm.runInNewContext(
  `${["cA", "XF", "yQ"].map((name) => code(composer, name)).join("\n")};
   var fT = "dictation", u = false;
   (${partialize});`,
  {
    // This suite is text-only. It must not silently model an attachment conversion.
    yL0() {
      throw Error("Attachment conversion is outside this text contract");
    },
  },
);
function draft(text) {
  return {
    tipTapEditorState: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
    attachments: [],
    files: [],
    syncSourceUuids: [],
    pendingFoldQueue: [],
    queuedMessages: [],
    heldDraft: null,
    isTemporaryConversation: false,
    isAwaitingCreateAccept: false,
  };
}
const record = (text) => ({
  state: serialize(draft(text)),
  version: 2,
  owner: "synthetic-owner",
});

// Only the terminal key/value backend is replaced: real temporary files persist
// across independent VM instances. This is not a browser IndexedDB or DOM test.
// Browser IndexedDB, editor rendering and two real windows are separate UI checks.
function session(directory) {
  const operations = [];
  const file = (name) =>
    path.join(directory, Buffer.from(name).toString("hex") + ".json");
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(file(name), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const local = path.join(directory, "signals");
  fs.mkdirSync(local, { recursive: true });
  const signal = (name) => path.join(local, Buffer.from(name).toString("hex"));
  const context = {
    window: {},
    setTimeout,
    clearTimeout,
    structuredClone,
    localStorage: {
      getItem(name) {
        try {
          return fs.readFileSync(signal(name), "utf8");
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      },
      setItem(name, value) {
        fs.writeFileSync(signal(name), String(value));
      },
    },
    CM: async (name) => read(name),
    g3: async (name, value) => {
      fs.writeFileSync(file(name), JSON.stringify(value));
      operations.push({ type: "write", name });
    },
    XI: async (name) => {
      fs.rmSync(file(name), { force: true });
      operations.push({ type: "delete", name });
    },
    Ct: async () =>
      fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => Buffer.from(name.slice(0, -5), "hex").toString()),
    Nf: {
      warn() {
        throw Error("Unexpected storage warning");
      },
    },
    Sp: { LOCAL_STORAGE: "storage" },
    // Fixed ordinary same-account, no-wipe, text-only environment. The original
    // debounce, persistence, read, flush, release and schema functions run below.
    X7() {},
    oa() {},
    Ah: () => false,
    S3: () => false,
    YJ: () => false,
    qo: () => false,
    rQ: () => 0,
    VE: () => 0,
    $a: () => Promise.resolve(),
    Wt: () => undefined,
    ux() {},
    cQ() {},
  };
  const functions = [
    "R5",
    "o5",
    "u3",
    "Iy",
    "jH",
    "Gw",
    "gU",
    "Va",
    "Fz",
    "Pt",
    "uJ",
    "js",
    "kK",
    "E4",
    "IL",
    "lC",
    "b1",
    "ar",
    "qU",
    "gg",
    "Ao",
    "wj",
    "x5",
    "EV",
  ];
  vm.runInNewContext(
    `var kd="store:", ab="chat-draft", KE=50, sb=5000,
     Sb="rq-cache-confirmed-account", Kw="chat-draft-write-signal",
     oN=0, DC=0, At, ZY=Symbol("timeout"), QX=e=>typeof e==="string",
     oj=e=>lC(e)&&typeof e.extracted_content==="string";
     ${functions.map((name) => code(storage, name)).join("\n")}
     this.create = () => EV();`,
    context,
  );
  const stores = [];
  return {
    operations,
    read,
    create() {
      const store = context.create();
      stores.push(store);
      return store;
    },
    close() {
      for (const store of stores) {
        store.cleanup();
        store.release();
      }
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f021-"));
  const sessions = [];
  t.after(() => {
    sessions.forEach((item) => item.close());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return () => {
    const item = session(directory);
    sessions.push(item);
    return item;
  };
}
function mountLifecycle(store) {
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = "visible";
  const effect = vm.runInNewContext(`(${mount})`, {
    u: { current: false },
    d: { current: undefined },
    t: store,
    n: () => {},
    r: store.cleanup,
    i: store.release,
    a: store.flush,
    o: () => {},
    s: () => {},
    c: () => {},
    window,
    document,
    setTimeout,
    clearTimeout,
  });
  return { window, document, unmount: effect() };
}

test("original draft keys keep unified new Chat and existing conversations separate", () => {
  assert.equal(
    key({ draftStorageKey: "chorus-unified-composer" }),
    "chorus-unified-composer",
  );
  assert.equal(
    key({
      conversationId: "chat-a",
      draftStorageKey: "chorus-unified-composer",
    }),
    "chat-a",
  );
  assert.equal(key({ conversationId: "chat-b" }), "chat-b");
  const condition = one(
    find(
      u0,
      (n) =>
        ts.isIfStatement(n) &&
        n.expression.getText(composer) === 't !== "new-conversation" && i',
    ),
    "original persistence gate",
  ).expression.getText(composer);
  const persists = vm.runInNewContext(`(t,i)=>${condition}`);
  assert.equal(persists("chorus-unified-composer", true), true);
  assert.equal(persists("chat-a", true), true);
  assert.equal(persists("new-conversation", true), false);
  assert.equal(persists("chorus-unified-composer", false), false);
});

test("original serializer and EV/E4 persist independent Unicode multiline text records", async (t) => {
  const open = temporary(t),
    a = open(),
    store = a.create();
  const names = ["chorus-unified-composer", "chat-a"];
  const records = [
    record("新对话草稿🙂\n第二行"),
    record("已有对话草稿\n保持独立"),
  ];
  for (let i = 0; i < names.length; i++) {
    assert.equal(await store.getItem(names[i]), null);
    await store.setItem(names[i], records[i]);
  }
  assert.equal(a.operations.length, 0, "original debounce has not written yet");
  store.flush();
  await settle();
  assert.equal(a.operations.length, 2);
  for (let i = 0; i < names.length; i++) {
    const saved = await store.getItem(names[i]);
    assert.deepEqual(
      normalize(saved.state.tipTapEditorState),
      normalize(records[i].state.tipTapEditorState),
    );
    assert.equal(saved.owner, "synthetic-owner");
    assert.equal(saved.version, 2);
  }
});

test("an unchanged older reader's original lifecycle cleanup does not overwrite a newer draft", async (t) => {
  const open = temporary(t),
    a = open(),
    b = open();
  const writer = a.create(),
    reader = b.create(),
    name = "chorus-unified-composer";
  await writer.getItem(name);
  await writer.setItem(name, record("第一份草稿"));
  writer.flush();
  await settle();
  const old = await reader.getItem(name);
  const lifecycle = mountLifecycle(reader);
  await writer.setItem(name, record("后来保存的新草稿"));
  writer.flush();
  await settle();
  lifecycle.document.visibilityState = "hidden";
  lifecycle.document.dispatchEvent(new Event("visibilitychange"));
  lifecycle.window.dispatchEvent(new Event("pagehide"));
  lifecycle.unmount();
  await settle();
  assert.equal(
    b.operations.length,
    0,
    "read-only window must not write its old snapshot",
  );
  const refreshed = await open().create().getItem(name);
  assert.notDeepEqual(
    normalize(refreshed.state.tipTapEditorState),
    normalize(old.state.tipTapEditorState),
  );
  assert.deepEqual(
    normalize(refreshed.state.tipTapEditorState),
    normalize(record("后来保存的新草稿").state.tipTapEditorState),
  );
});

test("original pagehide flush is recoverable by new storage instances for new and existing Chat", async (t) => {
  const open = temporary(t),
    a = open();
  const expected = new Map([
    ["chorus-unified-composer", record("统一输入区未发送正文")],
    ["chat-a", record("会话A未发送正文")],
  ]);
  for (const [name, value] of expected) {
    const store = a.create();
    await store.getItem(name);
    const lifecycle = mountLifecycle(store);
    await store.setItem(name, value);
    lifecycle.window.dispatchEvent(new Event("pagehide"));
    await settle();
    lifecycle.unmount();
  }
  a.close();
  const reopened = open();
  for (const [name, value] of expected) {
    const saved = await reopened.create().getItem(name);
    assert.deepEqual(
      normalize(saved.state.tipTapEditorState),
      normalize(value.state.tipTapEditorState),
    );
  }
  assert.equal(
    reopened.operations.length,
    0,
    "reopening and reading do not rewrite drafts",
  );
});

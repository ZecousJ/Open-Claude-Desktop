const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const { buildSync } = require("esbuild");
  const stage = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-legacy-drafts-"),
  );
  try {
    buildSync({
      absWorkingDir: path.resolve(__dirname, "../.."),
      entryPoints: [
        "electron/official-ui/legacy-draft-migration.ts",
        "electron/official-ui/legacy-draft-preload.ts",
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outExtension: { ".js": ".cjs" },
      outdir: stage,
    });
    const run = spawnSync(require("electron"), [__filename, stage], {
      stdio: "inherit",
    });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return;
}

const stage = process.argv.at(-1);
const { app, BrowserWindow, protocol, session } = require("electron");
const { pathToFileURL } = require("node:url");
protocol.registerSchemesAsPrivileged([
  { scheme: "claudex-app", privileges: { standard: true, secure: true } },
]);
const { restoreLegacyDrafts } = require(
  path.join(stage, "legacy-draft-migration.cjs"),
);
const profile = path.join(stage, "profile");
fs.mkdirSync(profile);
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const preload = path.join(stage, "legacy-draft-preload.cjs");
async function inStorage(browserSession, origin, operation, arg) {
  const http = origin.startsWith("http:");
  if (http)
    browserSession.protocol.handle(
      "http",
      () =>
        new Response("<!doctype html>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
    },
  });
  try {
    await win.loadURL(http ? origin + "/fixture" : origin);
    return await win.webContents.executeJavaScript(
      `(${operation.toString()})(${JSON.stringify(arg)})`,
    );
  } finally {
    win.destroy();
    if (http) browserSession.protocol.unhandle("http");
  }
}
async function storage({ write, read, local, remove }) {
  if (local)
    for (const [key, value] of Object.entries(local))
      localStorage.setItem(key, JSON.stringify(value));
  if (!read && !write && !remove) return;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("keyval-store");
    req.onupgradeneeded = () => req.result.createObjectStore("keyval");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    if (write || remove)
      await new Promise((resolve, reject) => {
        const tx = db.transaction("keyval", "readwrite");
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        const store = tx.objectStore("keyval");
        if (write)
          for (const [key, value] of Object.entries(write))
            store.put(
              value.blob
                ? new Blob([value.blob], { type: "text/plain" })
                : value,
              key,
            );
        if (remove) store.delete(remove);
      });
    const output = {
      confirmedAccount: localStorage.getItem("rq-cache-confirmed-account"),
    };
    for (const key of read ?? []) {
      const value = await new Promise((resolve, reject) => {
        const req = db
          .transaction("keyval", "readonly")
          .objectStore("keyval")
          .get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      output[key] =
        value instanceof Blob
          ? await value.text()
          : (value ?? JSON.parse(localStorage.getItem(key) ?? "null"));
    }
    return output;
  } finally {
    db.close();
  }
}
app
  .whenReady()
  .then(async () => {
    app.dock?.hide();
    const shared = session.fromPartition("persist:official-ui");
    const partitionA = session.fromPartition("persist:fixture-a");
    const partitionB = session.fromPartition("persist:fixture-b");
    const old1 = "http://localhost:37155",
      old2 = "http://localhost:37156";
    const nextA = "http://localhost:37157",
      nextB = "http://localhost:37158";
    const chat = "store:chat-draft:chorus-unified-composer";
    const existing = "store:chat-draft:existing-conversation";
    const foreign = "store:chat-draft:account-b";
    const noOwner = "store:chat-draft:unowned";
    const file = "store:attachment-blob:fixture-blob";
    const code = "composer-draft:epitaxy-draft";
    const codeOnly = "composer-draft:epitaxy-code-only";
    const images = "composer-draft-images:epitaxy-draft";
    const ownerA = "fixture-a",
      ownerB = "fixture-b";
    const message = (text, owner, updatedAt, files = []) => ({
      owner,
      updatedAt,
      version: 2,
      state: {
        tipTapEditorState: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        },
        files,
      },
    });
    const older = message("older", ownerA, 1);
    const newest = message("newest", ownerA, 2, [
      { file_uuid: "fixture-blob", file_name: "proof.txt", file_kind: "image" },
    ]);
    const persisted = message("already current", ownerA, 1);
    const other = message("only B", ownerB, 3);
    await inStorage(shared, old1, storage, {
      write: {
        [chat]: older,
        [foreign]: other,
        [existing]: older,
        [noOwner]: message("no owner", undefined, 4),
      },
      local: { [code]: { owner: ownerA, text: "old Code draft", storedAt: 1 } },
    });
    await inStorage(shared, old2, storage, {
      write: {
        [chat]: newest,
        [file]: { blob: "exact bytes" },
        [images]: [
          { owner: ownerA, id: "own" },
          { owner: ownerB, id: "foreign" },
        ],
      },
      local: { [code]: { owner: ownerA, text: "new Code draft", storedAt: 2 } },
    });
    await inStorage(shared, "http://localhost:37159", storage, {
      local: {
        [codeOnly]: { owner: ownerA, text: "Code draft without IndexedDB" },
      },
    });
    fs.writeFileSync(path.join(profile, "official-ui-server-port"), "37159\n");
    await inStorage(partitionA, nextA, storage, {
      write: { [existing]: persisted },
    });
    const markerA = path.join(profile, "marker-a"),
      markerB = path.join(profile, "marker-b");
    let remoteAvailable = false;
    let cloudReads = 0;
    const run = (owner, targetSession, targetOrigin, marker) =>
      restoreLegacyDrafts({
        userData: profile,
        marker,
        targetSession,
        targetOrigin,
        owner,
        preload,
        conversationDrafts: async (ids, refresh) => {
          if (refresh) {
            assert.deepEqual(ids, ["legacy-remote"]);
            cloudReads++;
          }
          return new Map(
            ids.flatMap((id) => {
              if (id === "legacy-chat") return [[id, { kind: "chat", id }]];
              if (id === "legacy-code")
                return [
                  [id, { kind: "code", id: "epitaxy-local_legacy-code" }],
                ];
              if (refresh && remoteAvailable && id === "legacy-remote")
                return [[id, { kind: "code", id: "epitaxy-session_remote" }]];
              return [];
            }),
          );
        },
        current: () => true,
      });
    await run(ownerA, partitionA, nextA, markerA);
    assert.equal(fs.readFileSync(markerA, "utf8"), "complete\n");
    const rows = await inStorage(partitionA, nextA, storage, {
      read: [chat, file, existing, noOwner, foreign, code, images, codeOnly],
    });
    assert.deepEqual(rows[chat], newest);
    assert.equal(rows.confirmedAccount, ownerA);
    assert.equal(rows[file], "exact bytes");
    assert.deepEqual(rows[existing], persisted);
    assert.equal(rows[noOwner], null);
    assert.equal(rows[foreign], null);
    assert.equal(rows[code].text, "new Code draft");
    assert.equal(rows[codeOnly].text, "Code draft without IndexedDB");
    assert.deepEqual(rows[images], [{ owner: ownerA, id: "own" }]);
    await run(ownerB, partitionB, nextB, markerB);
    const b = await inStorage(partitionB, nextB, storage, {
      read: [chat, file, existing, noOwner, foreign, code, images],
    });
    assert.deepEqual(b[foreign], other);
    assert.equal(b.confirmedAccount, ownerB);
    for (const key of [chat, file, existing, noOwner, code, images])
      assert.equal(b[key], null);
    await inStorage(partitionA, nextA, storage, { remove: chat });
    await run(ownerA, partitionA, nextA, markerA);
    assert.equal(
      (await inStorage(partitionA, nextA, storage, { read: [chat] }))[chat],
      null,
    );
    assert.deepEqual(
      (await inStorage(shared, old2, storage, { read: [chat] }))[chat],
      newest,
    );
    const reactProfile = session.defaultSession;
    const filePage = path.join(stage, "installed-react-index.html");
    fs.writeFileSync(filePage, "<!doctype html>");
    const fileUrl = pathToFileURL(filePage).href;
    const packUrl = "claudex-app://ui/bundled/index.html";
    reactProfile.protocol.handle(
      "claudex-app",
      () =>
        new Response("<!doctype html>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
    const react = (owner, place) =>
      `claudex:composer-draft:v1:${owner}:${place}`;
    const homeDraft = { text: "old homepage text\n\n第二行", storedAt: 30 };
    const codeDraft = {
      text: "Code draft from the interface pack",
      storedAt: 40,
    };
    await inStorage(reactProfile, fileUrl, storage, {
      local: {
        [react(ownerA, "new:chat")]: {
          text: "no longer replace native Chat",
          storedAt: 60,
        },
        [react(ownerA, "new:code")]: {
          text: "older Code draft from file",
          storedAt: 10,
        },
        [react(ownerA, "legacy-chat")]: {
          text: "existing Chat draft",
          storedAt: 55,
        },
        [react(ownerA, "legacy-code")]: {
          text: "existing Code draft",
          storedAt: 54,
        },
        [react(ownerB, "new:chat")]: homeDraft,
        [react(ownerB, "legacy-remote")]: {
          text: "Cloud Code follow-up",
          storedAt: 75,
        },
      },
    });
    await inStorage(reactProfile, packUrl, storage, {
      local: { [react(ownerA, "new:code")]: codeDraft },
    });
    const reactA = session.fromPartition("persist:react-fixture-a");
    const reactB = session.fromPartition("persist:react-fixture-b");
    const nextReactA = "http://localhost:37160";
    const nextReactB = "http://localhost:37161";
    const reactMarkerA = path.join(profile, "existing-official-a");
    const reactMarkerB = path.join(profile, "existing-official-b");
    fs.writeFileSync(reactMarkerA, "complete\n");
    fs.writeFileSync(reactMarkerB, "complete\n");
    await inStorage(reactA, nextReactA, storage, {
      write: { [chat]: persisted },
    });
    await run(ownerA, reactA, nextReactA, reactMarkerA);
    await run(ownerB, reactB, nextReactB, reactMarkerB);
    const chatSession = "store:chat-draft:legacy-chat";
    const codeSession = "composer-draft:epitaxy-local_legacy-code";
    const remoteSession = "composer-draft:epitaxy-session_remote";
    const restoredA = await inStorage(reactA, nextReactA, storage, {
      read: [chat, code, chatSession, codeSession, remoteSession],
    });
    const restoredB = await inStorage(reactB, nextReactB, storage, {
      read: [chat, code, chatSession, codeSession, remoteSession],
    });
    assert.deepEqual(restoredA[chat], persisted);
    assert.equal(restoredA[code]?.text, codeDraft.text);
    assert.equal(restoredA[code]?.owner, ownerA);
    assert.deepEqual(
      restoredA[chatSession],
      message("existing Chat draft", ownerA, 55),
    );
    assert.deepEqual(restoredA[codeSession], {
      owner: ownerA,
      text: "existing Code draft",
      storedAt: 54,
    });
    assert.equal(restoredB.confirmedAccount, ownerB);
    assert.equal(restoredB[code], null);
    assert.equal(restoredB[chatSession], null);
    assert.equal(restoredB[codeSession], null);
    assert.equal(restoredB[remoteSession], null);
    assert.equal(cloudReads, 1);
    assert.equal(restoredB[chat]?.owner, ownerB);
    assert.equal(restoredB[chat]?.updatedAt, homeDraft.storedAt);
    assert.equal(restoredB[chat]?.version, 2);
    assert.deepEqual(restoredB[chat]?.state.tipTapEditorState, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "old homepage text" }],
        },
        { type: "paragraph", content: [] },
        { type: "paragraph", content: [{ type: "text", text: "第二行" }] },
      ],
    });
    const reactKeyB = react(ownerB, "new:chat");
    assert.deepEqual(
      (await inStorage(reactProfile, fileUrl, storage, { read: [reactKeyB] }))[
        reactKeyB
      ],
      homeDraft,
    );
    await inStorage(reactB, nextReactB, storage, { remove: chat });
    remoteAvailable = true;
    await run(ownerB, reactB, nextReactB, reactMarkerB);
    const afterRetry = await inStorage(reactB, nextReactB, storage, {
      read: [chat, remoteSession],
    });
    assert.equal(afterRetry[chat], null);
    assert.deepEqual(afterRetry[remoteSession], {
      owner: ownerB,
      text: "Cloud Code follow-up",
      storedAt: 75,
    });
    assert.equal(cloudReads, 2);
    console.log(
      "PASS real Electron: original and React drafts, file and UI pack origins, attachment bytes, account isolation, and cloud retry without restoring a cleared home draft",
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

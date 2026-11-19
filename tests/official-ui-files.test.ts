import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { registerOfficialFileHandlers } from "../electron/ipc/official-files";
import { registerCodeFiles } from "../electron/official-ui/native/files";
import { codeFilePreviewRoute } from "../electron/official-ui/api/code-file-preview";

test("official session files read real bytes, create nested text, and reject traversal and symlink escapes", async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-official-files-"),
  );
  const cwd = path.join(temporary, "workspace"),
    outside = path.join(temporary, "outside");
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
  t.mock.method(os, "homedir", () => temporary);
  fs.writeFileSync(path.join(cwd, "index.html"), "<h1>Original</h1>");
  fs.writeFileSync(path.join(outside, "secret.txt"), "PRIVATE");
  const documentBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80]);
  fs.writeFileSync(path.join(cwd, "report.docx"), documentBytes);
  fs.writeFileSync(path.join(cwd, "picture.png"),documentBytes);
  fs.writeFileSync(path.join(cwd, "picture.AVIF"), documentBytes);
  const largeImage = path.join(cwd, "large.avif");
  fs.writeFileSync(largeImage, documentBytes);
  fs.truncateSync(largeImage, 1024 * 1024);
  fs.writeFileSync(path.join(cwd, "sound.wav"), documentBytes);
  fs.writeFileSync(path.join(cwd, "video.webm"), documentBytes);
  fs.writeFileSync(path.join(outside, "private.docx"), documentBytes);
  fs.writeFileSync(path.join(outside, "private.wav"), documentBytes);
  fs.symlinkSync(outside, path.join(cwd, "escape"));
  const ipc = new Map<string, (...args: any[]) => any>();
  const native = new Map<string, (...args: any[]) => any>();
  let account = "one",
    pending: (() => void) | undefined;
  registerOfficialFileHandlers((name, fn) => ipc.set(name, fn), {
    get activeAccount() {
      return { id: account };
    },
    store: {
      conversation: (id: string) => {
        if (id !== "code") throw Error("unknown session");
        return { id, mode: "code", cwd };
      },
    },
    allowedFolder(folder: string) {
      assert.equal(folder, cwd);
    },
  } as never);
  const ctx = {
    account: () => ({ id: account }),
    localCall: async (name: string, input: any) => {
      const result = ipc.get(name)!(input);
      if (pending)
        await new Promise<void>((resolve) => {
          pending = resolve;
        });
      return result;
    },
  };
  const server = http.createServer(async (req, res) => {
    if (!await codeFilePreviewRoute(req, res, ctx as never)) res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const stopWatching = registerCodeFiles({
    origin: `http://127.0.0.1:${address.port}`,
    ctx,
    emit() {},
    on(name: string, fn: any) {
      native.set(name, fn);
    },
  } as never);
  const call = (name: string, ...args: any[]) =>
    native.get(`LocalSessions.${name}`)!("local_code", ...args);
  try {
    const entries = await call("listSessionDirectory", cwd);
    assert.ok(
      entries.some((e: any) => e.name === "index.html" && !e.isDirectory),
    );
    const original = await call("readSessionFileWithStatus", "index.html");
    assert.equal(original.status, "ok");
    assert.equal(original.file.contents, "<h1>Original</h1>");
    assert.equal(await call('getSessionImageStreamUrl','picture.png'),null);
    assert.equal(await call('readSessionImageAsDataUrl','picture.png'),'data:image/png;base64,'+documentBytes.toString('base64'));
    assert.equal(
      await call("readSessionImageAsDataUrl", "picture.AVIF"),
      "data:image/avif;base64," + documentBytes.toString("base64"),
    );
    assert.equal(
      (await native.get("LocalSessions.readFileAtCwd")!(cwd, "picture.AVIF")).contents,
      documentBytes.toString("utf8"),
    );
    const imageStream = await call("getSessionImageStreamUrl", "large.avif");
    const imageResponse = await fetch(imageStream, { method: "HEAD" });
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/avif");
    assert.equal(imageResponse.headers.get("content-length"), String(1024 * 1024));
    assert.equal(
      await call("readSessionPanelMediaAsDataUrl", "sound.wav"),
      "data:audio/wav;base64," + documentBytes.toString("base64"),
    );
    assert.equal(
      await call("readSessionMediaAsDataUrl", "video.webm"),
      "data:video/webm;base64," + documentBytes.toString("base64"),
    );
    assert.equal(await call("readSessionPanelMediaAsDataUrl", "index.html"), null);
    assert.equal(await call("readSessionPanelMediaAsDataUrl", "../outside/private.wav"), null);
    const videoStream = await call("getSessionPanelMediaStreamUrl", "video.webm");
    assert.ok(videoStream);
    const byteResponse = await fetch(videoStream, { headers: { Range: "bytes=2-4" } });
    assert.equal(byteResponse.status, 206);
    assert.equal(byteResponse.headers.get("content-type"), "video/webm");
    assert.equal(byteResponse.headers.get("content-range"), "bytes 2-4/7");
    assert.deepEqual(Buffer.from(await byteResponse.arrayBuffer()), documentBytes.subarray(2, 5));
    const suffixResponse = await fetch(videoStream, { headers: { Range: "bytes=-2" } });
    assert.equal(suffixResponse.status, 206);
    assert.deepEqual(Buffer.from(await suffixResponse.arrayBuffer()), documentBytes.subarray(-2));
    const pastEnd = await fetch(videoStream, { headers: { Range: "bytes=7-" } });
    assert.equal(pastEnd.status, 416);
    assert.equal(pastEnd.headers.get("content-range"), "bytes */7");
    const escapedUrl = new URL(videoStream);
    escapedUrl.searchParams.set("path", "../outside/private.wav");
    assert.equal((await fetch(escapedUrl)).status, 404);
    assert.equal(await call('readSessionImageAsDataUrl','index.html'),null);
    assert.equal(await call('readSessionImageAsDataUrl','../outside/secret.txt'),null);
    const document = await call(
      "readSessionPanelDocumentAsDataUrl",
      "report.docx",
    );
    assert.equal(
      document,
      "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64," +
        documentBytes.toString("base64"),
    );
    for (const file of [
      "index.html",
      "missing.docx",
      "../outside/private.docx",
      "escape/private.docx",
    ])
      assert.equal(await call("readSessionPanelDocumentAsDataUrl", file), null);
    const largeDocument = Buffer.alloc(25 * 1024 * 1024, 0xff);
    documentBytes.copy(largeDocument);
    const largeDocumentPath = path.join(cwd, "large.docx");
    fs.writeFileSync(largeDocumentPath, largeDocument);
    const preview = await call("readSessionPanelDocumentAsDataUrl", "large.docx");
    assert.ok(Buffer.from(preview.split(",")[1], "base64").equals(largeDocument));
    const download = await call(
      "readSessionPanelDocumentWithStatus",
      "large.docx",
    );
    assert.equal(download.status, "ok");
    const [type, base64] = download.dataUrl.split(",");
    assert.equal(
      type,
      "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64",
    );
    assert.ok(Buffer.from(base64, "base64").equals(largeDocument));
    fs.truncateSync(largeDocumentPath, largeDocument.length + 1);
    assert.equal(await call("readSessionPanelDocumentAsDataUrl", "large.docx"), null);
    assert.equal(
      (await call("readSessionPanelDocumentWithStatus", "large.docx")).status,
      "tooLarge",
    );
    assert.equal(
      (await call("readSessionPanelDocumentWithStatus", "escape/private.docx"))
        .status,
      "outsideSessionFolders",
    );
    assert.equal(
      (await call("readSessionFileWithStatus", "../outside/secret.txt")).status,
      "outsideSessionFolders",
    );
    assert.equal(
      (await call("readSessionFileWithStatus", "escape/secret.txt")).status,
      "outsideSessionFolders",
    );
    assert.equal(
      (await call("createSessionFile", "escape/new.txt")).status,
      "denied",
    );
    assert.equal(
      (await call("writeSessionFile", "index.html", "bad", "wrong-hash"))
        .status,
      "conflict",
    );
    assert.equal(
      fs.readFileSync(path.join(cwd, "index.html"), "utf8"),
      "<h1>Original</h1>",
    );
    assert.equal(
      (
        await call(
          "writeSessionFile",
          "index.html",
          "<h1>Saved</h1>",
          original.file.hash,
        )
      ).status,
      "ok",
    );
    assert.equal(
      (await call("readSessionFile", "index.html")).contents,
      "<h1>Saved</h1>",
    );
    assert.equal((await call("createSessionFile", "new.txt")).status, "ok");
    assert.equal(
      (await call("createSessionFile", "new.txt")).status,
      "conflict",
    );
    fs.writeFileSync(path.join(cwd, "large.txt"), Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.equal(
      (await call("readSessionFileWithStatus", "large.txt")).status,
      "tooLarge",
    );
    assert.equal(
      (await call("readSessionFileWithStatus", "missing.txt")).status,
      "notFound",
    );
    assert.deepEqual(
      await call("readSessionFileWithStatus", "missing/child.txt"),
      {
        status: "notFound",
        creatable: true,
      },
    );
    assert.equal(
      (await call("writeSessionFile", "../outside/secret.txt", "bad")).status,
      "denied",
    );
    assert.deepEqual(await call("createSessionFile", "missing/child.txt"), {
      status: "ok",
    });
    assert.equal(fs.readFileSync(path.join(cwd, "missing", "child.txt"), "utf8"), "");
    assert.deepEqual(await call("createSessionFile", "~/workspace/missing/child.txt"), {
      status: "conflict",
    });
    assert.deepEqual(await call("createSessionFile", "~/workspace/home-alias/new.txt"), {
      status: "ok",
    });
    assert.equal(fs.readFileSync(path.join(cwd, "home-alias", "new.txt"), "utf8"), "");
    assert.deepEqual(await call("createSessionFile", "large.txt"), { status: "conflict" });
    for (const filename of [
      "escape/missing/child.txt",
      "index.html/child.txt",
      "scratchpad/child.txt",
      ".claude/settings.json",
      "folder/.mcp.json",
      "folder/",
    ]) {
      const missing = await call("readSessionFileWithStatus", filename);
      assert.ok(missing.status === "outsideSessionFolders" ||
        missing.status === "notFound" && missing.creatable === false);
      assert.equal((await call("createSessionFile", filename)).status, "denied");
    }
    assert.equal(fs.existsSync(path.join(outside, "missing")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".claude")), false);
    pending = () => {};
    const delayed = call("readSessionPanelDocumentAsDataUrl", "report.docx");
    await new Promise((r) => setImmediate(r));
    account = "two";
    pending!();
    await assert.rejects(delayed, /account changed/);
    assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
  } finally {
    stopWatching();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Code session file access follows its authorized roots and active owner", (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-code-roots-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cwd = path.join(temporary, "primary");
  const extra = path.join(temporary, "additional");
  const outside = path.join(temporary, "outside");
  for (const dir of [cwd, extra, outside]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(extra, "file.txt"), "extra contents");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(extra, "escape"), "dir");
  fs.symlinkSync(extra, path.join(cwd, "cross-root"), "dir");
  let owner = "owner";
  let additionalFolders = [extra];
  const handlers = new Map<string, (...args: any[]) => any>();
  registerOfficialFileHandlers((name, fn) => handlers.set(name, fn), {
    get activeAccount() {
      return { id: owner };
    },
    store: {
      conversation: (id: string) =>
        id === "code"
          ? {
              id,
              mode: "code",
              cwd,
              additionalFolders,
              sessionAuthors: {
                ownerAccountUuid: "owner",
                viewerAccountUuid: "owner",
              },
            }
          : undefined,
    },
    allowedFolder(folder: string) {
      assert.equal(folder, cwd);
    },
  } as never);
  const call = (operation: string, file: string, extraFields = {}) =>
    handlers.get("officialSessionFile")!({
      operation,
      sessionId: "code",
      path: file,
      ...extraFields,
    });

  assert.ok(
    call("list", extra).entries.some(
      (entry: { name: string }) => entry.name === "file.txt",
    ),
  );
  const read = call("read", path.join(extra, "file.txt"));
  assert.equal(read.file.contents, "extra contents");
  assert.equal(
    call("write", path.join(extra, "file.txt"), {
      contents: "saved",
      expectedHash: read.file.hash,
    }).status,
    "denied",
  );
  assert.equal(fs.readFileSync(path.join(extra, "file.txt"), "utf8"), "extra contents");
  assert.equal(call("create", path.join(extra, "new.txt")).status, "denied");
  assert.equal(
    call("read", path.join(outside, "secret.txt")).status,
    "outsideSessionFolders",
  );
  assert.equal(
    call("read", path.join(extra, "escape", "secret.txt")).status,
    "outsideSessionFolders",
  );
  assert.equal(
    call("read", path.join(cwd, "cross-root", "file.txt")).status,
    "outsideSessionFolders",
  );
  assert.equal(
    call("create", path.join(extra, "escape", "new.txt")).status,
    "denied",
  );
  additionalFolders = [];
  assert.equal(
    call("read", path.join(extra, "file.txt")).status,
    "outsideSessionFolders",
  );
  additionalFolders = [extra];
  owner = "other";
  assert.throws(
    () => call("read", path.join(extra, "file.txt")),
    /Code session is unavailable/,
  );
  assert.throws(
    () =>
      handlers.get("officialSessionFile")!({
        operation: "read",
        sessionId: "missing",
        path: "file.txt",
      }),
    /Code session is unavailable/,
  );
});

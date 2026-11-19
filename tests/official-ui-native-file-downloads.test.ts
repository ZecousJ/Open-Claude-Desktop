import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { registerNativeFileDownloads } from "../electron/official-ui/native/file-downloads";
import { organizationUuid } from "../electron/official-ui/api/context";
import { workspaceDownloadRoute } from "../electron/official-ui/api/workspace-download";

async function setup(t: any) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-download-test-"),
  );
  let owner = "owner",
    identity = {},
    status = 200,
    reads = 0;
  let onRead: (() => void) | undefined;
  const bytes = Buffer.from("download bytes 中文");
  const server = http
    .createServer(async (req, res) => {
      reads++;
      onRead?.();
      if (
        await workspaceDownloadRoute(
          req,
          res,
          new URL(req.url!, "http://localhost"),
          {
            account: () => ({ id: owner }),
            readWorkspaceDownload: async () => ({
              status,
              body: bytes,
              contentType: "application/octet-stream",
              contentDisposition: 'attachment; filename="test.txt"',
            }),
          } as never,
        )
      )
        return;
      res.writeHead(status, {
        "content-disposition": 'attachment; filename="test.txt"',
      });
      res.end(bytes);
    })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    server.closeAllConnections();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const handlers = new Map<string, (...args: any[]) => any>();
  const revealed: string[] = [];
  const opened: string[] = [];
  const confirmed: string[] = [];
  let openFailure = "",
    allowMacro = false;
  registerNativeFileDownloads(
    {
      origin,
      window: {
        isDestroyed: () => false,
        webContents: {
          getURL: () => origin + "/chat/test",
          session: {
            fetch: (url: string, init: RequestInit) => {
              assert.equal(init.credentials, "include");
              return fetch(url, init);
            },
          },
        },
      },
      ctx: { account: () => ({ id: owner }), sessionIdentity: () => identity },
      on: (name: string, fn: any) => handlers.set(name, fn),
    } as any,
    {
      downloadsDirectory: () => directory,
      revealFile: (filename) => revealed.push(filename),
      openFile: async (filename) => {
        opened.push(filename);
        return openFailure;
      },
      confirmOpen: async (filename) => {
        confirmed.push(filename);
        return allowMacro;
      },
    },
  );
  const url = `${origin}/api/organizations/${organizationUuid(owner)}/files/12345678-1234-4234-8234-123456789012/contents`;
  return {
    directory,
    bytes,
    revealed,
    opened,
    confirmed,
    allowMacro: () => {
      allowMacro = true;
    },
    failOpen: () => {
      openFailure = "No application available";
    },
    downloadAndOpen: (name: string, source = url) =>
      handlers.get("FileSystem.writeFileDownloadAndOpen")!(name, source),
    url,
    download: (name: string, source = url) =>
      handlers.get("FileSystem.writeFileDownload")!(name, source),
    reveal: (filename: string) =>
      handlers.get("FileSystem.showInFolder")!(filename),
    get reads() {
      return reads;
    },
    fail: () => {
      status = 503;
    },
    retireOnRead: () => {
      onRead = () => {
        identity = {};
        owner = "other";
      };
    },
  };
}

test("native Cowork downloads save bytes from the authorized session URL", async (t) => {
  const f = await setup(t);
  const source = new URL(f.url);
  source.pathname = `/api/organizations/${organizationUuid("owner")}/cowork/sessions/session_${"a".repeat(32)}/download-file`;
  source.searchParams.set("path", "/mnt/user-data/working/报告 # %.pdf");
  const saved = await f.download("报告 # %.pdf", source.href);
  assert.deepEqual(fs.readFileSync(saved), f.bytes);
  await assert.rejects(
    f.download(
      "other.pdf",
      source.href.replace(organizationUuid("owner"), organizationUuid("other")),
    ),
    /account/,
  );
  await assert.rejects(
    f.download("other.pdf", source.href + "&path=extra"),
    /account/,
  );
  assert.equal(f.reads, 1);
});

test("native batch saves every file and repeated names never overwrite a download", async (t) => {
  const f = await setup(t);
  const names = [
    "报告.xlsx",
    "notes.txt",
    "report.docx",
    "report.pdf",
    "page.html",
    "drawing.svg",
    "notes.md",
  ];
  const saved = await Promise.all(names.map((name) => f.download(name)));
  assert.equal(f.reads, 7);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), names.sort());
  for (const file of saved) assert.deepEqual(fs.readFileSync(file), f.bytes);
  const duplicate = await f.download("notes.txt");
  assert.equal(path.basename(duplicate), "notes (1).txt");
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "notes.txt")),
    f.bytes,
  );
  f.reveal(duplicate);
  assert.deepEqual(f.revealed, [duplicate]);
});

test("download and open passes the saved document to the default application", async (t) => {
  const f = await setup(t);
  const filename = await f.downloadAndOpen("report.pdf");
  assert.deepEqual(f.opened, [filename]);
  assert.deepEqual(f.confirmed, []);
  assert.deepEqual(fs.readFileSync(filename), f.bytes);
  f.failOpen();
  const fallback = await f.downloadAndOpen("report.pdf");
  assert.deepEqual(f.revealed, [fallback]);
  assert.ok(fs.existsSync(fallback));
});

test("macro-capable document consent preserves the download on cancel", async (t) => {
  const f = await setup(t);
  const cancelled = await f.downloadAndOpen("legacy.doc");
  assert.ok(fs.existsSync(cancelled));
  assert.deepEqual(f.confirmed, [cancelled]);
  assert.deepEqual(f.opened, []);
  f.allowMacro();
  const accepted = await f.downloadAndOpen("legacy.doc");
  assert.deepEqual(f.opened, [accepted]);
});

test("download and open refuses program files and retired-account results", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.downloadAndOpen("program.exe"),
    /cannot be opened automatically/,
  );
  assert.equal(f.reads, 0);
  f.retireOnRead();
  await assert.rejects(f.downloadAndOpen("report.pdf"), /account changed/);
  assert.deepEqual(f.opened, []);
});

test("native download accepts only the active account file endpoint and a filename", async (t) => {
  const f = await setup(t);
  for (const source of [
    f.url.replace(organizationUuid("owner"), organizationUuid("other")),
    "https://example.invalid/file",
    f.url.replace("/contents", "/preview"),
  ])
    await assert.rejects(f.download("test.txt", source), /account.*downloads/);
  for (const name of ["../test.txt", "a\\test.txt", ".", ""])
    await assert.rejects(f.download(name), /filename/);
  assert.equal(f.reads, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test("account change during a download does not write or reveal its result", async (t) => {
  const f = await setup(t);
  f.retireOnRead();
  await assert.rejects(f.download("test.txt"), /account changed/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.throws(
    () => f.reveal(path.join(f.directory, "test.txt")),
    /Download this file/,
  );
});

test("file API failure leaves Downloads unchanged", async (t) => {
  const f = await setup(t);
  f.fail();
  await assert.rejects(f.download("test.txt"), /could not be downloaded/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test("disk write failure removes an incomplete download", async (t) => {
  const f = await setup(t);
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (fd: number, data: Buffer) => {
    write(fd, data.subarray(0, 3));
    throw Object.assign(Error("Disk full"), { code: "ENOSPC" });
  });
  await assert.rejects(f.download("test.txt"), /Disk full/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

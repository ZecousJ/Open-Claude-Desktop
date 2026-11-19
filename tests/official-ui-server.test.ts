import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startOfficialUiServer } from "../electron/official-ui/server";

test("loading assets keep image MIME and missing files cannot remain negatively cached", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-preview-image-"));
  fs.mkdirSync(path.join(root, "ui/images"), { recursive: true });
  fs.writeFileSync(path.join(root, "ui/index.html"), "<!doctype html>");
  const server = await startOfficialUiServer({ root, api: () => false });
  const headers = { Cookie: "claudex_official_ui=" + server.token };
  try {
    const missing = await fetch(server.origin + "/images/preview.gif", { headers });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.equal(await missing.text(), "Not found");
    const bytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    fs.writeFileSync(path.join(root, "ui/images/preview.gif"), bytes);
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(server.origin + "/images/preview.gif", { method, headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/gif");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), method === "GET" ? bytes : Buffer.alloc(0));
    }
    assert.equal((await fetch(server.origin + "/images/preview.gif")).status, 403);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native key and quit test routes require launch authorization and explicit hooks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-key-server-"));
  fs.mkdirSync(path.join(root, "ui"));
  fs.writeFileSync(path.join(root, "ui/index.html"), "<!doctype html>");
  let server: Awaited<ReturnType<typeof startOfficialUiServer>> | undefined;
  try {
    const calls: unknown[] = [];
    server = await startOfficialUiServer({
      root,
      api: () => false,
      debugKey: (...args) => calls.push(args),
      debugQuit: () => calls.push("quit"),
    });
    const auth = { Cookie: "claudex_official_ui=" + server.token };
    assert.equal(
      (await fetch(server.origin + "/__debug/key?key=L", { method: "POST" }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(server.origin + "/__debug/quit", { method: "POST" })).status,
      403,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await fetch(server.origin + "/__debug/key?key=L&modifier=bogus", {
          method: "POST",
          headers: auth,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          server.origin + "/__debug/key?key=L&modifier=meta&preview=1&window=3",
          { method: "POST", headers: auth },
        )
      ).status,
      204,
    );
    assert.deepEqual(calls, [["L", ["meta"], true, 3]]);
    assert.equal(
      (
        await fetch(server.origin + "/__debug/quit", {
          method: "POST",
          headers: auth,
        })
      ).status,
      204,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.at(-1), "quit");
    await server.close();
    server = await startOfficialUiServer({ root, api: () => false });
    for (const route of ["key?key=L", "quit"])
      assert.equal(
        (
          await fetch(server.origin + "/__debug/" + route, {
            method: "POST",
            headers: { Cookie: "claudex_official_ui=" + server.token },
          })
        ).status,
        405,
      );
  } finally {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official UI keeps its browser origin across server restarts", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-official-server-"),
  );
  const ui = path.join(root, "bundle", "ui");
  const portFile = path.join(root, "profile", "official-ui-server-port");
  fs.mkdirSync(ui, { recursive: true });
  fs.writeFileSync(path.join(ui, "index.html"), "<!doctype html>");

  let first: Awaited<ReturnType<typeof startOfficialUiServer>> | undefined;
  let second: Awaited<ReturnType<typeof startOfficialUiServer>> | undefined;
  const start = () =>
    startOfficialUiServer({
      root: path.dirname(ui),
      portFile,
      api: () => false,
    });

  try {
    first = await start();
    const firstOrigin = first.origin;
    await first.close();
    first = undefined;

    second = await start();
    assert.equal(second.origin, firstOrigin);
    assert.equal(
      Number(fs.readFileSync(portFile, "utf8").trim()),
      Number(new URL(firstOrigin).port),
    );
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official UI chooses and persists a new port if its saved port is occupied", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-official-server-"),
  );
  const ui = path.join(root, "bundle", "ui");
  const portFile = path.join(root, "profile", "official-ui-server-port");
  fs.mkdirSync(ui, { recursive: true });
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(path.join(ui, "index.html"), "<!doctype html>");

  const occupied = http.createServer();
  await new Promise<void>((resolve) =>
    occupied.listen(0, "127.0.0.1", resolve),
  );
  const occupiedPort = (occupied.address() as { port: number }).port;
  fs.writeFileSync(portFile, `${occupiedPort}\n`);

  let server: Awaited<ReturnType<typeof startOfficialUiServer>> | undefined;
  try {
    server = await startOfficialUiServer({
      root: path.dirname(ui),
      portFile,
      api: () => false,
    });
    const selectedPort = Number(new URL(server.origin).port);
    assert.notEqual(selectedPort, occupiedPort);
    assert.equal(
      Number(fs.readFileSync(portFile, "utf8").trim()),
      selectedPort,
    );
  } finally {
    if (server) await server.close();
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persistent account mode refuses occupied saved origin without rewriting its port', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claudex-stable-origin-'));
  fs.mkdirSync(path.join(root,'ui'));fs.writeFileSync(path.join(root,'ui/index.html'),'<!doctype html>');
  const portFile=path.join(root,'account-port');
  const occupied=http.createServer();
  await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  const port=(occupied.address() as {port:number}).port;
  fs.writeFileSync(portFile,`${port}\n`);
  try {
    await assert.rejects(startOfficialUiServer({root,portFile,requireStablePort:true,api:()=>false}),{code:'EADDRINUSE'});
    assert.equal(fs.readFileSync(portFile,'utf8'),`${port}\n`);
  } finally {await new Promise<void>(resolve=>occupied.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
});
test('persistent account mode rejects invalid saved origin instead of losing storage visibility',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'claudex-invalid-origin-'));
 fs.mkdirSync(path.join(root,'ui'));fs.writeFileSync(path.join(root,'ui/index.html'),'<!doctype html>');
 const portFile=path.join(root,'port');fs.writeFileSync(portFile,'invalid');
 try {await assert.rejects(startOfficialUiServer({root,portFile,requireStablePort:true,api:()=>false}),/could not be read/);assert.equal(fs.readFileSync(portFile,'utf8'),'invalid');}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

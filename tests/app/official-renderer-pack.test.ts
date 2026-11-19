import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildUiPack } from "../../scripts/release/ui-pack-lib";
import { OfficialRendererPacks, rendererDocument, rewriteRendererReferences } from "../../electron/ui-pack/official-renderer";

test("renderer updates keep old assets, survive offline reopen and roll back to a ready version", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-pack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const bundled = path.join(root, "bundled");
  fs.mkdirSync(source); fs.mkdirSync(bundled);
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({type:"spki",format:"der"}).toString("base64");
  const privateKey = keys.privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const pack = async (version: string, script: string) => {
    fs.writeFileSync(path.join(source,"index.html"),'<html><head></head><body><script src="/app.js"></script></body></html>');
    fs.writeFileSync(path.join(source,"app.js"),script);
    fs.writeFileSync(path.join(source,"renderer.json"),JSON.stringify({kind:"official-renderer",version}));
    return (await buildUiPack({dist:source,version,bridge:2,privateKey})).zip;
  };
  const manager = new OfficialRendererPacks(root,"0.0.51",bundled);
  assert.equal(manager.document().version,"bundled");
  await manager.install(await pack("0.51.1","good"),"0.51.1",publicKey);
  const good = manager.document();
  assert.equal(good.version,"0.51.1");
  manager.ready(good.version);
  await manager.install(await pack("0.51.2","broken"),"0.51.2",publicKey);
  assert.equal(manager.document().version,"0.51.2");
  assert.equal(fs.readFileSync(path.join(manager.root(good.version)!,"app.js"),"utf8"),"good");
  assert.equal(manager.failed("0.51.2"),"0.51.1");
  const reopened = new OfficialRendererPacks(root,"0.0.51",bundled);
  assert.equal(reopened.document().version,"0.51.1");
  assert.equal(reopened.store.offer(undefined),undefined);
  assert.equal(reopened.document().version,"0.51.1");
  await reopened.install(await pack("0.51.4","crash-before-ready"),"0.51.4",publicKey);
  assert.equal(reopened.document().version,"0.51.4");
  const recovered = new OfficialRendererPacks(root,"0.0.51",bundled);
  assert.equal(recovered.document().version,"0.51.1");
  fs.writeFileSync(path.join(source,"host.cjs"),"privileged code");
  await assert.rejects(manager.install(await pack("0.51.3","bad"),"0.51.3",publicKey),/outside/);
  assert.equal(manager.document().version,"0.51.1");
});

test("renderer resource URLs are versioned without changing API routes and external URLs", () => {
  const html=rendererDocument('<head></head><script src="/app.js"></script><img src="/images/a.png">',"0.51.1");
  assert.match(html,/content="0.51.1"/);
  assert.match(html,/src="\/__claudex_renderer\/0.51.1\/app.js"/);
  const script='fetch("/api/account");const img="/images/a.png";const external="https://example.test/images/a.png"';
  assert.equal(rewriteRendererReferences(script,"0.51.1"),
    'fetch("/api/account");const img="/__claudex_renderer/0.51.1/images/a.png";const external="https://example.test/images/a.png"');
});

test("the authenticated local server switches complete documents and retains older module URLs", async t => {
  const { startOfficialUiServer } = await import("../../electron/official-ui/server");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-server-"));
  const ui = path.join(root,"ui");
  fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui,"index.html"),'<html><head></head><body>bundled<script src="/app.js"></script></body></html>');
  fs.writeFileSync(path.join(ui,"app.js"),'import "./assets/old.js"');
  const source = path.join(root,"source");
  fs.mkdirSync(path.join(source,"assets"),{recursive:true});
  const keys = crypto.generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const publicKey = keys.publicKey.export({type:"spki",format:"der"}).toString("base64");
  const manager = new OfficialRendererPacks(root,"0.0.51",ui);
  let busy = true;
  const server = await startOfficialUiServer({root,rendererPacks:manager,rendererBusy:()=>busy,api:()=>false});
  t.after(async()=>{await server.close();fs.rmSync(root,{recursive:true,force:true});});
  const headers={Cookie:"claudex_official_ui="+server.token};
  for(const n of [1,2]){
    const version="0.51."+n;
    fs.writeFileSync(path.join(source,"renderer.json"),JSON.stringify({kind:"official-renderer",version}));
    fs.writeFileSync(path.join(source,"index.html"),'<head></head><body>new<script src="/app.js"></script></body>');
    fs.writeFileSync(path.join(source,"app.js"),'import "./assets/module.js"');
    fs.writeFileSync(path.join(source,"assets/module.js"),'const version='+n+'; const path="/i18n/zh.json"');
    const {zip}=await buildUiPack({dist:source,version,bridge:2,privateKey});
    await manager.install(zip,version,publicKey);
    if(n===1){
      assert.match(await (await fetch(server.origin+"/epitaxy",{headers})).text(),/content="bundled"/);
      busy=false;
    }
    const document=await fetch(server.origin+"/epitaxy",{headers});
    assert.match(await document.text(),new RegExp('/__claudex_renderer/'+version+'/app.js'));
    manager.ready(version);
  }
  const old=await fetch(server.origin+"/__claudex_renderer/0.51.1/assets/module.js",{headers});
  assert.match(await old.text(),/version=1/);
  const current=await fetch(server.origin+"/__claudex_renderer/0.51.2/assets/module.js",{headers});
  assert.match(await current.text(),/\/__claudex_renderer\/0.51.2\/i18n/);
  assert.equal((await fetch(server.origin+"/__claudex_renderer/0.51.2/app.js")).status,403);
});

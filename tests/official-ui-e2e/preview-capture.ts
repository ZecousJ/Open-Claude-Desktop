import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  nativeImage,
} from "electron";
import { BrowserHost } from "../../electron/browser/browser-host";

const root = process.env.CLAUDEX_PREVIEW_FIXTURE_DIR;
if (!root || fs.readdirSync(root).length)
  throw Error("Use a new empty fixture directory.");
app.setPath("userData", path.join(root, "profile"));
app.setName("Claudex Preview Capture Test");

async function run(root: string) {
  app.dock?.hide();
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 850,
    focusable: false,
  });
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  const parking = new BaseWindow({ show: false, focusable: false });
  const host = new BrowserHost({
    platform: {
      createView: () =>
        new WebContentsView({
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        }) as never,
      parking: () => parking as never,
    },
    partition: () => "preview-capture-test",
    blockedDomains: () => [],
    toolsAvailable: () => true,
    push() {},
  });
  const file = path.join(root, "page.html");
  fs.writeFileSync(
    file,
    "<!doctype html><style>body{margin:0;min-height:100vh;background:#f7f6ee;display:grid;place-items:center}main{width:90%;height:200px;background:#008000}</style><main>Preview</main>",
  );
  try {
    await window.loadURL(
      "data:text/html," +
        encodeURIComponent(
          '<style>body{margin:0}#pane{position:absolute;left:50%;top:50px;right:0;bottom:0}</style><div id="pane"></div>',
        ),
    );
    window.showInactive();
    host.openFile("capture", file);
    const tab = host.activeTab(host.session("capture"));
    await tab.driver!.waitForDocument();
    const contents = tab.view!.webContents;
    const capture = contents.capturePage.bind(contents);
    const results = [];
    for (const viewport of ["desktop", { width: 800, height: 1050 }] as const) {
      await host.setViewport("capture", viewport);
      await tab.driver!.waitForDocument();
      for (const zoom of [1, Math.sqrt(1.2), 1.5]) {
        window.webContents.setZoomFactor(zoom);
        for (const width of [1200, 1000]) {
          window.setSize(width, 850);
          await new Promise((resolve) => setTimeout(resolve, 100));
          const bounds = await window.webContents.executeJavaScript(
            '(()=>{const r=document.querySelector("#pane").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()',
          );
          host.show("capture", window as never, bounds);
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (viewport === "desktop" && zoom === 1 && width === 1200) {
            const before = nativeImage
              .createFromBuffer((await host.capture("capture"))!)
              .getSize();
            const models = await Promise.all(
              Array.from({ length: 8 }, () => tab.driver!.screenshot()),
            );
            for (const model of models) {
              assert.equal(model.scale, 1);
              assert.deepEqual(
                nativeImage
                  .createFromBuffer(Buffer.from(model.base64, "base64"))
                  .getSize(),
                { width: model.width, height: model.height },
              );
              assert.equal(model.width, bounds.width);
            }
            assert.deepEqual(
              nativeImage
                .createFromBuffer((await host.capture("capture"))!)
                .getSize(),
              before,
              "Concurrent model captures preserve the native page surface",
            );
          }
          for (const parked of [false, true]) {
            if (parked) host.hide("capture");
            const normal = await host.capture("capture");
            assert.ok(normal);
            contents.capturePage = async () => ({
              isEmpty: () => true,
              toPNG: () => Buffer.alloc(0),
              toJPEG: () => Buffer.alloc(0),
            });
            let fallback: Buffer | undefined;
            try {
              fallback = await host.capture("capture");
            } finally {
              contents.capturePage = capture;
            }
            assert.ok(fallback);
            const expected = nativeImage.createFromBuffer(normal).getSize();
            const actual = nativeImage.createFromBuffer(fallback).getSize();
            assert.deepEqual(
              actual,
              expected,
              JSON.stringify({ viewport, zoom, width, parked }),
            );
            const dpr =
              await window.webContents.executeJavaScript("devicePixelRatio");
            assert.ok(
              Math.abs(actual.width / dpr - bounds.width) <= 1,
              "The official overlay fills the pane in CSS pixels",
            );
            assert.ok(Math.abs(actual.height / dpr - bounds.height) <= 1);
            results.push({
              viewport,
              zoom,
              windowWidth: width,
              parked,
              dpr,
              native: expected,
              fallback: actual,
            });
            host.show("capture", window as never, bounds);
          }
        }
      }
    }
    fs.writeFileSync(
      path.join(root, "results.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(
      "Preview native/fallback capture dimensions passed",
      results.length,
      "cases",
    );
  } finally {
    host.dispose();
    window.destroy();
    parking.destroy();
  }
}

app
  .whenReady()
  .then(() => run(root!))
  .then(
    () => app.quit(),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );

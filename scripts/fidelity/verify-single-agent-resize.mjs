/** Native pointer, keyboard and restart check for the isolated Agent panel. */
import { app, BrowserWindow, screen } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const output = process.argv[2];
if (
  output &&
  !path
    .resolve(output)
    .startsWith(path.resolve("work/fidelity/recordings") + path.sep)
)
  throw Error("Recording must stay in work/fidelity/recordings");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-agent-resize-"));
app.setPath("userData", root);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const work = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    x: work.x + 50,
    y: work.y + 30,
    show: true,
    title: "Claudex Agent resize fixture",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const page = "http://127.0.0.1:5173/fidelity/single-agent.html";
  try {
    await window.loadURL(page);
    let recorded;
    if (output) {
      const helper = path.resolve("work/fidelity/window-evidence");
      const listed = JSON.parse(
        spawnSync(helper, ["list", "--bundle", "com.github.Electron"], {
          encoding: "utf8",
        }).stdout,
      );
      const id = listed.windows.find(
        (row) => row.title === "Claudex Agent resize fixture",
      )?.id;
      if (!id) throw Error("Fixture window missing");
      const child = spawn(
        helper,
        [
          "record",
          "--bundle",
          "com.github.Electron",
          "--window-id",
          String(id),
          "--crop",
          "0,0,1100,780",
          "--duration",
          "8",
          "--scale",
          "2",
          "--output",
          path.resolve(output),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      recorded = new Promise((resolve) => child.once("close", resolve));
    }
    const get = () =>
      window.webContents.executeJavaScript(
        `({width:document.querySelector('.background-tasks-panel').getBoundingClientRect().width,handle:document.querySelector('.background-panel-resize').getBoundingClientRect().toJSON(),saved:localStorage.getItem('claudex:background-width:fixture-account')})`,
      );
    const before = await get(),
      x = Math.round(before.handle.x + before.handle.width / 2),
      y = Math.round(before.handle.y + 100);
    window.webContents.sendInputEvent({ type: "mouseMove", x, y });
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    for (let offset = 10; offset <= 80; offset += 10)
      window.webContents.sendInputEvent({
        type: "mouseMove",
        x: x - offset,
        y,
      });
    await pause(100);
    const held = await get();
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: x - 80,
      y,
      button: "left",
      clickCount: 1,
    });
    await pause(100);
    const after = await get();
    if (!(
      held.width > before.width + 40 &&
      after.width > before.width + 40 &&
      Number(after.saved) > before.width + 40
    ))
      throw Error(
        `Pointer resize failed: ${JSON.stringify({ before, held, after })}`,
      );
    await window.webContents.executeJavaScript(
      `document.querySelector('.single-agent-task-footer button').click()`,
    );
    await pause(70);
    const transcript = await get();
    if (Math.abs(transcript.width - after.width) > 2)
      throw Error("Transcript lost panel width");
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Back to background tasks"]').click()`,
    );
    await pause(70);
    const returned = await get();
    if (Math.abs(returned.width - after.width) > 2)
      throw Error("Back lost panel width");
    const loaded = new Promise((resolve) =>
      window.webContents.once("did-finish-load", resolve),
    );
    window.webContents.reload();
    await loaded;
    await pause(100);
    const persisted = await get();
    if (Math.abs(persisted.width - after.width) > 2)
      throw Error("Reload lost account width");
    const handle = persisted.handle;
    const hx = Math.round(handle.x + handle.width / 2),
      hy = Math.round(handle.y + 100);
    await window.webContents.executeJavaScript(
      `document.querySelector('.background-panel-resize').focus()`,
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await pause(100);
    const keyboard = await get();
    if (!(keyboard.width < persisted.width))
      throw Error("Keyboard resize failed");
    const bounds = keyboard.handle,
      kx = Math.round(bounds.x + bounds.width / 2),
      ky = Math.round(bounds.y + 100);
    window.webContents.sendInputEvent({ type: "mouseMove", x: kx, y: ky });
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: kx,
      y: ky,
      button: "left",
      clickCount: 1,
    });
    window.webContents.sendInputEvent({ type: "mouseMove", x: kx - 50, y: ky });
    await pause(70);
    const cancelPreview = await get();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await pause(70);
    const cancelled = await get();
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: kx - 50,
      y: ky,
      button: "left",
      clickCount: 1,
    });
    if (!(
      cancelPreview.width > keyboard.width + 30 &&
      Math.abs(cancelled.width - keyboard.width) < 2
    ))
      throw Error("Escape failed to cancel panel drag");
    window.setSize(420, 800);
    await pause(120);
    const narrow = await get();
    if (narrow.width > 230 || narrow.width < 210)
      throw Error(`Narrow panel did not contract: ${narrow.width}`);
    if (recorded && (await recorded) !== 0)
      throw Error("Window recording failed");
    console.log(
      JSON.stringify({
        before: before.width,
        held: held.width,
        after: after.width,
        transcript: transcript.width,
        reloaded: persisted.width,
        keyboard: keyboard.width,
        cancelled: cancelled.width,
        narrow: narrow.width,
        recording: output,
      }),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
app.on("quit", () =>
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }),
);

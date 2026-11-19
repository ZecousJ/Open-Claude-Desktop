/** Run in Electron with an isolated temporary user-data directory. No account or UI. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { app, BrowserWindow, webContents } from "electron";
import { attachmentImageSize } from "../../electron/official-ui/native/image-size";
import { imageSizeFixtures } from "./official-image-size-data";

const rows: unknown[] = [];
app.whenReady().then(async () => {
  const before = webContents.getAllWebContents().length;
  for (const fixture of imageSizeFixtures) {
    const bytes = Buffer.from(fixture.base64, "base64");
    const result = await attachmentImageSize(bytes);
    assert.deepEqual(result, { width: 37, height: 23 }, fixture.name);
    rows.push({ name: fixture.name, variant: "valid", result });
    // Keep a format signature but no complete compressed pixel data.
    const corrupt = await attachmentImageSize(bytes.subarray(0, 16));
    assert.equal(corrupt, undefined, `${fixture.name} truncated`);
    rows.push({ name: fixture.name, variant: "truncated", refused: true });
    assert.equal(webContents.getAllWebContents().length, before, "decoder contents closed");
  }
  for (const data of [Buffer.alloc(0), Buffer.from("not an image"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')]) {
    assert.equal(await attachmentImageSize(data), undefined);
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0, "no UI window created");
  const report = { electron: process.versions.electron, platform: process.platform,
    sandboxDisabledByLaunch: app.commandLine.hasSwitch("no-sandbox"), rows,
    browserWindows: BrowserWindow.getAllWindows().length,
    remainingDecoderContents: webContents.getAllWebContents().length - before };
  const output = app.commandLine.getSwitchValue("image-size-report");
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

/**
 * The runner's "electron" (runner/src/electron-shim.ts): nothing reaches a
 * desktop; the few answers remote handlers rely on are real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import electron, {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeTheme,
  safeStorage,
  session,
  setShimVersion,
  shell,
  webCallScope,
} from "../../runner/src/electron-shim";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";

test("desktop APIs throw 'Not available on the web.'", async () => {
  assert.throws(() => clipboard.writeText("x"), { message: notAvailableOnWeb });
  assert.throws(() => dialog.showOpenDialog({}), {
    message: notAvailableOnWeb,
  });
  assert.throws(() => new BrowserWindow({}), { message: notAvailableOnWeb });
  // Reached through a member chain, as settings-desktop does.
  assert.throws(() => session.defaultSession.getCacheSize(), {
    message: notAvailableOnWeb,
  });
  assert.throws(() => app.getPath("userData"), { message: notAvailableOnWeb });
  // Awaiting a member is harmless (not a thenable).
  assert.equal((dialog as any).then, undefined);
});

test("the answers remote handlers use are real", () => {
  setShimVersion("1.2.3");
  assert.equal(app.getVersion(), "1.2.3");
  assert.equal(app.isPackaged, false);
  assert.equal(safeStorage.isEncryptionAvailable(), false);
  assert.equal(BrowserWindow.getFocusedWindow(), null);
  assert.deepEqual(BrowserWindow.getAllWindows(), []);
  nativeTheme.themeSource = "dark";
  // Listening for app events never fires and never throws.
  assert.doesNotThrow(() => app.once("will-quit", () => {}));
  assert.equal(electron.shell, shell);
});

test("shell.openExternal opens https pages in the calling user's tabs", async () => {
  const opened: string[] = [];
  await webCallScope.run(
    { userId: 7, openUrl: (url) => opened.push(url) },
    () => shell.openExternal("https://pay.example.com/checkout?o=1"),
  );
  assert.deepEqual(opened, ["https://pay.example.com/checkout?o=1"]);
  await assert.rejects(
    webCallScope.run({ userId: 7, openUrl: () => {} }, () =>
      shell.openExternal("javascript:alert(1)"),
    ),
  );
  await assert.rejects(
    webCallScope.run({ userId: 7, openUrl: () => {} }, () =>
      shell.openExternal("http://example.com/"),
    ),
  );
  // Outside a relayed call there is nobody to show it to.
  await assert.rejects(shell.openExternal("https://example.com/"), {
    message: notAvailableOnWeb,
  });
});

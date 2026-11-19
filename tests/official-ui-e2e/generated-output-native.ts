/** Isolated desktop preview fixture using the production pinned user-content handler. */
import { app, BrowserWindow, session, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativeHost } from "../../electron/official-ui/native";
import { registerNativeFileDownloads } from "../../electron/official-ui/native/file-downloads";
import { createGeneratedOutputFixture } from "../support/generated-output-fixture";
import {
  createUserContentHandler,
  userContentOrigin,
} from "../../electron/official-ui/usercontent";
const origin = process.env.CLAUDEX_F019_UI_ORIGIN;
if (!origin || !/^http:\/\/localhost:\d+$/.test(origin))
  throw Error("Expected fixture loopback origin");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f019-native-"));
app.setPath("userData", profile);
app.setName("Claudex F019 Test");
app.whenReady().then(async () => {
  console.log("Native fixture app ready");
  const fixtureRoot = process.env.CLAUDEX_F019_FIXTURE_ROOT;
  if (!fixtureRoot) throw Error("Expected the isolated fixture Store root");
  const fixture = await createGeneratedOutputFixture(fixtureRoot);
  const ses = session.fromPartition("f019-isolated");
  await ses.cookies.set({
    url: origin,
    name: "claudex_official_ui",
    value: "f019-native-acceptance",
    httpOnly: true,
    sameSite: "strict",
  });
  const preview = createUserContentHandler(
    path.resolve("build/official-usercontent"),
    origin,
  );
  ses.protocol.handle("https", preview);
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const u = new URL(details.url);
    callback({
      cancel: !(
        u.origin === origin ||
        u.origin === userContentOrigin ||
        ["blob:", "data:", "devtools:"].includes(u.protocol)
      ),
    });
  });
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Claudex F019 验收",
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.resolve("build/official-ui/host/official-preload.cjs"),
    },
  });
  const native = createNativeHost(origin, fixture.ctx, {});
  const build = JSON.parse(
    fs.readFileSync(path.resolve("build/official-ui/data/build.json"), "utf8"),
  );
  win.webContents.setUserAgent(
    `${win.webContents.getUserAgent()} Claude/${build.installedDesktopVersion ?? "4.4212.0"}`,
  );
  registerNativeFileDownloads(native.host, {
    downloadsDirectory: () => path.join(fixtureRoot, "downloads"),
    revealFile: (filename) =>
      console.log("Fixture downloaded file", path.basename(filename)),
    openFile: (filename) => shell.openPath(filename),
    confirmOpen: async () => false,
  });
  native.host.attach(win);
  app.once("will-quit", () => {
    native.dispose();
    fixture.store.flush();
  });
  await win.loadURL(origin + "/chat/8cfc6561-4d86-4efa-8e94-72a293f83a45");
  console.log("Isolated native fixture ready", profile);
});
app.on("window-all-closed", () => app.quit());

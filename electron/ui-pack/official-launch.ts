import { app, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ClaudexUiPack } from "../../shared/claudex-contract";
import { bundledUi } from "../../shared/ui-pack";
import { downloadVerified } from "../updates/download";
import { OfficialRendererPacks, officialRendererBridge } from "./official-renderer";

let packs: OfficialRendererPacks | undefined;
let download: Promise<void> | undefined;

export function officialRendererPacks(root: string) {
  return packs ??= new OfficialRendererPacks(app.getPath("userData"), app.getVersion(), path.join(root, "ui"));
}

export function offerOfficialRenderer(ui: ClaudexUiPack | null | undefined) {
  if (!packs || download) return;
  if (ui && ui.bridge !== officialRendererBridge) return;
  const wanted = packs.store.offer(ui);
  if (!wanted || !ui) return;
  const current = packs;
  download = (async () => {
    const file = path.join(current.store.dir, "downloads", wanted + ".zip");
    try {
      await downloadVerified({ url: ui.url, file, sha256: ui.sha256 });
      await current.install(fs.readFileSync(file), wanted);
      console.log("[official-ui] renderer ready", wanted);
    } catch (error) {
      console.warn("[official-ui] renderer update failed", error);
    } finally {
      for (const name of [file, file + ".part", file + ".part.json"])
        fs.rmSync(name, { force: true });
    }
  })().finally(() => { download = undefined; });
}

export function watchOfficialRenderer(contents: WebContents, current: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadingVersion: string | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const fail = (version: string) => {
    clear();
    if (!packs || !current() || contents.isDestroyed() || version === bundledUi) return;
    packs.failed(version);
    console.warn("[official-ui] renderer rolled back", version);
    contents.reload();
  };
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { clear(); loadingVersion = undefined; }
  });
  contents.on("dom-ready", () => {
    if (!current()) return;
    void contents.executeJavaScript('document.querySelector("meta[name=claudex-renderer-version]")?.content')
      .then((version: unknown) => {
        if (typeof version !== "string" || !current() || contents.isDestroyed()) return;
        loadingVersion = version;
        packs?.retain(contents.id, version);
        const deadline = Date.now() + 60_000;
        const check = async () => {
          if (!current() || contents.isDestroyed()) return;
          try {
            const ready = await contents.executeJavaScript('!!document.querySelector("[data-testid=user-menu-button]")');
            if (loadingVersion !== version) return;
            if (ready) { packs?.ready(version); clear(); return; }
          } catch {}
          if (Date.now() >= deadline) { fail(version); return; }
          timer = setTimeout(() => void check(), 500);
        };
        void check();
      }).catch(() => {});
  });
  contents.on("render-process-gone", (_event, details) => {
    if (timer && loadingVersion && details.reason !== "clean-exit") fail(loadingVersion);
  });
  contents.once("destroyed", () => { clear(); packs?.release(contents.id); });
}

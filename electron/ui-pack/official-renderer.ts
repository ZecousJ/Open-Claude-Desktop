import fs from "node:fs";
import path from "node:path";
import { bundledUi, uiVersionFor, compareUiVersions, validUiVersion } from "../../shared/ui-pack";
import { UiPackStore } from "./store";
import { verifyPack } from "./verify";

export const officialRendererBridge = 2;
export const rendererPrefix = "/__claudex_renderer/";
const descriptor = "renderer.json";
export interface RendererVersion { version: string; root: string }

export class OfficialRendererPacks {
  readonly store: UiPackStore;
  private good: string;
  private fallback = bundledUi;
  private readonly windows = new Map<number, string>();
  constructor(userData: string, appVersion: string, private readonly bundled: string) {
    this.store = new UiPackStore(path.join(userData, "official-renderer"), {
      bundledVersion: uiVersionFor(appVersion), bridge: officialRendererBridge, bundledDir: bundled,
    });
    try { this.good = JSON.parse(fs.readFileSync(path.join(this.store.dir, "ready.json"), "utf8")).version; }
    catch { this.good = bundledUi; }
    const bundledVersion = uiVersionFor(appVersion);
    if (!this.store.runnable(this.good) ||
        (this.good !== bundledUi && compareUiVersions(this.good, bundledVersion) <= 0)) this.good = bundledUi;
    if (this.store.active !== bundledUi && compareUiVersions(this.store.active, bundledVersion) <= 0) {
      this.store.offer(null);
      this.store.activate();
    }
    this.fallback = this.good;
    if (this.store.active !== bundledUi && this.store.active !== this.good)
      this.failed(this.store.active);
  }
  root(version: string) { return this.store.rootFor(version); }
  document(activate = true): RendererVersion {
    this.fallback = this.good;
    const version = activate ? this.store.pageVersion() : this.store.current();
    return { version, root: this.root(version)! };
  }
  async install(bytes: Buffer, version: string, publicKey?: string) {
    const pack = await verifyPack(bytes, { expectVersion: version, publicKey, maxBytes: 512 * 1024 * 1024 });
    const info = JSON.parse(pack.files.get(descriptor)?.toString() ?? "null");
    if (pack.manifest.bridge !== officialRendererBridge || info?.kind !== "official-renderer" ||
        info.version !== version || !pack.files.has("app.js"))
      throw Error("The update is not a compatible desktop renderer.");
    for (const name of pack.files.keys())
      if (!(name === "index.html" || name === "app.js" || name === descriptor ||
          /^(assets|i18n|images|avatars|development)\//.test(name) ||
          /^(favicon[^/]*|apple-touch-icon\.png|official-status-preview\.html)$/.test(name)))
        throw Error("The renderer update contains a file outside its resource directories.");
    this.store.install(pack);
    this.store.installed(version);
  }
  retain(window: number, version: string) { this.windows.set(window, version); }
  release(window: number) { this.windows.delete(window); }
  ready(version: string) {
    if (version !== this.store.active) return;
    this.store.ready(version);
    this.good = version;
    fs.mkdirSync(this.store.dir, { recursive: true });
    const file = path.join(this.store.dir, "ready.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify({ version }));
    fs.renameSync(file + ".tmp", file);
    const keep = new Set([this.good, this.fallback, this.store.active, this.store.target, ...this.windows.values()]);
    for (const name of fs.readdirSync(this.store.dir))
      if (validUiVersion(name) && !keep.has(name))
        fs.rmSync(path.join(this.store.dir, name), {recursive:true, force:true});
  }
  failed(version: string) {
    this.store.failed(version);
    const next = this.fallback !== version && this.store.runnable(this.fallback) ? this.fallback : bundledUi;
    this.store.offer(next === bundledUi ? null : { version: next, bridge: officialRendererBridge });
    this.store.activate();
    return next;
  }
}

export function rendererDocument(document: string, version: string) {
  const prefix = rendererPrefix + version;
  return rewriteRendererReferences(document, version)
    .replace("<head>", '<head><meta name="claudex-renderer-version" content="' + version + '">')
    .replaceAll('src="/app.js"', 'src="' + prefix + '/app.js"');
}

export function rewriteRendererReferences(source: string, version: string) {
  const prefix = rendererPrefix + version;
  return source.replace(/(^|["'`(=\s])\/(assets|i18n|images|avatars|development)\//g, (_, before, name) => before + prefix + "/" + name + "/");
}

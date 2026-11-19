import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildUiPack } from "./ui-pack-lib";
import { officialRendererBridge } from "../../electron/ui-pack/official-renderer";
import { uiVersionFor } from "../../shared/ui-pack";
import { verifyPack } from "../../electron/ui-pack/verify";

const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf("--" + key); return i < 0 ? undefined : args[i + 1]; };
const number = Number(option("n"));
if (!Number.isInteger(number) || number < 1) throw Error("Provide --n with a positive pack number.");
const root = path.resolve(import.meta.dirname, "../..");
const source = path.join(root, "build/official-ui");
execFileSync(process.execPath, [path.join(root, "scripts/verify-official-ui-package.mjs")], { cwd: root, stdio: "inherit" });
const version = uiVersionFor(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, number);
const out = path.resolve(option("out") ?? path.join(root, "release/renderer"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-renderer-pack-"));
try {
  fs.cpSync(path.join(source, "ui"), temp, { recursive: true });
  fs.copyFileSync(path.join(source, "main-window/view.html"), path.join(temp, "index.html"));
  const allowed = new Set(["index.html", "app.js", "assets", "i18n", "images", "avatars", "development", "renderer.json", "official-status-preview.html", "apple-touch-icon.png"]);
  for (const name of fs.readdirSync(temp))
    if (!allowed.has(name) && !name.startsWith("favicon")) fs.rmSync(path.join(temp, name), { recursive: true, force: true });
  fs.writeFileSync(path.join(temp, "renderer.json"), JSON.stringify({ kind: "official-renderer", version }));
  const key = option("key") ?? path.join(os.homedir(), ".config/claudex/ui-signing.key");
  const { zip, manifest } = await buildUiPack({
    dist: temp, version, bridge: officialRendererBridge, privateKey: fs.readFileSync(key, "utf8"),
  });
  await verifyPack(zip, { expectVersion: version, maxBytes: 512 * 1024 * 1024 });
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, "claudex-renderer-" + version + ".zip");
  fs.writeFileSync(file, zip);
  const sha256 = crypto.createHash("sha256").update(zip).digest("hex");
  fs.writeFileSync(path.join(out, "offer.json"), JSON.stringify({
    version, bridge: manifest.bridge,
    url: "https://claudex.zecous.cn/downloads/claudex/ui/" + version + "/" + path.basename(file), sha256,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ file, version, bridge: manifest.bridge, bytes: zip.length, files: Object.keys(manifest.files).length }));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

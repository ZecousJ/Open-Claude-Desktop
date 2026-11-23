import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const output = "build";
const resources = ["official-ui", "official-usercontent"];
const asset = "claudex-workspace-0.0.60.tar.gz";
const publishedRelease = "workspace-0.0.60";
const digest = "37e19c0ec3224b8e894c868f39f32a32a8e6768f301c5fed9fbd4de824d3d851";
const buildId = "79979f1379";
const assembledAt = "2026-11-23T01:47:59.165Z";
const previousAssemblies = ["2026-11-21T17:56:48.468Z", "2026-11-18T10:30:15.548Z"];

function hasWorkspace(directory, assembly = assembledAt) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "official-ui", "manifest.json"), "utf8"));
    return manifest.buildId === buildId && manifest.generatedAt === assembly &&
      fs.existsSync(path.join(directory, "official-ui", "ui", "index.html")) &&
      fs.existsSync(path.join(directory, "official-usercontent", "manifest.json"));
  } catch {
    return false;
  }
}

async function prepare() {
  if (hasWorkspace(output)) return;
  const replacePrevious = previousAssemblies.some(assembly => hasWorkspace(output, assembly));
  if (!replacePrevious && resources.some(directory => fs.existsSync(path.join(output, directory))))
    throw Error("Move the existing build/official-ui and build/official-usercontent directories before installing the published workspace.");

  fs.mkdirSync(output, { recursive: true });
  const stage = fs.mkdtempSync(path.join(output, "workspace-ui-"));
  try {
    const local = process.env.CLAUDEX_WORKSPACE_UI_ARCHIVE;
    const archive = local ? path.resolve(local) : path.join(stage, asset);
    if (!local) {
      const source = `https://github.com/ZecousJ/Open-Claude-Desktop/releases/download/${publishedRelease}/${asset}`;
      const response = await fetch(source, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body)
        throw Error(`Could not download the workspace archive (HTTP ${response.status}).`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
    }
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== digest)
      throw Error("The workspace archive does not match the published build.");
    execFileSync("tar", ["-xzf", archive, "-C", stage], {
      stdio: "inherit",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (!hasWorkspace(stage)) throw Error("The workspace archive does not contain the published workspace.");
    if (replacePrevious) {
      const previous = path.join(stage, "previous");
      fs.mkdirSync(previous);
      for (const directory of resources)
        fs.renameSync(path.join(output, directory), path.join(previous, directory));
    }
    for (const directory of resources)
      fs.renameSync(path.join(stage, directory), path.join(output, directory));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

await prepare();

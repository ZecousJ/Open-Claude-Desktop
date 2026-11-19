import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareStaticImages } from './official-static-assets.mjs';
const exec = promisify(execFile);
const root = path.resolve(process.argv[2] ?? "build/official-ui");
const file = path.join(root, "ui/images/clawd/core/Clawd-CrabWalking.gif");
const sha = "a30f029d3df75d72bb11c13e84b6ae51ecbbdeb4ab70a0274eb169fa5909a95f";
const digest = (b) => createHash("sha256").update(b).digest("hex");
if (digest(await fs.readFile(file).catch(() => Buffer.alloc(0))) !== sha) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".download";
  try {
    await exec("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--retry",
      "2",
      "--max-time",
      "45",
      "https://claude.ai/images/clawd/core/Clawd-CrabWalking.gif",
      "-o",
      temp,
    ]);
    if (digest(await fs.readFile(temp)) !== sha)
      throw Error("Official preview image checksum mismatch");
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
console.log("Official loading image verified", sha);
await prepareStaticImages({ root });

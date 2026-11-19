import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SandboxDriver } from "./sandbox/driver";
import { imageType } from "../../electron/artifacts/generated-blobs";

const screenshotScript = `import base64, pathlib, sys
from playwright.sync_api import sync_playwright
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path="/usr/local/bin/chromium")
    page = browser.new_page(viewport={"width":600,"height":315}, device_scale_factor=1)
    page.route("**/*", lambda route: route.abort())
    page.set_content(pathlib.Path(sys.argv[1]).read_text(), wait_until="load", timeout=10000)
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(250)
    print("data:image/png;base64," + base64.b64encode(page.screenshot(timeout=10000)).decode())
    browser.close()
`;

const imageScript = `import json, sys
from PIL import Image
try:
    with Image.open(sys.argv[1], formats=(sys.argv[2],)) as image:
        image.load()
        print(json.dumps({"width": image.width, "height": image.height}))
except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
    print("null")
`;

async function runSandboxPython(
  driver: SandboxDriver,
  stateRoot: string,
  data: string | Buffer,
  script: string,
  args: string[],
  maxBuffer: number,
) {
  const id = `pv-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const folder = path.join(stateRoot, id);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const source = path.join(folder, "source");
  const workspace = path.join(folder, "work");
  const document = path.join(source, "input");
  let prepared: ReturnType<SandboxDriver["prepare"]> | undefined;
  try {
    await fs.mkdir(source, { mode: 0o700 });
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.writeFile(document, data, { mode: 0o600 });
    prepared = driver.prepare({
      id,
      kind: "cowork",
      stateDir: path.join(folder, "state"),
      codexBinary: "/usr/bin/python3",
      codexRoot: "/usr/bin",
      mounts: [{ host: source, writable: false }, { host: workspace, writable: true }],
      cwd: workspace,
      limits: { memoryMb: 512, pids: 256, cpus: 1, tmpMb: 128 },
    });
    const binary = prepared.binary;
    return await new Promise<string>((resolve, reject) => {
      execFile(
        binary,
        ["-c", script, document, ...args],
        { timeout: 30000, maxBuffer, env: { PATH: process.env.PATH, CODEX_HOME: workspace } },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        },
      );
    });
  } finally {
    try {
      prepared?.dispose();
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  }
}

export function captureSandboxArtifact(driver: SandboxDriver, stateRoot: string, html: string) {
  return runSandboxPython(driver, stateRoot, html, screenshotScript, [], 2 * 1024 * 1024);
}

export async function decodeSandboxImage(driver: SandboxDriver, stateRoot: string, bytes: Buffer) {
  const type = imageType(bytes)?.slice("image/".length).toUpperCase() ??
    (/^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6)) ? "GIF" : undefined);
  if (!type) return undefined;
  const output = await runSandboxPython(driver, stateRoot, bytes, imageScript, [type], 4096);
  const size: unknown = JSON.parse(output);
  if (!size || typeof size !== "object" || !("width" in size) || !("height" in size) ||
      typeof size.width !== "number" || typeof size.height !== "number") return undefined;
  return { width: size.width, height: size.height };
}

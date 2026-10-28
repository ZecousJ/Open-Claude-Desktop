import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SandboxDriver } from "./sandbox/driver";

const script = `import base64, pathlib, sys
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

export async function captureSandboxArtifact(
  driver: SandboxDriver,
  stateRoot: string,
  html: string,
) {
  const id = `screenshot-${randomUUID()}`;
  const folder = path.join(stateRoot, id);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const document = path.join(folder, "preview.html");
  let prepared: ReturnType<SandboxDriver["prepare"]> | undefined;
  try {
    await fs.writeFile(document, html, { mode: 0o600 });
    prepared = driver.prepare({
      id,
      kind: "cowork",
      stateDir: path.join(folder, "state"),
      codexBinary: "/usr/bin/python3",
      codexRoot: "/usr/bin",
      mounts: [{ host: folder, writable: false }],
      cwd: folder,
      limits: { memoryMb: 512, pids: 256, cpus: 1, tmpMb: 128 },
    });
    const binary = prepared.binary;
    return await new Promise<string>((resolve, reject) => {
      execFile(
        binary,
        ["-c", script, document],
        { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        },
      );
    });
  } finally {
    prepared?.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  }
}

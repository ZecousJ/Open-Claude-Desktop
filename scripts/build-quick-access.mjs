import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform === "darwin") {
  mkdirSync("dist-electron", { recursive: true });
  execFileSync(
    "swiftc",
    [
      "electron/quick-access-monitor.swift",
      "-module-cache-path",
      path.join(tmpdir(), "claudex-swift-cache"),
      "-o",
      "dist-electron/quick-access-monitor",
    ],
    { stdio: "inherit" },
  );
}

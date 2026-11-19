import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const targets = [
  ["darwin", "x64", "amd64"],
  ["darwin", "arm64", "arm64"],
  ["linux", "x64", "amd64"],
  ["linux", "arm64", "arm64"],
  ["win32", "x64", "amd64"],
];
for (const [platform, arch, goarch] of targets) {
  const directory = path.join(
    "build",
    "chrome-native-host",
    `${platform}-${arch}`,
  );
  mkdirSync(directory, { recursive: true });
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-o",
      path.join(
        directory,
        platform === "win32"
          ? "claudex-chrome-host.exe"
          : "claudex-chrome-host",
      ),
      "./tools/chrome-native-host/main.go",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        GOOS: platform === "win32" ? "windows" : platform,
        GOARCH: goarch,
        CGO_ENABLED: "0",
      },
    },
  );
}

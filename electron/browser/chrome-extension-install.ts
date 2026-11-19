import { app } from "electron";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";

const hostName = "cn.zecous.claudex";
const origin = "chrome-extension://ihinfgaomlffmklfhabkikjhlbehmekf/";
type Endpoint = { port: number; key: string };
export type ChromeHostFixture = {
  hostDirectory: string;
  manifestPath: string;
  bundlePath: string;
  binaryPath: string;
};

type HostPaths = {
  hostDirectory: string;
  manifestPath: string;
  binaryPath: string;
  installedBinary: string;
  bundlePath: string;
  registry: boolean;
};

function hostPaths(fixture?: ChromeHostFixture): HostPaths {
  const binaryName =
    process.platform === "win32"
      ? "claudex-chrome-host.exe"
      : "claudex-chrome-host";
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const hostDirectory =
    fixture?.hostDirectory ??
    path.join(app.getPath("userData"), "chrome-native-host");
  const e2eRoot =
    process.env.CLAUDEX_DATA_DIR && path.resolve(process.env.CLAUDEX_DATA_DIR);
  const temporaryRoot = path.resolve(os.tmpdir());
  const e2eFixture =
    process.env.CLAUDEX_OFFICIAL_UI_E2E === "1" &&
    process.env.CLAUDEX_CHROME_HOST_FIXTURE === "1" &&
    e2eRoot &&
    e2eRoot.startsWith(`${temporaryRoot}${path.sep}`) &&
    path.resolve(app.getPath("userData")) === e2eRoot;
  if (
    !fixture &&
    process.env.CLAUDEX_CHROME_HOST_FIXTURE === "1" &&
    !e2eFixture
  )
    throw Error(
      "Chrome host fixture requires an isolated temporary test profile.",
    );
  const chromeDirectory =
    process.platform === "darwin"
      ? path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Google",
          "Chrome",
          "NativeMessagingHosts",
        )
      : path.join(
          process.env.XDG_CONFIG_HOME &&
            path.isAbsolute(process.env.XDG_CONFIG_HOME)
            ? process.env.XDG_CONFIG_HOME
            : path.join(os.homedir(), ".config"),
          "google-chrome",
          "NativeMessagingHosts",
        );
  return {
    hostDirectory,
    manifestPath:
      fixture?.manifestPath ??
      (e2eFixture
        ? path.join(hostDirectory, "fixture", `${hostName}.json`)
        : process.platform === "win32"
          ? path.join(hostDirectory, `${hostName}.json`)
          : path.join(chromeDirectory, `${hostName}.json`)),
    binaryPath:
      fixture?.binaryPath ??
      path.join(
        root,
        app.isPackaged ? "chrome-native-host" : "build/chrome-native-host",
        `${process.platform}-${process.arch}`,
        binaryName,
      ),
    installedBinary: path.join(hostDirectory, binaryName),
    bundlePath: fixture?.bundlePath ?? path.join(root, "chrome-extension"),
    registry: !fixture && !e2eFixture && process.platform === "win32",
  };
}

export function chromeExtensionBundlePath(): string {
  return hostPaths().bundlePath;
}
export function chromeExtensionAvailable(): boolean {
  if (
    process.env.CLAUDEX_OFFICIAL_UI_E2E === "1" &&
    process.env.CLAUDEX_CHROME_HOST_FIXTURE !== "1"
  )
    return false;
  const paths = hostPaths();
  return [
    paths.binaryPath,
    path.join(paths.bundlePath, "manifest.json"),
    path.join(paths.bundlePath, "worker.js"),
  ].every(existsSync);
}

function atomicWrite(
  destination: string,
  contents: string,
  mode: number,
): void {
  const temporary = `${destination}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, destination);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed */
    }
  }
}

function manifest(paths: HostPaths): string {
  return JSON.stringify({
    name: hostName,
    description: "Claudex Chrome bridge",
    path: paths.installedBinary,
    type: "stdio",
    allowed_origins: [origin],
  });
}

function registered(paths: HostPaths): boolean {
  try {
    if (
      readFileSync(paths.manifestPath, "utf8") !== manifest(paths) ||
      !existsSync(paths.installedBinary)
    )
      return false;
    if (paths.registry) {
      const output = execFileSync(
        "reg.exe",
        [
          "query",
          `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
          "/ve",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      return output.includes(paths.manifestPath);
    }
    return true;
  } catch {
    return false;
  }
}

function publish(
  paths: HostPaths,
  endpoint: Endpoint,
  isCurrent: () => boolean,
): () => void {
  if (!isCurrent()) throw new Error("Chrome connection is no longer current");
  const descriptor = path.join(paths.hostDirectory, "chrome-bridge.json");
  const content = JSON.stringify(endpoint);
  atomicWrite(descriptor, content, 0o600);
  return () => {
    try {
      if (readFileSync(descriptor, "utf8") === content) unlinkSync(descriptor);
    } catch {
      /* already removed */
    }
  };
}

export async function publishChromeExtensionEndpoint(
  endpoint: Endpoint,
  isCurrent: () => boolean,
  fixture?: ChromeHostFixture,
): Promise<(() => void) | undefined> {
  const paths = hostPaths(fixture);
  if (!registered(paths)) return undefined;
  return publish(paths, endpoint, isCurrent);
}

export async function installChromeExtensionHost(
  endpoint: Endpoint,
  isCurrent: () => boolean,
  fixture?: ChromeHostFixture,
): Promise<() => void> {
  if (
    !fixture &&
    process.env.CLAUDEX_OFFICIAL_UI_E2E === "1" &&
    process.env.CLAUDEX_CHROME_HOST_FIXTURE !== "1"
  )
    throw Error(
      "Chrome host installation is unavailable in this test profile.",
    );
  const paths = hostPaths(fixture);
  if (!isCurrent()) throw new Error("Chrome connection is no longer current");
  if (
    !existsSync(paths.binaryPath) ||
    !existsSync(path.join(paths.bundlePath, "manifest.json"))
  )
    throw new Error("Chrome extension resources are unavailable");
  mkdirSync(paths.hostDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.hostDirectory, 0o700);
  const temporary = `${paths.installedBinary}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    copyFileSync(paths.binaryPath, temporary);
    chmodSync(temporary, 0o700);
    renameSync(temporary, paths.installedBinary);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed */
    }
  }
  const cleanup = publish(paths, endpoint, isCurrent);
  try {
    mkdirSync(path.dirname(paths.manifestPath), { recursive: true });
    atomicWrite(paths.manifestPath, manifest(paths), 0o600);
    if (paths.registry)
      execFileSync(
        "reg.exe",
        [
          "add",
          `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
          "/ve",
          "/t",
          "REG_SZ",
          "/d",
          paths.manifestPath,
          "/f",
        ],
        { windowsHide: true },
      );
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}

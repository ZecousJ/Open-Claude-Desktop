/**
 * Finds the tools simulators need and checks the setup. A Dock launch has no
 * shell PATH, so Homebrew's and the SDK's folders are tried by name. The checks
 * answer true, false or undefined (could not tell), and the setup screens show
 * a step as done only on true.
 */
import path from "node:path";
import type {
  AndroidSetupStatus,
  IosSetupStatus,
} from "../../shared/simulators";
import type { Runner } from "./runner";

type Platform = NodeJS.Platform;

export interface FileProbe {
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** Entries of a folder; empty when it can't be read. */
  list(path: string): Promise<string[]>;
  /** A small text file, or undefined. */
  readText(path: string): Promise<string | undefined>;
}

export interface Environment {
  platform: Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** The CPU: Android system images are per architecture. */
  arch: string;
}

// -- Android SDK -------------------------------------------------------------

/** Where the Android SDK may be: the variables Android Studio sets, then its default folder. */
export function androidSdkRoots({ platform, env, home }: Environment) {
  const fallback =
    platform === "darwin"
      ? path.join(home, "Library", "Android", "sdk")
      : platform === "win32"
        ? path.join(
            env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
            "Android",
            "Sdk",
          )
        : path.join(home, "Android", "Sdk");
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, fallback].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
}

const exe = (platform: Platform, name: string) =>
  platform === "win32" ? `${name}.exe` : name;

/** Android Studio's installation folders, with the command that opens it. */
export function androidStudioLocations({ platform, env, home }: Environment) {
  if (platform === "darwin")
    return ["/Applications", path.join(home, "Applications")].map((folder) => ({
      marker: path.join(folder, "Android Studio.app"),
      launch: ["/usr/bin/open", "-a", "Android Studio"],
    }));
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      path.join(
        env.ProgramFiles ?? "C:\\Program Files",
        "Android",
        "Android Studio",
        "bin",
        "studio64.exe",
      ),
      path.join(local, "Programs", "Android Studio", "bin", "studio64.exe"),
    ].map((marker) => ({ marker, launch: [marker] }));
  }
  return [];
}

export interface FoundAndroidTools {
  sdkRoots: string[];
  adb?: string;
  emulator?: string;
}

/** The SDK's adb and emulator: in a root that has them, else on the PATH. */
export async function findAndroidTools(
  environment: Environment,
  probe: FileProbe,
): Promise<FoundAndroidTools> {
  const roots: string[] = [];
  for (const root of androidSdkRoots(environment))
    if (await probe.exists(root)) roots.push(root);
  const { platform } = environment;
  const named = async (relative: string[], bare: string) => {
    for (const root of roots) {
      const file = path.join(root, ...relative);
      if (await probe.exists(file)) return file;
    }
    return onPath(environment, probe, bare);
  };
  return {
    sdkRoots: roots,
    adb: await named(["platform-tools", exe(platform, "adb")], "adb"),
    emulator: await named(["emulator", exe(platform, "emulator")], "emulator"),
  };
}

/** A program on the PATH, by its bare name. */
export async function onPath(
  { platform, env }: Environment,
  probe: FileProbe,
  name: string,
): Promise<string | undefined> {
  const folders = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  for (const folder of folders) {
    const file = path.join(folder, exe(platform, name));
    if (await probe.exists(file)) return file;
  }
  return undefined;
}

/** The ABI folder under `system-images/<api>/<variant>/` this computer's emulators use. */
export function systemImageAbi(arch: string) {
  return arch === "arm64" ? "arm64-v8a" : "x86_64";
}

/** Whether any API level has a system image for this CPU. */
async function hasSystemImage(root: string, abi: string, probe: FileProbe) {
  const images = path.join(root, "system-images");
  for (const level of await probe.list(images))
    for (const variant of await probe.list(path.join(images, level)))
      if ((await probe.list(path.join(images, level, variant, abi))).length > 0)
        return true;
  return false;
}

export interface AndroidSetupDeps {
  environment: Environment;
  probe: FileProbe;
  runner: Runner;
}

/** Android Studio, the SDK's platform-tools and emulator, a system image and a virtual device. */
export async function checkAndroidSetup(
  deps: AndroidSetupDeps,
): Promise<AndroidSetupStatus> {
  const { environment, probe, runner } = deps;
  if (environment.platform !== "darwin" && environment.platform !== "win32")
    return { studioInstalled: false };
  let studioInstalled = false;
  for (const location of androidStudioLocations(environment))
    if (await probe.exists(location.marker)) {
      studioInstalled = true;
      break;
    }
  const tools = await findAndroidTools(environment, probe);
  const platformTools = tools.adb !== undefined;
  const emulator = tools.emulator !== undefined;
  let systemImage: boolean | undefined;
  if (tools.sdkRoots.length > 0) {
    systemImage = false;
    for (const root of tools.sdkRoots)
      if (await hasSystemImage(root, systemImageAbi(environment.arch), probe)) {
        systemImage = true;
        break;
      }
  } else if (!platformTools && !emulator) systemImage = false;
  let avd: boolean | undefined;
  if (tools.emulator) {
    try {
      avd =
        (
          await runner.run(tools.emulator, ["-list-avds"], {
            timeoutMs: 15_000,
          })
        )
          .split("\n")
          .filter((line) => line.trim() && !/^INFO\b/.test(line.trim()))
          .length > 0;
    } catch {
      avd = undefined;
    }
  } else {
    const folder =
      environment.env.ANDROID_AVD_HOME ||
      path.join(environment.home, ".android", "avd");
    avd = (await probe.list(folder)).some((name) => name.endsWith(".ini"));
  }
  return {
    studioInstalled,
    platformTools,
    emulator,
    systemImage,
    avd,
    ...(tools.sdkRoots[0] ? { sdkRoot: tools.sdkRoots[0] } : {}),
  };
}

// -- Xcode -------------------------------------------------------------------

/** The folder `xcode-select -s` takes for the usual Xcode.app. */
export const defaultXcodeDeveloper =
  "/Applications/Xcode.app/Contents/Developer";

/** Homebrew and pip put idb here; a Dock launch has no PATH for them. */
export function idbCandidates({ env, home }: Environment) {
  const folders = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    ...(env.PATH ?? "").split(":").filter(Boolean),
  ];
  return folders.map((folder) => path.join(folder, "idb"));
}

export async function findIdb(
  environment: Environment,
  probe: FileProbe,
): Promise<string | undefined> {
  if (environment.platform !== "darwin") return undefined;
  for (const file of idbCandidates(environment))
    if (await probe.exists(file)) return file;
  // pip's --user scripts live in a per-version folder.
  const pythons = path.join(environment.home, "Library", "Python");
  for (const version of await probe.list(pythons)) {
    const file = path.join(pythons, version, "bin", "idb");
    if (await probe.exists(file)) return file;
  }
  return undefined;
}

export interface IosSetupDeps {
  environment: Environment;
  probe: FileProbe;
  runner: Runner;
}

/** Whether a Developer folder has the iOS Simulator platform. */
async function hasSimulatorPlatform(developer: string, probe: FileProbe) {
  return probe.exists(
    path.join(developer, "Platforms", "iPhoneSimulator.platform"),
  );
}

/**
 * Xcode (selected, with the simulator platform), the iOS runtimes, and idb.
 * `xcodeSelectFixPath` is set when Xcode is there but the command-line
 * tools point somewhere else: the path to select, or "" when Xcode is
 * installed somewhere unusual.
 */
export async function checkIosSetup(
  deps: IosSetupDeps,
): Promise<IosSetupStatus> {
  const { environment, probe, runner } = deps;
  const input = (await findIdb(environment, probe)) !== undefined;
  if (environment.platform !== "darwin")
    return { xcode: false, simulators: false, input };
  let selected: string | undefined;
  try {
    selected = (await runner.run("xcode-select", ["-p"])).trim() || undefined;
  } catch {
    selected = undefined;
  }
  const usable = selected ? await hasSimulatorPlatform(selected, probe) : false;
  if (!usable) {
    // Not selected, or only the command-line tools are: is Xcode installed?
    if (await hasSimulatorPlatform(defaultXcodeDeveloper, probe))
      return { xcodeSelectFixPath: defaultXcodeDeveloper, input };
    const apps = (await probe.list("/Applications")).filter((name) =>
      /^Xcode.*\.app$/.test(name),
    );
    for (const app of apps)
      if (
        await hasSimulatorPlatform(
          `/Applications/${app}/Contents/Developer`,
          probe,
        )
      )
        return { xcodeSelectFixPath: "", input };
    return { xcode: false, simulators: false, input };
  }
  let xcodeVersion: string | undefined;
  try {
    xcodeVersion = /^Xcode ([\w.-]+)/
      .exec(
        await runner.run("xcodebuild", ["-version"], { timeoutMs: 15_000 }),
      )?.[1]
      ?.slice(0, 32);
  } catch {
    /* the version is only shown */
  }
  let simulators: boolean | undefined;
  try {
    const list = JSON.parse(
      await runner.run(
        "xcrun",
        ["simctl", "list", "devices", "available", "--json"],
        {
          timeoutMs: 20_000,
        },
      ),
    );
    simulators = Object.entries(list.devices ?? {}).some(
      ([runtime, devices]) =>
        runtime.includes("SimRuntime.iOS") &&
        Array.isArray(devices) &&
        devices.length > 0,
    );
  } catch {
    simulators = undefined;
  }
  return {
    xcode: true,
    ...(xcodeVersion ? { xcodeVersion } : {}),
    simulators,
    input,
  };
}

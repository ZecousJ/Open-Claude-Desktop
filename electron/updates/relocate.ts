/**
 * Moving a misnamed Claudex bundle into place: a copy that starts under
 * another name (an installer that kept its own, say) renames the bundle to
 * Claudex.app in the same folder
 * (replacing an older Claudex.app, or giving way to a newer one) and relaunches
 * from the new path. When the folder can't be changed Claudex keeps running
 * where it is and shows nothing. No Electron imports.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { macAppBundle, relocationPlan } from "../../shared/app-update";
import { macRelaunchScript } from "./scripts";

/**
 * A bundle's CFBundleShortVersionString: undefined when there is no bundle,
 * null when it has no readable version.
 */
export function bundleVersion(bundle: string): string | null | undefined {
  const plist = path.join(bundle, "Contents", "Info.plist");
  if (!fs.existsSync(bundle)) return undefined;
  try {
    const text = fs.readFileSync(plist, "utf8");
    const match =
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,64})<\/string>/.exec(
        text,
      );
    if (match) return match[1].trim();
  } catch {
    return null;
  }
  try {
    // A binary property list.
    const value = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist],
      { encoding: "utf8", timeout: 5_000 },
    ).trim();
    return value || null;
  } catch {
    return null;
  }
}

export interface RelocateOptions {
  execPath: string;
  version: string;
  pid: number;
  /** Where the helper script is written. */
  scriptDir: string;
  readVersion?: (bundle: string) => string | null | undefined;
  spawnImpl?: typeof spawn;
  now?: () => number;
}

export type RelocateResult =
  { relaunch: false; error?: string } | { relaunch: true; target: string };

/**
 * Renames or replaces as relocationPlan says and starts the helper that
 * opens Claudex.app once this process exits. `relaunch: true` means the
 * caller must exit now.
 */
export function relocateBundle(options: RelocateOptions): RelocateResult {
  const bundle = macAppBundle(options.execPath);
  if (!bundle) return { relaunch: false };
  const readVersion = options.readVersion ?? bundleVersion;
  const target = path.join(path.dirname(bundle), "Claudex.app");
  const plan = relocationPlan({
    bundle,
    version: options.version,
    targetVersion:
      path.basename(bundle) === "Claudex.app" ? undefined : readVersion(target),
  });
  if (plan.action === "none") return { relaunch: false };
  let remove = "";
  try {
    if (plan.action === "rename") fs.renameSync(bundle, plan.target);
    else if (plan.action === "replace") {
      const backup = path.join(
        path.dirname(bundle),
        `.Claudex-previous-${(options.now ?? Date.now)()}.app`,
      );
      fs.renameSync(plan.target, backup);
      try {
        fs.renameSync(bundle, plan.target);
      } catch (error) {
        fs.renameSync(backup, plan.target);
        throw error;
      }
      remove = backup;
    } else remove = bundle;
    fs.mkdirSync(options.scriptDir, { recursive: true });
    const script = path.join(options.scriptDir, "relaunch-claudex.sh");
    fs.writeFileSync(script, macRelaunchScript, { mode: 0o700 });
    const child = (options.spawnImpl ?? spawn)(
      "/bin/bash",
      [script, String(options.pid), plan.target, remove],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    return { relaunch: true, target: plan.target };
  } catch (error) {
    return {
      relaunch: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

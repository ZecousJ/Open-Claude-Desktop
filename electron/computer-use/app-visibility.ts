/**
 * Full control hides the apps Claudex wasn't allowed to use and, with
 * "Unhide apps when Claude finishes", shows exactly those again afterwards
 * (R10 design §3.1). macOS only: `NSRunningApplication.hide` / `unhide`
 * through osascript's Objective-C bridge (no Apple Events, so no extra
 * permission). Windows has no equivalent that restores windows the way
 * they were, so there Claudex doesn't hide anything and Settings doesn't
 * show the option.
 */
import { execFile } from "node:child_process";

export const canHideApps = process.platform === "darwin";

const script = `
ObjC.import("AppKit");
function run(argv) {
  const input = JSON.parse(argv[0]);
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const done = [];
  for (let i = 0; i < Number(apps.count); i++) {
    const app = apps.objectAtIndex(i);
    if (Number(app.activationPolicy) !== 0) continue;
    const id = ObjC.unwrap(app.bundleIdentifier);
    if (!id) continue;
    if (input.hide) {
      if (app.processIdentifier === input.keepPid) continue;
      if (input.keep.indexOf(id.toLowerCase()) >= 0 || app.hidden) continue;
      if (app.hide) done.push(id);
    } else if (input.unhide.indexOf(id) >= 0) {
      if (app.unhide) done.push(id);
    }
  }
  return JSON.stringify(done);
}`;

function runScript(input: unknown): Promise<string[]> {
  return new Promise((resolve) =>
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, JSON.stringify(input)],
      { timeout: 10_000 },
      (error, stdout) => {
        if (error) return resolve([]);
        try {
          const out = JSON.parse(stdout.trim());
          resolve(
            Array.isArray(out)
              ? out.filter((id) => typeof id === "string")
              : [],
          );
        } catch {
          resolve([]);
        }
      },
    ),
  );
}

/** Hides every regular app except Claudex and `keep` (bundle ids); returns the ones it hid. */
export async function hideOtherApps(keep: string[]): Promise<string[]> {
  if (!canHideApps) return [];
  return runScript({
    hide: true,
    keep: keep.map((id) => id.toLowerCase()),
    keepPid: process.pid,
  });
}

/** Shows the apps `hideOtherApps` hid. */
export async function unhideApps(ids: string[]): Promise<void> {
  if (!canHideApps || !ids.length) return;
  await runScript({ hide: false, unhide: ids });
}

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { macAppBundle } from "../../shared/app-update";

// .
export const ownershipDeclineMs = 7 * 24 * 60 * 60_000;
export const ownershipCopy = {
  title: "Fix required for auto-updates",
  detail:
    "This app's file ownership is preventing auto-updates from working smoothly. Claudex needs to fix the ownership, which requires administrator access. You'll be prompted for your fingerprint or password.",
  fix: "Fix ownership",
  later: "Not now",
  failed: "Ownership fix failed",
  failureDetail:
    "The ownership fix didn't complete. Auto-updates may not work until this is resolved. You can try again next time.",
  ok: "OK",
} as const;

export function ownershipAdmin(groups: number[] | undefined) {
  return !groups || groups.includes(80) || groups.length >= 16;
}

export interface OwnershipHost {
  rootWheel(): Promise<boolean>;
  groups(): number[] | undefined;
  declinedAt(): number | undefined;
  decline(value: number | undefined): void;
  confirm(): Promise<boolean>;
  fix(): Promise<void>;
  failed(): Promise<void>;
  now?: () => number;
}

export function ownershipCheck(host: OwnershipHost) {
  let prompted = false;
  let pending: Promise<boolean> | undefined;
  const check = async () => {
    if (prompted) return true;
    try {
      if (!(await host.rootWheel())) return true;
    } catch {
      return true;
    }
    let groups: number[] | undefined;
    try {
      groups = host.groups();
    } catch {
      /* Assume admin if unavailable. */
    }
    if (!ownershipAdmin(groups)) return false;
    const now = host.now ?? Date.now;
    const declined = host.declinedAt();
    if (declined !== undefined && now() - declined < ownershipDeclineMs)
      return false;
    prompted = true;
    if (!(await host.confirm())) {
      host.decline(now());
      return false;
    }
    try {
      await host.fix();
      host.decline(undefined);
      return true;
    } catch (error) {
      host.decline(now());
      if (
        !/User canceled authorization|User cancelled|\(-128\)/i.test(
          String(error),
        )
      )
        await host.failed();
      return false;
    }
  };
  return () =>
    (pending ??= check().finally(() => {
      pending = undefined;
    }));
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function ownershipFixScript(bundle: string) {
  const target = shellQuote(bundle);
  const command = `/usr/sbin/chown -R root:staff ${target} && /bin/chmod -R g+rwX ${target}`;
  return `do shell script ${JSON.stringify(command)} with administrator privileges`;
}

export function ownershipState(userData: string, execPath: string) {
  const file = path.join(userData, "app-ownership.json");
  return {
    rootWheel: async () => {
      const bundle = macAppBundle(execPath);
      if (!bundle) return false;
      const stat = await fs.promises.stat(bundle);
      return stat.uid === 0 && stat.gid === 0;
    },
    groups: () => process.getgroups?.(),
    declinedAt: () => {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8")).declinedAt;
        return typeof value === "number" ? value : undefined;
      } catch {
        return undefined;
      }
    },
    decline: (declinedAt: number | undefined) => {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ declinedAt }), { mode: 0o600 });
    },
    fix: async () => {
      const bundle = macAppBundle(execPath);
      if (!bundle) throw new Error("No app bundle");
      await promisify(execFile)("/usr/bin/osascript", [
        "-e",
        ownershipFixScript(bundle),
      ]);
    },
  };
}

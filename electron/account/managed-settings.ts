import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { lockedPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { PolicySource } from "./client-policy";

const managedSchema = z
  .object({
    permissionModes: z
      .array(z.enum(["auto", "manual", "acceptEdits", "plan"]))
      .optional(),
    incognito: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    voice: z.boolean().optional(),
    localMcpEditing: z.boolean().optional(),
    developerModeEnabled: z.boolean().optional(),
    remoteImages: z.boolean().optional(),
    externalLinks: z.boolean().optional(),
    sshRemote: z.boolean().optional(),
    sshHostAllowlist: z.array(z.string().trim().min(1)).optional(),
    sshClientPath: z.string().min(1).optional(),
    workflows: z.boolean().optional(),
    approvalsAlwaysAllow: z.boolean().optional(),
    browser: z
      .object({
        enabled: z.boolean().optional(),
        externalSites: z.boolean().optional(),
        allowScript: z.boolean().optional(),
        devServers: z.boolean().optional(),
        blockedDomains: z
          .array(z.string().min(1).max(253))
          .max(1000)
          .optional(),
      })
      .optional(),
  })
  .strict();

export type ManagedSettings = z.infer<typeof managedSchema>;

export interface ManagedSettingsHost {
  platform: NodeJS.Platform;
  username: string;
  read(file: string): string;
  command(program: string, args: string[]): string;
}

const host: ManagedSettingsHost = {
  platform: process.platform,
  username: os.userInfo().username,
  read: (file) => {
    if (fs.statSync(file).size > 256_000)
      throw new Error("Managed settings exceed the size limit");
    return fs.readFileSync(file, "utf8");
  },
  command: (program, args) =>
    execFileSync(program, args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
};

function absent(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// Machine then user plist precedence.
export function readManagedSettings(
  deps: ManagedSettingsHost = host,
): ManagedSettings {
  const parse = (text: string) => managedSchema.parse(JSON.parse(text));
  if (deps.platform === "darwin") {
    let settings: ManagedSettings = {};
    const files = ["/Library/Managed Preferences/dev.claudex.desktop.plist"];
    if (deps.username && !/[\\/]/.test(deps.username))
      files.push(
        `/Library/Managed Preferences/${deps.username}/dev.claudex.desktop.plist`,
      );
    for (const file of files) {
      try {
        deps.read(file);
      } catch (error) {
        if (absent(error)) continue;
        throw error;
      }
      const next = parse(
        deps.command("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]),
      );
      settings = {
        ...settings,
        ...next,
        browser: { ...settings.browser, ...next.browser },
      };
    }
    return settings;
  }
  if (deps.platform === "win32") {
    const key = "HKLM\\SOFTWARE\\Policies\\Claudex";
    const parent = deps.command("reg.exe", [
      "query",
      "HKLM\\SOFTWARE\\Policies",
    ]);
    if (
      !/^\s*HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claudex\s*$/im.test(parent)
    )
      return {};
    const listing = deps.command("reg.exe", ["query", key]);
    const match = /^\s*Settings\s+REG_SZ\s+(.+)$/m.exec(listing);
    if (!match) {
      if (!/\bSettings\s+REG_/.test(listing)) return {};
      throw new Error("Managed Settings registry value must be REG_SZ");
    }
    return parse(match[1]);
  }
  try {
    return parse(deps.read("/etc/claudex/managed-settings.json"));
  } catch (error) {
    if (absent(error)) return {};
    throw error;
  }
}

export function applyManagedSettings(
  policy: ClientPolicy,
  managed: ManagedSettings,
): ClientPolicy {
  const next = { ...policy };
  if (managed.sshHostAllowlist !== undefined)
    next.sshHostAllowlist = managed.sshHostAllowlist;
  if (managed.sshClientPath !== undefined)
    next.sshClientPath = managed.sshClientPath;
  for (const key of [
    "incognito",
    "webSearch",
    "voice",
    "localMcpEditing",
    "developerModeEnabled",
    "remoteImages",
    "externalLinks",
    "sshRemote",
    "workflows",
    "approvalsAlwaysAllow",
  ] as const)
    if (managed[key] === false) next[key] = false;
  if (managed.permissionModes)
    next.permissionModes = policy.permissionModes.filter((mode) =>
      managed.permissionModes!.includes(mode),
    );
  if (!next.webSearch) next.webSearchDefault = false;
  if (managed.browser) {
    const current = policy.browser;
    next.browser = {
      enabled: current?.enabled !== false && managed.browser.enabled !== false,
      externalSites:
        current?.externalSites !== false &&
        managed.browser.externalSites !== false,
      allowScript:
        current?.allowScript !== false && managed.browser.allowScript !== false,
      devServers:
        current?.devServers !== false && managed.browser.devServers !== false,
      blockedDomains: [
        ...new Set([
          ...(current?.blockedDomains ?? []),
          ...(managed.browser.blockedDomains ?? []),
        ]),
      ],
    };
  }
  return next;
}

export class ManagedPolicySource implements PolicySource {
  readonly refreshIntervalMs: number;
  private managed: ManagedSettings = {};
  private invalid = false;
  constructor(
    private inner: PolicySource,
    private onChange: (policy: ClientPolicy) => void,
    private read = readManagedSettings,
  ) {
    this.refreshIntervalMs = inner.refreshIntervalMs ?? 60_000;
    this.reload();
  }
  private reload() {
    try {
      this.managed = this.read();
      this.invalid = false;
    } catch (error) {
      this.invalid = true;
      console.error("Managed configuration could not be read:", error);
    }
  }
  apply(policy: ClientPolicy) {
    return this.invalid
      ? {
          ...policy,
          ...lockedPolicy,
          revision: policy.revision,
          browser: {
            enabled: false,
            externalSites: false,
            allowScript: false,
            devServers: false,
            blockedDomains: [],
          },
          sshRemote: false,
          workflows: false,
        }
      : applyManagedSettings(policy, this.managed);
  }
  current() {
    return this.apply(this.inner.current());
  }
  /**
   * Reads the managed file again and asks the inner source (`force` reaches
   * the service's: asked now, not after 30 s). The inner source tells of its
   * own changes; this tells only of a change in the managed settings (the
   * managed layer applies the same way twice, so the host may apply it again).
   */
  async refresh(force?: boolean) {
    const before = JSON.stringify([this.managed, this.invalid]);
    this.reload();
    await (this.inner.refresh as (force?: boolean) => Promise<void>).call(
      this.inner,
      force,
    );
    if (JSON.stringify([this.managed, this.invalid]) !== before)
      this.onChange(this.current());
  }
}

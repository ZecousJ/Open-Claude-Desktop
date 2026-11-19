import path from "node:path";
import { z } from "zod";
import { modeAllowed, type ClientPolicy } from "../../shared/client-policy";
import type { RemoteWorkspace } from "./remote-workspace";

type Source = "user" | "project" | "projectLocal" | "managed";
type Setting<T> = { value: T; source: Source; path: string };
type Permission = "default" | "acceptEdits" | "plan";
export interface ResolvedSshSettings {
  model?: Setting<string>;
  defaultPermissionMode?: Setting<Permission>;
  disableBypassPermissionsMode?: Setting<"disable">;
  disableAutoMode?: Setting<"disable">;
}

const settingsFile = z.object({
  model: z.string().min(1).max(200).optional().catch(undefined),
  permissions: z.object({
    defaultMode: z.enum(["default", "manual", "acceptEdits", "plan"]).optional().catch(undefined),
  }).optional().catch(undefined),
});

export function applySshSettingsPolicy(settings: ResolvedSshSettings, policy: ClientPolicy): ResolvedSshSettings {
  const result: ResolvedSshSettings = {
    ...settings,
    disableBypassPermissionsMode: undefined,
    disableAutoMode: undefined,
  };
  const mode = result.defaultPermissionMode?.value;
  if (mode && !modeAllowed(policy, mode === "default" ? "manual" : mode))
    delete result.defaultPermissionMode;
  if (!modeAllowed(policy, "auto"))
    result.disableAutoMode = { value: "disable", source: "managed", path: "client-policy" };
  return result;
}

export async function readSshSettings(
  readFile: RemoteWorkspace["readFileInside"],
  home: string,
  trustedCwd?: string,
): Promise<ResolvedSshSettings> {
  const layers: { root: string; file: string; source: Source }[] = [
    { root: home, file: ".claude/settings.json", source: "user" },
    ...(trustedCwd ? [
      { root: trustedCwd, file: ".claude/settings.json", source: "project" as const },
      { root: trustedCwd, file: ".claude/settings.local.json", source: "projectLocal" as const },
    ] : []),
  ];
  const result: ResolvedSshSettings = {};
  for (const { root, file, source } of layers) {
    const filename = path.posix.join(root, file);
    try {
      const bytes = await readFile(root, filename, 1024 * 1024, { followLinks: true });
      const settings = settingsFile.parse(JSON.parse(bytes.toString("utf8")));
      const setting = <T>(value: T): Setting<T> => ({ value, source, path: filename });
      if (settings.model) result.model = setting(settings.model);
      const mode = settings.permissions?.defaultMode;
      if (mode) result.defaultPermissionMode = setting(mode === "manual" ? "default" : mode);
    } catch {}
  }
  return result;
}

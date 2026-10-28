import path from "node:path";

import type { SessionGrant, SavedGrants } from "./cowork-folders";
export const trustedLimit = 500;

/** Folders never handed to Cowork, besides the file system roots. */
export let protectedFolders: string[] = [];

export function systemFolders(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const drive = process.env.SystemDrive || "C:";
    return [
      process.env.SystemRoot || `${drive}\\Windows`,
      process.env.ProgramFiles || `${drive}\\Program Files`,
      process.env["ProgramFiles(x86)"] || `${drive}\\Program Files (x86)`,
      process.env.ProgramData || `${drive}\\ProgramData`,
    ];
  }
  return [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/private/etc",
    "/dev",
    "/proc",
    "/sys",
    "/boot",
    "/Library",
    "/Applications",
  ];
}

export function emptyGrants(): SavedGrants {
  return { version: 1, trusted: [], sessions: {}, routines: {} };
}

export function validGrants(value: any): SavedGrants {
  if (!value || typeof value !== "object" || value.version !== 1)
    throw new Error("Invalid Cowork folder grants.");
  const strings = (list: unknown, limit: number) =>
    Array.isArray(list)
      ? list
          .filter(
            (item): item is string =>
              typeof item === "string" && path.isAbsolute(item),
          )
          .slice(0, limit)
      : [];
  const sessions: Record<string, SessionGrant> = {};
  for (const [id, session] of Object.entries(value.sessions ?? {})) {
    if (!session || typeof session !== "object") continue;
    const primary = (session as any).primary;
    sessions[id] = {
      ...(typeof primary === "string" && path.isAbsolute(primary)
        ? { primary }
        : {}),
      extra: strings((session as any).extra, extraLimit),
    };
  }
  const routines: Record<string, string> = {};
  for (const [id, folder] of Object.entries(value.routines ?? {}))
    if (typeof folder === "string" && path.isAbsolute(folder))
      routines[id] = folder;
  const projects: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(value.projects ?? {})) {
    const folders = strings(list, projectGrantLimit);
    if (folders.length) projects[id] = folders;
  }
  return {
    version: 1,
    trusted: strings(value.trusted, trustedLimit),
    sessions,
    routines,
    ...(Object.keys(projects).length ? { projects } : {}),
  };
}

export const extraLimit = 20;

/** A project has up to 16 folders (shared/project-folders.ts). */
export const projectGrantLimit = 16;

/** The app's own data (tokens, device keys, every profile) is never a Cowork folder. */
export function protectCoworkFolders(...folders: string[]) {
  protectedFolders = [...new Set([...protectedFolders, ...folders])];
}

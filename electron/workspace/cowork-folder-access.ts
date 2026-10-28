import fs from "node:fs";
import path from "node:path";
import { type CoworkFolderAccess } from "../../shared/cowork-api";
import { trustedLimit } from "./cowork-folders-support";
import { protectedFolders } from "./cowork-folders-support";
import { systemFolders } from "./cowork-folders-support";
import { emptyGrants } from "./cowork-folders-support";
import { validGrants } from "./cowork-folders-support";
import type { CoworkFolderGrants } from "./cowork-folders";
import type { SessionGrant, SavedGrants } from "./cowork-folders";

/**
 * Why a folder can never be granted, if it can't, in the original's words: a
 * system folder is a protected location; a drive, a volume or a folder holding
 * one contains a protected location; the app's data is named as such.
 */
export function refusal(
  this: CoworkFolderGrants,
  folder: string,
): string | undefined {
  const pathApi = this.platform === "win32" ? path.win32 : path.posix;
  if (
    pathApi.parse(folder).root &&
    this.same(folder, pathApi.parse(folder).root)
  )
    return "This folder contains a protected location on your device and can’t be shared with this session. Try a more specific folder instead.";
  for (const system of systemFolders(this.platform)) {
    const real = this.normalize(system) ?? system;
    if (this.within(folder, real) || this.within(folder, system))
      return "This folder is a protected location on your device and can’t be shared with this session.";
  }
  // A mounted volume's root (/Volumes/<name>) is a whole drive too.
  if (
    this.platform === "darwin" &&
    pathApi.dirname(folder).toLowerCase() === "/volumes"
  )
    return "This folder contains a protected location on your device and can’t be shared with this session. Try a more specific folder instead.";
  const home = this.normalize(this.home) ?? this.home;
  for (const own of protectedFolders) {
    const real = this.normalize(own) ?? own;
    if (this.within(folder, real) || this.within(folder, own))
      return "This folder contains Claudex’s app data and can’t be shared with this session. Try a more specific folder instead.";
    // A folder that holds the app's data (~/Library, /Users, …) would hand
    // it over as well; only the home folder itself may be chosen (with a
    // warning in the dialog).
    if (
      !this.same(folder, home) &&
      (this.within(real, folder) || this.within(own, folder))
    )
      return "This folder contains Claudex’s app data and can’t be shared with this session. Try a more specific folder instead.";
  }
  return undefined;
}

export function load(this: CoworkFolderGrants) {
  if (this.loaded) return;
  let raw: string;
  try {
    raw = fs.readFileSync(this.file, "utf8");
  } catch (error: any) {
    // An unreadable file is never overwritten: Cowork folders stay closed.
    if (error?.code !== "ENOENT")
      throw new Error(
        "Cowork folder permissions couldn't be read. Restart the app to try again.",
      );
    // First run with folder permission: the folders people already used
    // keep working (they chose them themselves); nothing is trusted yet.
    this.data = this.adopt();
    this.save();
    this.loaded = true;
    return;
  }
  this.loaded = true;
  try {
    this.data = validGrants(JSON.parse(raw));
  } catch {
    // A damaged file starts empty (every folder asks again); the old one is kept.
    try {
      fs.renameSync(this.file, `${this.file}.damaged-${this.now()}`);
    } catch {}
    this.data = emptyGrants();
    this.save();
  }
}

export function adopt(this: CoworkFolderGrants): SavedGrants {
  const data = emptyGrants();
  const readList = (name: string): any[] => {
    try {
      const value = JSON.parse(
        fs.readFileSync(path.join(this.root, name), "utf8"),
      );
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  for (const c of readList("conversations.json")) {
    if (c?.mode !== "cowork" || typeof c.id !== "string") continue;
    if (typeof c.cwd !== "string") continue;
    const folder = this.normalize(c.cwd);
    if (!folder || this.isDefault(folder) || this.refusal(folder)) continue;
    data.sessions[c.id] = { primary: folder, extra: [] };
  }
  for (const task of readList("schedules.json")) {
    if (task?.mode !== "cowork" || typeof task.id !== "string") continue;
    if (typeof task.cwd !== "string") continue;
    const folder = this.normalize(task.cwd);
    if (!folder || this.isDefault(folder) || this.refusal(folder)) continue;
    data.routines[task.id] = folder;
  }
  return data;
}

export function save(this: CoworkFolderGrants) {
  fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  const temporary = `${this.file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temporary, this.file);
}

export function session(
  this: CoworkFolderGrants,
  conversationId: string,
): SessionGrant | undefined {
  this.load();
  return (
    this.memorySessions.get(conversationId) ??
    this.data.sessions[conversationId]
  );
}

export function pendingFor(this: CoworkFolderGrants, folder: string): boolean {
  const now = this.now();
  for (const [key, expires] of this.pending)
    if (expires <= now) this.pending.delete(key);
  return this.pending.has(this.key(folder));
}

/**
 * Whether Cowork may use `folder` (for the conversation, when given)
 * without asking.
 */
export function access(
  this: CoworkFolderGrants,
  folder: string,
  conversationId?: string,
  projectId?: string,
): CoworkFolderAccess {
  this.load();
  const real = this.normalize(folder);
  const describe = (resolved: string) => ({
    folder: resolved,
    name: path.basename(resolved) || resolved,
    ...(this.same(resolved, this.normalize(this.home) ?? this.home)
      ? { home: true }
      : {}),
  });
  // The workspace is created on the first send.
  if (!real && this.isDefault(path.resolve(folder)))
    return { state: "default", ...describe(path.resolve(folder)) };
  if (!real)
    return {
      state: "refused",
      ...describe(path.resolve(folder)),
      reason: "This folder no longer exists.",
    };
  if (this.isDefault(real)) return { state: "default", ...describe(real) };
  const reason = this.refusal(real);
  if (reason) return { state: "refused", ...describe(real), reason };
  if (this.data.trusted.some((trusted) => this.within(real, trusted)))
    return { state: "trusted", ...describe(real) };
  const session = conversationId ? this.session(conversationId) : undefined;
  if (
    session &&
    [session.primary, ...session.extra].some(
      (granted) => granted && this.within(real, granted),
    )
  )
    return { state: "granted", ...describe(real) };
  if (!conversationId && this.pendingFor(real))
    return { state: "granted", ...describe(real) };
  // A folder the person allowed for the project, when asked for it.
  if (
    projectId &&
    (this.data.projects?.[projectId] ?? []).some((granted) =>
      this.within(real, granted),
    )
  )
    return { state: "granted", ...describe(real) };
  return { state: "ask", ...describe(real) };
}

/** Makes a folder trusted: Cowork uses it and its subfolders without asking. */
export function trust(this: CoworkFolderGrants, folder: string): string {
  this.load();
  const real = this.checked(folder);
  if (!this.data.trusted.some((trusted) => this.within(real, trusted))) {
    if (this.data.trusted.length >= trustedLimit)
      throw new Error(
        `You can trust up to ${trustedLimit} folders. Remove one first.`,
      );
    // A new parent replaces the trusted folders inside it.
    this.data.trusted = [
      ...this.data.trusted.filter((trusted) => !this.within(trusted, real)),
      real,
    ];
    this.save();
  }
  return real;
}

export function untrust(this: CoworkFolderGrants, folder: string): void {
  this.load();
  const before = this.data.trusted.length;
  this.data.trusted = this.data.trusted.filter(
    (trusted) => !this.same(trusted, folder),
  );
  if (this.data.trusted.length !== before) this.save();
}

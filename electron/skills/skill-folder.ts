import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { Document, isMap, parseDocument } from "yaml";
import { skillExistsMessage } from "../../shared/skill-upload";
import { skillNameTaken, renameSameName } from "../../shared/duplicate-name";
import { isSavedSkillName } from "../../shared/skill-name-plan";
import { scanSkillContents } from "./skill-scan";

const maxBytes = 20 * 1024 * 1024;
export const maxSkillFolderFiles = 500;
export const officialSkillAuthoring = Symbol("officialSkillAuthoring");

export function createAuthoredSkillFolder(
  skillsFolder: string,
  name: string,
  files: readonly { relativePath: string; content: string }[],
  displayName?: string,
) {
  const paths = new Set<string>();
  for (const { relativePath } of files) {
    if (paths.has(relativePath)) throw Error("Each skill file needs a unique path.");
    paths.add(relativePath);
  }
  const target = path.join(skillsFolder, name);
  if (fs.lstatSync(target, { throwIfNoEntry: false })) throw Error(skillNameTaken);
  fs.mkdirSync(skillsFolder, { recursive: true });
  const staging = fs.mkdtempSync(path.join(skillsFolder, ".create-"));
  try {
    for (const { relativePath, content } of files) {
      const file = path.join(staging, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    }
    if (displayName && displayName !== name && !paths.has("agents/openai.yaml"))
      writeSkillDisplayName(staging, displayName);
    checkSkillFolder(staging, undefined, true);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) throw Error(skillNameTaken);
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export interface SkillFolderLimits {
  files: number;
  bytes: number;
  message: string;
}

/** The `name:` of a SKILL.md front matter, if it has one. */
export function skillName(markdown: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const line = front?.[1]
    .split(/\r?\n/)
    .find((value) => /^name\s*:/.test(value));
  const value = line?.replace(/^name\s*:\s*/, "").trim();
  if (!value) return undefined;
  try {
    return value.startsWith('"')
      ? JSON.parse(value)
      : value.replace(/^'|'$/g, "");
  } catch {
    return undefined;
  }
}

/**
 * Checks a folder chosen for Upload skill: a SKILL.md with a valid name,
 * no links, at most 500 files and 20 MB. Returns the skill's name.
 */
export function checkSkillFolder(
  folder: string,
  limits: SkillFolderLimits = {
    files: maxSkillFolderFiles,
    bytes: maxBytes,
    message: "Skill folders can be up to 500 files and 20 MB.",
  },
  savedName = false,
): string {
  const manifest = path.join(folder, "SKILL.md");
  if (!fs.existsSync(manifest))
    throw Error("The folder needs a SKILL.md file.");
  const name = skillName(fs.readFileSync(manifest, "utf8"));
  if (
    !name ||
    !(savedName ? isSavedSkillName(name) : /^[a-z][a-z0-9-]{0,63}$/.test(name))
  )
    throw Error(
      "SKILL.md needs a name of lowercase letters, numbers and hyphens.",
    );
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw Error("Skill folders can't contain links.");
      if (entry.isDirectory()) walk(full);
      else {
        files++;
        bytes += fs.statSync(full).size;
        if (files > limits.files || bytes > limits.bytes)
          throw Error(limits.message);
      }
    }
  };
  walk(folder);
  return name;
}

/**
 * The files of a .zip or .skill archive (stored or deflated entries), as
 * relative paths. Refuses absolute paths, "..", links and archives past the
 * folder limits.
 */
export function unzipSkill(
  archive: Buffer,
  limits: SkillFolderLimits = {
    files: maxSkillFolderFiles,
    bytes: maxBytes,
    message: "Skills can be up to 500 files and 20 MB.",
  },
  onFile?: (name: string, unixMode: number) => void,
): Map<string, Buffer> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw Error("That file isn't a zip archive.");
  const count = archive.readUInt16LE(eocd + 10);
  let at = archive.readUInt32LE(eocd + 16);
  if (count > limits.files) throw Error(limits.message);
  const files = new Map<string, Buffer>();
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50)
      throw Error("That zip archive is damaged.");
    const method = archive.readUInt16LE(at + 10);
    const packed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extra = archive.readUInt16LE(at + 30);
    const comment = archive.readUInt16LE(at + 32);
    const unixMode = archive.readUInt32LE(at + 38) >>> 16;
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (name.endsWith("/")) continue;
    const clean = name.replace(/\\/g, "/");
    if (
      clean.startsWith("/") ||
      /^[a-z]:/i.test(clean) ||
      clean.split("/").some((part) => part === ".." || part === "")
    )
      throw Error("That archive has a file outside its folder.");
    if ((unixMode & 0o170000) === 0o120000)
      throw Error("Skill folders can't contain links.");
    if (clean.split("/").some((part) => part === "__MACOSX")) continue;
    bytes += size;
    if (bytes > limits.bytes) throw Error(limits.message);
    const start =
      local +
      30 +
      archive.readUInt16LE(local + 26) +
      archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + packed);
    const content =
      method === 0
        ? Buffer.from(data)
        : method === 8
          ? zlib.inflateRawSync(data, {
              maxOutputLength: Math.max(1, Math.min(size, limits.bytes)),
            })
          : undefined;
    if (!content)
      throw Error("That archive uses a compression Claudex can't read.");
    if (content.length !== size) throw Error("That zip archive is damaged.");
    files.set(clean, content);
    onFile?.(clean, unixMode);
  }
  return files;
}

/**
 * Installs one uploaded file (.md, or a .zip / .skill archive) into the
 * skills folder and answers the skill's name. A name already installed is
 * refused with `skillExistsMessage`, unless `replace` swaps it for the new
 * one (the old folder stays in place until the new one is complete).
 */
export function skillFileContents(
  file: { name: string; data: Buffer },
  limits?: SkillFolderLimits,
): Map<string, Buffer> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".md")) return new Map([["SKILL.md", file.data]]);
  if (lower.endsWith(".zip") || lower.endsWith(".skill"))
    return skillArchiveRoot(unzipSkill(file.data, limits));
  throw Error(`${file.name}: choose a .md, .zip or .skill file.`);
}

/** A submission-time snapshot, not a version token from when the editor opened. */
export function skillReplacementSnapshot(folder: string) {
  const hash = createHash("sha256");
  const files = new Map<string, { data: Buffer; mode: number }>();
  let bytes = 0;
  const walk = (current: string, relative: string) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw Error("Skill folders can't contain links or special files.");
    hash.update(JSON.stringify([relative, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name), relative ? `${relative}/${name}` : name);
    } else {
      bytes += stat.size;
      if (files.size >= maxSkillFolderFiles || bytes > maxBytes) throw Error("Skill folders can be up to 500 files and 20 MB.");
      const data = fs.readFileSync(current);
      hash.update(data);
      files.set(relative, { data, mode: stat.mode & 0o777 });
    }
  };
  walk(folder, "");
  return { fingerprint: hash.digest("hex"), files };
}

export function installSkillFile(
  skillsFolder: string,
  file: { name: string; data: Buffer },
  replace = false,
  limits?: SkillFolderLimits,
  expected?: { name: string; fingerprint: string },
): string {
  const contents = skillFileContents(file, limits);
  const name = skillName(contents.get("SKILL.md")!.toString("utf8"));
  if (!name || !(expected ? name === expected.name && isSavedSkillName(name) : /^[a-z][a-z0-9-]{0,63}$/.test(name)))
    throw Error(
      `${file.name}: the skill needs a name of lowercase letters, numbers and hyphens in its YAML.`,
    );
  installSkillContents(skillsFolder, { name, contents, replace, limits, expected });
  return name;
}

export function installSkillContents(
  skillsFolder: string,
  { name, contents, replace, limits, expected, carryForward }: {
    name: string;
    contents: Map<string, Buffer>;
    replace: boolean;
    limits?: SkillFolderLimits;
    expected?: { name: string; fingerprint: string };
    carryForward?: boolean;
  },
) {
  const target = path.join(skillsFolder, name);
  const original = expected ? skillReplacementSnapshot(target) : undefined;
  if (expected && (!replace || original?.fingerprint !== expected.fingerprint))
    throw Error("The skill changed while saving. Reopen it before trying again.");
  for (const [relative, saved] of original?.files ?? []) {
    if (!contents.has(relative) && relative.split("/").some((part) => part.startsWith(".")))
      contents.set(relative, saved.data);
  }
  scanSkillContents(contents, name);
  const taken = fs.existsSync(target);
  if (taken && !replace) throw Error(skillExistsMessage(name));
  if (taken && !fs.lstatSync(target).isDirectory())
    throw Error("That skill isn't in your own files.");
  fs.mkdirSync(skillsFolder, { recursive: true });
  const staging = fs.mkdtempSync(path.join(skillsFolder, ".upload-"));
  try {
    if (carryForward) copyFolderFiles(target, staging, limits);
    for (const [relative, content] of contents) {
      const full = path.join(staging, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, { mode: original?.files.get(relative)?.mode ?? 0o600 });
    }
    checkSkillFolder(staging, limits, !!expected);
    if (expected && skillReplacementSnapshot(target).fingerprint !== expected.fingerprint)
      throw Error("The skill changed while saving. Reopen it before trying again.");
    if (taken) {
      const old = path.join(
        skillsFolder,
        `.replaced-${path.basename(staging)}`,
      );
      fs.renameSync(target, old);
      try {
        fs.renameSync(staging, target);
      } catch (error) {
        try { fs.renameSync(old, target); }
        catch (restoreError) {
          throw new AggregateError([error, restoreError], `The save failed and restoration could not be confirmed. The original files are retained in ${path.basename(old)}.`);
        }
        throw error;
      }
      try { fs.rmSync(old, { recursive: true, force: true }); }
      catch (error) {
        throw new Error(`The new version was saved, but removing its backup ${path.basename(old)} failed. Reopen the skill before trying again.`, { cause: error });
      }
    } else fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Where the skill sits in an archive's files: the folder holding SKILL.md,
 * at the top or one folder down. Returns the files relative to it.
 */
export function skillArchiveRoot(files: Map<string, Buffer>) {
  const roots = [...files.keys()]
    .filter((file) => /(^|\/)SKILL\.md$/.test(file))
    .map((file) => file.slice(0, -"SKILL.md".length))
    .filter((root) => root.split("/").length <= 2);
  if (roots.length !== 1)
    throw Error("The archive needs one SKILL.md at its top or in one folder.");
  const root = roots[0];
  return new Map(
    [...files]
      .filter(([file]) => file.startsWith(root))
      .map(([file, data]) => [file.slice(root.length), data]),
  );
}

/**
 * Copies a folder's files into an empty target, refusing links and stopping
 * past `limits` (a skill: 500 files and 20 MB). The source is read, never
 * changed.
 */
export function copyFolderFiles(
  source: string,
  target: string,
  limits: { files: number; bytes: number; message: string } = {
    files: maxSkillFolderFiles,
    bytes: maxBytes,
    message: "Skill folders can be up to 500 files and 20 MB.",
  },
) {
  let files = 0;
  let bytes = 0;
  const walk = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const full = path.join(from, entry.name);
      const copy = path.join(to, entry.name);
      if (entry.isSymbolicLink())
        throw Error("Folders with links can't be copied.");
      if (entry.isDirectory()) walk(full, copy);
      else if (entry.isFile()) {
        files++;
        bytes += fs.statSync(full).size;
        if (files > limits.files || bytes > limits.bytes)
          throw Error(limits.message);
        fs.copyFileSync(full, copy);
      }
    }
  };
  walk(source, target);
}

/** SKILL.md with its front matter's `name:` set to `name` (added when missing). */
export function withSkillName(markdown: string, name: string): string {
  const line = `name: ${JSON.stringify(name)}`;
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!front) return `---\n${line}\n---\n\n${markdown}`;
  const lines = front[1].split(/\r?\n/);
  const at = lines.findIndex((value) => /^name\s*:/.test(value));
  if (at >= 0) lines[at] = line;
  else lines.unshift(line);
  return `---\n${lines.join("\n")}\n---${markdown.slice(front[0].length)}`;
}

/**
 * Duplicate skill (live claude.ai bundle, 2026-10-12): copies a skill's
 * folder into the skills folder under a new name and writes that name into
 * the copy's SKILL.md. A name that is taken is refused (`skillNameTaken`);
 * the copy appears whole or not at all.
 */
export function duplicateSkillFolder(
  source: string,
  skillsFolder: string,
  name: string,
  displayName?: string,
) {
  if (!isSavedSkillName(name))
    throw Error(
      "Names can only contain lowercase letters, numbers, and hyphens.",
    );
  const target = path.join(skillsFolder, name);
  if (fs.existsSync(target)) throw Error(skillNameTaken);
  if (!fs.existsSync(path.join(source, "SKILL.md")))
    throw Error("The folder needs a SKILL.md file.");
  fs.mkdirSync(skillsFolder, { recursive: true });
  const staging = fs.mkdtempSync(path.join(skillsFolder, ".duplicate-"));
  try {
    copyFolderFiles(source, staging);
    const manifest = path.join(staging, "SKILL.md");
    fs.writeFileSync(
      manifest,
      withSkillName(fs.readFileSync(manifest, "utf8"), name),
      { mode: 0o600 },
    );
    if (displayName !== undefined) writeSkillDisplayName(staging, displayName);
    checkSkillFolder(staging, undefined, true);
    if (fs.existsSync(target)) throw Error(skillNameTaken);
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

/**
 * Rename skill (live claude.ai bundle, 2026-10-12), for a skill of the
 * person's own: its folder takes the new name and its SKILL.md says it.
 * Answers the new folder.
 */
export function renameSkillFolder(
  folder: string,
  skillsFolder: string,
  name: string,
  displayName?: string,
) {
  if (!isSavedSkillName(name))
    throw Error(
      "Names can only contain lowercase letters, numbers, and hyphens.",
    );
  const target = path.join(skillsFolder, name);
  const sameFolder = path.resolve(target) === path.resolve(folder);
  if (
    sameFolder &&
    (displayName === undefined ||
      displayName === name ||
      displayName === skillDisplayName(folder))
  )
    throw Error(renameSameName);
  if (!sameFolder && fs.existsSync(target)) throw Error(skillNameTaken);
  // Prepare only the metadata. Companion files retain their bytes, modes and
  // timestamps, and rename does not acquire the upload/copy size limits.
  const manifest = path.join(folder, "SKILL.md");
  if (!fs.lstatSync(manifest).isFile())
    throw Error("Skill metadata can't contain links.");
  const before = fs.readFileSync(manifest, "utf8");
  const drafts: { relative: string; text: string }[] = [];
  if (!sameFolder || skillName(before) !== name)
    drafts.push({ relative: "SKILL.md", text: withSkillName(before, name) });
  if (displayName !== undefined) {
    const { document } = skillDisplayDocument(folder);
    document.setIn(["interface", "display_name"], displayName);
    drafts.push({ relative: "agents/openai.yaml", text: document.toString() });
  }
  const staging = fs.mkdtempSync(path.join(skillsFolder, ".rename-"));
  const changes = drafts.map((draft, index) => ({
    ...draft,
    next: path.join(staging, `${index}.next`),
    backup: path.join(staging, `${index}.before`),
    backedUp: false,
    installed: false,
  }));
  let moved = false;
  let createdAgents = false;
  let cleanup = true;
  try {
    for (const change of changes)
      fs.writeFileSync(change.next, change.text, { mode: 0o600 });
    if (!sameFolder) {
      if (fs.existsSync(target)) throw Error(skillNameTaken);
      fs.renameSync(folder, target);
      moved = true;
    }
    try {
      for (const change of changes) {
        const file = path.join(target, change.relative);
        if (
          change.relative.startsWith("agents/") &&
          !fs.existsSync(path.dirname(file))
        ) {
          fs.mkdirSync(path.dirname(file));
          createdAgents = true;
        }
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (stat) {
          if (!stat.isFile())
            throw Error("Skill metadata can't contain links.");
          fs.renameSync(file, change.backup);
          change.backedUp = true;
        }
        fs.renameSync(change.next, file);
        change.installed = true;
      }
    } catch (error) {
      try {
        for (const change of [...changes].reverse()) {
          const file = path.join(target, change.relative);
          if (change.installed) fs.unlinkSync(file);
          if (change.backedUp) fs.renameSync(change.backup, file);
        }
        if (createdAgents) fs.rmdirSync(path.join(target, "agents"));
        if (moved) fs.renameSync(target, folder);
      } catch {
        cleanup = false; // Retain original metadata if restoration itself fails.
        throw Error(
          "The rename could not be restored completely. Original metadata was retained; inspect the skill before retrying.",
        );
      }
      throw error;
    }
  } finally {
    if (cleanup) fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

function skillDisplayDocument(folder: string) {
  const agents = path.join(folder, "agents");
  const file = path.join(agents, "openai.yaml");
  const agentStat = fs.lstatSync(agents, { throwIfNoEntry: false });
  const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    (agentStat && !agentStat.isDirectory()) ||
    (fileStat && !fileStat.isFile())
  )
    throw Error("Skill metadata can't contain links.");
  const document = fileStat
    ? parseDocument(fs.readFileSync(file, "utf8"))
    : new Document({});
  if (document.errors.length || !isMap(document.contents))
    throw Error("The skill's agents/openai.yaml must be a valid mapping.");
  const metadata = document.get("interface", true);
  if (metadata !== undefined && !isMap(metadata))
    throw Error("The skill's interface metadata must be a mapping.");
  return { agents, file, document };
}

function skillDisplayName(folder: string): unknown {
  return skillDisplayDocument(folder).document.getIn([
    "interface",
    "display_name",
  ]);
}

function writeSkillDisplayName(folder: string, displayName: string) {
  const { agents, file, document } = skillDisplayDocument(folder);
  document.setIn(["interface", "display_name"], displayName);
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(file, document.toString(), { mode: 0o600 });
}

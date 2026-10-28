import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GeneratedImage } from "../../shared/artifacts-api";

const digestPattern = /^[0-9a-f]{64}$/;
export const maxBlobBytes = 16 * 1024 * 1024;
export const maxGeneratedImageBytes = 10 * 1024 * 1024;

/** The image type the bytes start with: PNG, JPEG or WebP; undefined otherwise. */
export function imageType(
  bytes: Uint8Array,
): GeneratedImage["mime"] | undefined {
  const starts = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return undefined;
}
/** The profile folder that holds the snapshots (counted in Settings → storage). */
export const generatedFilesFolder = "generated-files";
/** Snapshots written this recently are never collected (a turn may still be saving). */
const collectGraceMs = 10 * 60 * 1000;

/**
 * Content-addressed copies of generated binary files (images, PDFs, Office
 * documents) under the account profile. Cards and previews read these
 * snapshots, never the mutable workspace path.
 */
export class GeneratedBlobs {
  private folder: string;
  /** Where Codex's image tool saves its pictures (`$CODEX_HOME/generated_images`). */
  readonly imageFolder: string;
  constructor(private readonly root: string) {
    this.folder = path.join(root, generatedFilesFolder);
    this.imageFolder = path.join(root, "codex-home", "generated_images");
  }
  /**
   * The image folder a saved picture belongs to: the profile's, or an
   * isolated space's (`spaces/<id>/codex-home/generated_images`, the cloud
   * runner, docs/cloud-sync.md); undefined for anywhere else.
   */
  private imageFolderOf(savedPath: string): string | undefined {
    const resolved = path.resolve(savedPath);
    if (resolved.startsWith(this.imageFolder + path.sep))
      return this.imageFolder;
    const spaces = path.join(this.root, "spaces") + path.sep;
    if (!resolved.startsWith(spaces)) return undefined;
    const [space] = resolved.slice(spaces.length).split(path.sep);
    if (!space || !/^[A-Za-z0-9_-]{1,80}$/.test(space)) return undefined;
    const folder = path.join(spaces, space, "codex-home", "generated_images");
    return resolved.startsWith(folder + path.sep) ? folder : undefined;
  }
  /**
   * Snapshots a picture the image tool saved, so the transcript's thumbnail and
   * the file viewer read it by digest like other generated files. Only regular
   * PNG, JPEG or WebP files up to 10 MB inside the image folder are taken,
   * whatever path the conversation recorded; null when the file is gone.
   */
  snapshotImage(savedPath: string): GeneratedImage | null {
    // Checked by name first, so paths elsewhere are never looked at.
    const imageFolder = path.isAbsolute(savedPath)
      ? this.imageFolderOf(savedPath)
      : undefined;
    if (!imageFolder)
      throw Error("This image is not in the generated images folder.");
    let folder: string, file: string;
    try {
      folder = fs.realpathSync(imageFolder);
      file = fs.realpathSync(savedPath);
    } catch {
      return null;
    }
    if (!file.startsWith(folder + path.sep))
      throw Error("This image is not in the generated images folder.");
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    if (stat.size > maxGeneratedImageBytes)
      throw Error("This image is too large to preview.");
    const bytes = fs.readFileSync(file);
    const mime = imageType(bytes);
    if (!mime) throw Error("This image can't be previewed.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    this.put(digest, bytes);
    return { digest, mime, bytes: bytes.byteLength };
  }
  /**
   * Snapshots a picture the agent viewed (an `imageView` item's path) when it
   * is inside one of `folders` (the conversation's working folders), for the
   * transcript's thumbnail. Same size and type limits as above.
   */
  snapshotViewedImage(file: string, folders: string[]): GeneratedImage | null {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      return null;
    }
    const inside = folders.some((folder) => {
      try {
        return real.startsWith(fs.realpathSync(folder) + path.sep);
      } catch {
        return false;
      }
    });
    if (!inside) throw Error("This image is outside the task's folders.");
    const stat = fs.statSync(real, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    if (stat.size > maxGeneratedImageBytes)
      throw Error("This image is too large to preview.");
    const bytes = fs.readFileSync(real);
    const mime = imageType(bytes);
    if (!mime) throw Error("This image can't be previewed.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    this.put(digest, bytes);
    return { digest, mime, bytes: bytes.byteLength };
  }
  private file(digest: string) {
    if (!digestPattern.test(digest)) throw Error("Invalid file snapshot.");
    return path.join(this.folder, digest);
  }
  put(digest: string, bytes: Uint8Array) {
    const file = this.file(digest);
    if (fs.existsSync(file)) {
      // In use again: keep it out of the next collection.
      const now = new Date();
      fs.utimesSync(file, now, now);
      return;
    }
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  /** The snapshot's file, after checking it is still a regular, bounded file. */
  path(digest: string) {
    const file = this.file(digest);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > maxBlobBytes)
      throw Error("This file snapshot is no longer available.");
    return file;
  }
  read(digest: string): Buffer {
    return fs.readFileSync(this.path(digest));
  }
}

/**
 * Removes snapshots no saved conversation refers to (a deleted chat's
 * files) and interrupted writes, except ones touched in the last minutes.
 * Returns how many files and bytes were removed.
 */
export function collectGeneratedSnapshots(
  root: string,
  referenced: ReadonlySet<string>,
  now = Date.now(),
): { files: number; bytes: number } {
  const folder = path.join(root, generatedFilesFolder);
  const removed = { files: 0, bytes: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return removed;
  }
  for (const name of names) {
    const leftover = /^[0-9a-f]{64}\.\d+\.tmp$/.test(name);
    if (!leftover && (!digestPattern.test(name) || referenced.has(name)))
      continue;
    const file = path.join(folder, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.mtimeMs > now - collectGraceMs) continue;
    fs.unlinkSync(file);
    removed.files++;
    removed.bytes += stat.size;
  }
  return removed;
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareDesktopExtensionEntry } from "./extension-lifecycle";
import { unzipSkill } from "../skills/skill-folder";

export const developerModeFolderBlocked =
  "Your organization has turned off Developer Mode, so extensions can’t be installed from a folder.";

export const extensionOpenFailed =
  "Couldn’t open the extension file. Try again.";

export function unpackExtensionArchive(data: Buffer, root: string) {
  const source = fs.mkdtempSync(path.join(root, "extension-import-"));
  try {
    const files = unzipSkill(data, {
      files: 10000,
      bytes: 100 * 1024 * 1024,
      message: extensionOpenFailed,
    });
    let bytes = 0;
    for (const [relative, content] of files) {
      bytes += content.length;
      if (bytes > 100 * 1024 * 1024) throw new Error(extensionOpenFailed);
      const destination = path.join(source, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, { mode: 0o600 });
    }
    unpackedExtensionEntry(source);
    return source;
  } catch {
    fs.rmSync(source, { recursive: true, force: true });
    throw new Error(extensionOpenFailed);
  }
}

export function unpackedExtensionEntry(folder: string) {
  return prepareDesktopExtensionEntry(folder);
}

export function installUnpackedExtension(options: {
  source: string;
  root: string;
  allowed: () => boolean;
  current: Record<string, unknown>;
  update: (servers: Record<string, unknown>) => void;
}) {
  if (!options.allowed()) throw new Error(developerModeFolderBlocked);
  const source = fs.realpathSync(options.source);
  unpackedExtensionEntry(source);
  let count = 0;
  let bytes = 0;
  const inspect = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Couldn’t install the extension. Try again.");
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) inspect(full);
      else {
        count++;
        bytes += fs.statSync(full).size;
        if (count > 10000 || bytes > 100 * 1024 * 1024)
          throw new Error("Couldn’t install the extension. Try again.");
      }
    }
  };
  inspect(source);
  const target = path.join(options.root, "desktop-extensions", randomUUID());
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: false });
    inspect(target);
    const { name, entry } = unpackedExtensionEntry(target);
    if (Object.hasOwn(options.current, name))
      throw new Error("Couldn’t install the extension. Try again.");
    if (!options.allowed()) throw new Error(developerModeFolderBlocked);
    options.update({ ...options.current, [name]: entry });
    return name;
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

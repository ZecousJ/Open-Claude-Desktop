import fs from "node:fs/promises";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import type {
  UploadedFilesPage,
  UploadedFileItem,
} from "../../shared/privacy-data-api";

/** Read metadata of app-managed copies only. No file bytes, links or originals
 * are opened; the caller supplies its captured, owned Store, never UI paths. */
export async function readOwnedUploadInventory(
  root: string,
  conversations: readonly Conversation[],
): Promise<Omit<UploadedFilesPage, "nextCursor">> {
  const result: Omit<UploadedFilesPage, "nextCursor"> = {
    items: [],
    complete: false,
    scope: "managed-attachments",
    skipped: 0,
    truncated: false,
  };
  const requestedRoot = path.resolve(root);
  const realRoot = await fs.realpath(root);
  const folder = path.join(realRoot, "attachments");
  let names: string[];
  try {
    const stat = await fs.lstat(folder);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(folder)) !== folder
    )
      throw Error("The attachment storage boundary changed. Try again.");
    names = (await fs.readdir(folder)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  const locations = new Map<string, UploadedFileItem["locations"]>();
  const surfaces = new Map<string, UploadedFileItem["surface"]>();
  for (const conversation of conversations) {
    if (conversation.incognito) continue;
    const turns = [
      conversation.turns,
      ...(conversation.savedBranches ?? []).map((branch) => branch.turns),
    ].flat();
    for (const turn of turns)
      for (const attachment of turn.attachments ?? []) {
        const storedPath = path.resolve(attachment.path);
        const key = storedPath.startsWith(requestedRoot + path.sep)
          ? path.join(realRoot, path.relative(requestedRoot, storedPath))
          : storedPath;
        if (!key.startsWith(folder + path.sep)) continue;
        if (!surfaces.has(key))
          surfaces.set(key, conversation.mode === "code" ? "code" : "chat");
        const existing = locations.get(key) ?? [];
        if (
          !existing.some((item) => item.conversationId === conversation.id) &&
          existing.length < 1000
        )
          existing.push({
            conversationId: conversation.id,
            title: conversation.title,
          });
        locations.set(key, existing);
      }
  }
  // A bounded snapshot says when it stopped; it never represents the remainder as empty.
  for (const [index, name] of names.entries()) {
    if (result.items.length >= 1000 || index >= 2000) {
      result.truncated = true;
      break;
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        name,
      )
    ) {
      result.skipped++;
      continue;
    }
    const directory = path.join(folder, name);
    const stat = await fs.lstat(directory).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      !stat?.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(directory)) !== directory
    ) {
      result.skipped++;
      continue;
    }
    const members = await fs.readdir(directory);
    for (const member of members) {
      if (result.items.length >= 1000) {
        result.truncated = true;
        break;
      }
      const file = path.join(directory, member);
      const info = await fs.lstat(file).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (
        !info?.isFile() ||
        info.isSymbolicLink() ||
        (await fs.realpath(file)) !== file ||
        (await fs.realpath(directory)) !== directory ||
        (await fs.realpath(folder)) !== folder
      ) {
        result.skipped++;
        continue;
      }
      result.items.push({
        id: `${name}/${member}`,
        name: member,
        bytes: info.size,
        // The copy is written once, when the file is attached.
        uploadedAt: Math.round(info.birthtimeMs || info.mtimeMs),
        surface: surfaces.get(file) ?? "chat",
        locations: locations.get(file) ?? [],
        storage: "managed-attachment",
      });
    }
  }
  return result;
}

/** Deletes one app-managed copy named by its inventory id ("<uuid>/<name>").
 * Only a plain file inside the account's attachments folder qualifies, and
 * not while a response that may still read it is running. */
export async function deleteOwnedUpload(
  root: string,
  conversations: readonly Conversation[],
  id: string,
): Promise<void> {
  const gone = () => Error("This file was already deleted. Refresh the list.");
  const [name, member, ...rest] = id.split("/");
  if (
    rest.length ||
    !name ||
    !member ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      name,
    ) ||
    member !== path.basename(member) ||
    member === "." ||
    member === ".." ||
    member.includes("\\")
  )
    throw gone();
  const requestedRoot = path.resolve(root);
  const realRoot = await fs.realpath(root);
  const folder = path.join(realRoot, "attachments");
  const directory = path.join(folder, name);
  const file = path.join(directory, member);
  const info = await fs.lstat(file).catch(() => null);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    (await fs.realpath(folder)) !== folder ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.realpath(file)) !== file
  )
    throw gone();
  const inUse = conversations.some((conversation) =>
    conversation.turns.some(
      (turn) =>
        turn.status === "inProgress" &&
        (turn.attachments ?? []).some((attachment) => {
          const stored = path.resolve(attachment.path);
          const key = stored.startsWith(requestedRoot + path.sep)
            ? path.join(realRoot, path.relative(requestedRoot, stored))
            : stored;
          return key === file;
        }),
    ),
  );
  if (inUse)
    throw Error(
      "This file is being used by a response. Try again when it finishes.",
    );
  await fs.unlink(file);
  await fs.rmdir(directory).catch(() => {});
}

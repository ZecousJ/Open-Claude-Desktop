import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Attachment } from "../../shared/types";

export const incognitoDraftId = z.string().uuid();
export const ordinaryAttachmentsUsedInIncognito = new WeakSet<Attachment>();

export function privateAttachmentDraft(root: string, attachment: Attachment) {
  const relative = path.relative(incognitoUploadFolder(root), attachment.path);
  if (path.isAbsolute(relative)) return undefined;
  return incognitoDraftId.safeParse(relative.split(path.sep)[0]).data;
}

export function incognitoUploadFolder(root: string, draftId?: string) {
  const folder = path.join(root, "attachments", ".incognito");
  return draftId ? path.join(folder, incognitoDraftId.parse(draftId)) : folder;
}

export function discardIncognitoUploads(
  root: string,
  selected: Map<string, Attachment>,
  draftId?: string,
) {
  const folder = incognitoUploadFolder(root, draftId);
  if (!incognitoDirectoriesAreSafe(root)) return;
  fs.rmSync(folder, { recursive: true, force: true });
  for (const [id, attachment] of selected) {
    const relative = path.relative(folder, attachment.path);
    if (relative && !path.isAbsolute(relative) && !relative.startsWith(".." + path.sep) && relative !== "..")
      selected.delete(id);
  }
}

function incognitoDirectoriesAreSafe(root: string, draftId?: string) {
  const directories = [path.join(root, "attachments"), incognitoUploadFolder(root)];
  if (draftId) directories.push(incognitoUploadFolder(root, draftId));
  for (const directory of directories) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("The temporary attachment directory is not available.");
  }
  return true;
}

export function prepareIncognitoUploadFolder(root: string, draftId: string) {
  incognitoDirectoriesAreSafe(root, draftId);
  return incognitoUploadFolder(root, draftId);
}

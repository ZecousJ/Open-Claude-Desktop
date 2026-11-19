import fs from "node:fs";
import path from "node:path";
import type { Attachment, Conversation } from "../../shared/types";
import { isSteeredMessage } from "../../shared/agent-api";
import { fileReadServiceStage } from "../official-ui/api/file-read-diagnostics";

/** Resolve only one unambiguous attachment from this profile's conversation. */
export function readOwnedTurnAttachment(
  store: { root: string; conversation(id: string): Conversation },
  conversationId: string,
  attachmentId: string,
): { attachment: Attachment; data: Uint8Array } | null {
  fileReadServiceStage("local-conversation");
  const conversation = store.conversation(conversationId);
  const matches = [
    ...conversation.turns,
    ...(conversation.savedBranches ?? []).flatMap((branch) => branch.turns),
  ]
    .flatMap((turn) => [
      ...(turn.attachments ?? []),
      ...(turn.items ?? []).flatMap((item) =>
        isSteeredMessage(item) ? item.attachments ?? [] : [],
      ),
    ])
    .filter((attachment) => attachment.id === attachmentId);
  return readOwnedAttachment(store.root, matches);
}

export function readOwnedAttachment(
  storeRoot: string,
  matches: readonly Attachment[],
): { attachment: Attachment; data: Uint8Array } | null {
  const found = matches[0];
  if (
    !found?.path ||
    matches.some(
      (item) =>
        item.path !== found.path ||
        item.name !== found.name ||
        item.kind !== found.kind ||
        item.size !== found.size,
    )
  )
    return null;
  fileReadServiceStage("local-root-realpath");
  const root = fs.realpathSync(path.join(storeRoot, "attachments"));
  let file: string;
  try {
    fileReadServiceStage("local-file-realpath");
    file = fs.realpathSync(found.path);
  } catch {
    return null;
  }
  if (!file.startsWith(root + path.sep)) return null;
  let handle: number | undefined;
  try {
    handle = fs.openSync(
      file,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    fileReadServiceStage("local-file-stat");
    const before = fs.fstatSync(handle);
    if (
      !before.isFile() ||
      before.size > 32 * 1024 * 1024 ||
      before.size !== found.size
    )
      return null;
    fileReadServiceStage("local-read");
    const data = new Uint8Array(fs.readFileSync(handle));
    const after = fs.fstatSync(handle);
    if (
      data.byteLength !== found.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      return null;
    return { attachment: found, data };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

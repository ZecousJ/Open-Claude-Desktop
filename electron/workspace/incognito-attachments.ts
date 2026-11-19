import fs from "node:fs";
import path from "node:path";
import type { Attachment, Conversation } from "../../shared/types";
import { conversationAttachments } from "./storage-usage";
import { ordinaryAttachmentsUsedInIncognito } from "./incognito-upload";

/** Remove only managed upload copies used exclusively by the discarded chat. */
export function discardIncognitoAttachments(
  root: string,
  conversation: Conversation,
  conversations: readonly Conversation[],
  selected: Map<string, Attachment>,
): void {
  const stillUsed = new Set(
    conversations
      .filter((other) => other !== conversation)
      .flatMap((other) => conversationAttachments(root, other)),
  );
  const folder = path.resolve(root, "attachments");
  for (const attachment of selected.values()) {
    if (ordinaryAttachmentsUsedInIncognito.has(attachment))
      stillUsed.add(path.relative(folder, attachment.path).split(path.sep)[0]);
  }
  for (const name of conversationAttachments(root, conversation)) {
    if (stillUsed.has(name)) continue;
    const target = path.join(folder, name);
    // Keep this cleanup synchronous: another window cannot add a reference
    // between the shared-reference check and removing its managed copy.
    fs.rmSync(target, { recursive: true, force: true });
    for (const [id, attachment] of selected) {
      const relative = path.relative(target, path.resolve(attachment.path));
      if (
        !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`)
      )
        selected.delete(id);
    }
  }
}

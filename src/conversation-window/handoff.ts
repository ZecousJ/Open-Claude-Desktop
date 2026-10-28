import type { WindowHandoff } from "../../shared/windows-api";
import type { Attachment } from "../../shared/types";
import { formatText } from "../i18n";

/** The longest draft the main process takes in a handoff (electron/ipc/windows.ts). */
export const handoffTextLimit = 200000;
/** The most attachments a handoff carries (electron/ipc/windows.ts). */
export const handoffAttachmentLimit = 12;

/**
 * The composer draft a window hands to the window that shows the
 * conversation next (Return to the main window). Empty selections are left
 * out, as the main process rejects empty ids; a draft with nothing in it is
 * no handoff at all.
 */
export function draftHandoff(draft: {
  text: string;
  attachments: Pick<Attachment, "id">[];
  providerId?: string;
  model?: string;
}): WindowHandoff | undefined {
  const attachmentIds = draft.attachments.map((a) => a.id);
  if (!draft.text && !attachmentIds.length) return undefined;
  if (draft.text.length > handoffTextLimit)
    throw new Error(
      "This draft is too long to move. Shorten it or copy it first.",
    );
  if (attachmentIds.length > handoffAttachmentLimit)
    throw new Error(
      formatText(
        "Only {count} attachments can move with a draft. Remove some first.",
        { count: handoffAttachmentLimit },
      ),
    );
  return {
    text: draft.text,
    attachmentIds,
    ...(draft.providerId ? { providerId: draft.providerId } : {}),
    ...(draft.model ? { model: draft.model } : {}),
  };
}

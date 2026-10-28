import type { Attachment, Mode } from "../../shared/types";
import { addTerminalExcerpt } from "./attachment-input";
import { attachmentLimitNotice, maxAttachmentsFor } from "./attachment-limits";

/** The composer's draft, as far as adding an excerpt touches it. */
export interface ExcerptDraft {
  mode: Mode;
  attachments: Attachment[];
  setAttachments: (update: (current: Attachment[]) => Attachment[]) => void;
  notify: (message: string) => void;
  /** Whether the draft still belongs to the conversation the terminal is in. */
  stillOpen: () => boolean;
  focus: () => void;
}

/**
 * Attach selection as context: the selected terminal text joins the draft of
 * the session the terminal belongs to as an Excerpt card named after the
 * terminal tab. It counts toward the message's attachment limit, as the
 * original's snippets do; at the limit a notice says so instead.
 */
export async function attachTerminalSelection(
  draft: ExcerptDraft,
  text: string,
  label: string,
) {
  const limit = maxAttachmentsFor(draft.mode);
  if (draft.attachments.length >= limit)
    return draft.notify(attachmentLimitNotice(limit));
  const added = await addTerminalExcerpt(text, label);
  // Another conversation was opened meanwhile: its draft is not this one.
  if (!draft.stillOpen()) return;
  draft.setAttachments((current) => [...current, added].slice(0, limit));
  draft.focus();
}

/** The longest an excerpt card's name runs. */
const excerptLabelLimit = 60;

/**
 * The name of an excerpt from a message with no tab to name it: the first
 * line with something on it, trimmed, cut to 59 characters and an ellipsis
 * when it runs past 60 (the original's Bg).
 */
export function messageExcerptLabel(text: string) {
  const line = (text.split("\n").find((part) => part.trim()) ?? text).trim();
  return line.length > excerptLabelLimit ? `${line.slice(0, 59)}…` : line;
}

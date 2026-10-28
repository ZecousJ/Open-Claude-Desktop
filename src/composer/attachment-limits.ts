import type { Mode } from "../../shared/types";
import { formatText } from "../i18n";

/**
 * Files one message takes. Code's local sessions take 20 (the original's
 * "Attach up to 20 images in a single message for local sessions", desktop
 * bundle 2.31226.1); Chat and Cowork keep the 12 they always took.
 */
export const maxAttachmentsFor = (mode: Mode) => (mode === "code" ? 20 : 12);

/** The original's sentence for a message that would carry too many. */
export const attachmentLimitNotice = (count: number) =>
  formatText(
    "You can add at most {count} attachments to a message. Please select fewer attachments.",
    { count },
  );

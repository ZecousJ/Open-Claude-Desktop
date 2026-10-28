import {
  preference,
  type SettingsPreferences,
  type TranscriptTextSize,
} from "../../shared/settings-extras";

/**
 * Settings → Claude Code → Appearance → Transcript text size. The choice goes
 * on the document as `data-chat-text-size` (s, m or l; useAppearance), which
 * sizes the transcript's rows, the Code composer's prompt and a Markdown
 * document's column (transcript-text-size.css). A sent prompt, a reply and the
 * queued messages carry `data-text-size` as the original's messages do: "sm"
 * for Small, "lg" for Large and nothing for Medium, so Medium keeps the sizes
 * the transcript was drawn at.
 */
export type MessageTextSize = "sm" | "lg";

const messageSizes: Record<TranscriptTextSize, MessageTextSize | undefined> = {
  s: "sm",
  m: undefined,
  l: "lg",
};

/** The chosen size, Medium until one is chosen. */
export function transcriptTextSize(
  settings: SettingsPreferences | undefined,
): TranscriptTextSize {
  const size = settings ? preference(settings, "transcriptTextSize") : "m";
  return size in messageSizes ? size : "m";
}

/** A message's `data-text-size` for a choice: "sm", "lg" or none. */
export function messageTextSize(
  size: TranscriptTextSize | undefined,
): MessageTextSize | undefined {
  return size ? messageSizes[size] : undefined;
}

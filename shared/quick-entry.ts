/**
 * Quick Entry (Settings ▸ System ▸ Quick Entry keyboard shortcut): the
 * shortcut, pressed anywhere, brings up a small floating composer; what is
 * submitted there starts a new chat in the main window, which comes forward
 * with it. Escape, a click outside or switching away puts it away. Values from
 * the original's quick entry window.
 *
 * The composer is a page of its own (`quick.html`, preload
 * `electron/quick-preload.ts`) whose bridge is `window.quickEntry`.
 */

import type { Attachment } from "./types";
import type { VoiceAPI } from "./voice-api";

export interface QuickEntryImage {
  name: string;
  data: Uint8Array;
}

/** The composer's width; its height follows what is typed. */
export const quickEntryWidth = 606;
/** One line: the 56px row the mark and the field share. */
export const quickEntryMinHeight = 56;
/** The nominal height used to centre the first opening. */
export const quickEntryMaxHeight = 470;
/** How far it keeps from the work area's edges when it grows. */
export const quickEntryEdgeGap = 30;
/** The longest prompt the field takes. */
export const quickEntryMaxLength = 16384;
export const quickEntryPlaceholder = "What can I help you with today?";

/**
 * The prompt a submission sends, or undefined when there is nothing worth
 * sending: as in the original, a prompt needs more than two characters
 * once the spaces around it are gone.
 */
export function quickPrompt(text: string): string | undefined {
  const prompt = text.trim();
  return prompt.length > 2 ? prompt : undefined;
}

/**
 * Where the composer opens: where it was last put away, kept on screen, or
 * centred in the primary work area the first time.
 */
export function quickEntryPosition(
  area: { x: number; y: number; width: number; height: number },
  last?: { x: number; y: number },
  height = quickEntryMinHeight,
) {
  const width = quickEntryWidth;
  const clamp = (value: number, min: number, max: number) =>
    Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
  if (!last)
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - quickEntryMaxHeight) / 2),
    };
  return {
    x: clamp(last.x, area.x, area.x + area.width - width),
    y: clamp(last.y, area.y, area.y + area.height - height),
  };
}

/** The composer's height for its content, within its limits. */
export function quickEntryHeight(content: number, viewportHeight: number) {
  return Math.round(
    Math.min(
      Math.max(quickEntryMinHeight, viewportHeight - 100),
      Math.max(quickEntryMinHeight, content),
    ),
  );
}

/** IPC channels between the composer and the main process. */
export const quickEntryChannels = {
  submit: "quick-entry:submit",
  submitImages: "quick-entry:submit-images",
  dismiss: "quick-entry:dismiss",
  resize: "quick-entry:resize",
  /** Main → composer: it was brought up; clear and focus the field. */
  shown: "quick-entry:shown",
  dictation: "quick-entry:dictation",
  hidden: "quick-entry:hidden",
  voice: "quick-entry:voice",
  ready: "quick-entry:ready",
} as const;

/** What the composer's preload exposes as `window.quickEntry`. */
export interface QuickEntryBridge {
  ready?(): void;
  submit(text: string, images?: QuickEntryImage[]): void | Promise<void>;
  dismiss(): void;
  resize(height: number): void;
  onShown(callback: (viewportHeight?: number) => void): () => void;
  onDictation?(
    callback: (action: "start" | "stop" | "toggle") => void,
  ): () => void;
  onHidden?(callback: () => void): () => void;
  voice?: Pick<
    VoiceAPI,
    | "requestMicrophone"
    | "startDictation"
    | "dictationAudio"
    | "finishDictation"
    | "cancelDictation"
  >;
}

/** The main window's event: start a new chat with this prompt. */
export interface QuickEntryEvent {
  type: "quick-entry";
  text: string;
  attachments?: Attachment[];
}

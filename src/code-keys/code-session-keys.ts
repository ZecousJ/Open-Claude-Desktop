/**
 * The keys a Code session's transcript answers to, from the live Ctrl+O cycles
 * the transcript view on every platform (cycleTranscriptMode, by the physical O
 * key); ⌥⌘↑ / ⌥⌘↓ on macOS and Alt+↑ / Alt+↓ elsewhere jump to the previous and
 * next prompt (jumpPrevPrompt, jumpNextPrompt).
 */
export type CodeSessionKey =
  "cycle-transcript-view" | "jump-previous-prompt" | "jump-next-prompt";

/** The parts of a key press the table reads. */
export interface SessionKeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function codeSessionKey(
  press: SessionKeyPress,
  mac: boolean,
): CodeSessionKey | undefined {
  if (
    press.code === "KeyO" &&
    press.ctrlKey &&
    !press.metaKey &&
    !press.shiftKey &&
    !press.altKey
  )
    return "cycle-transcript-view";
  const jump =
    press.code === "ArrowUp"
      ? "jump-previous-prompt"
      : press.code === "ArrowDown"
        ? "jump-next-prompt"
        : undefined;
  if (
    jump &&
    press.altKey &&
    !press.shiftKey &&
    !press.ctrlKey &&
    press.metaKey === mac
  )
    return jump;
  return undefined;
}

/** A prompt in the transcript and where its bubble is now. */
export interface PromptPlace {
  id: string;
  /** Its place among the transcript's rows. */
  index: number;
  /** The bubble's top edge on screen; null when it is not drawn. */
  top: number | null;
}

/** A prompt is "on screen" this far either side of the landing line. */
const SLACK = 12;

/**
 * Where a jump lands (the bundle's prompt jump): the last prompt above the
 * view going up, the first below it going down. A prompt within 12px of
 * the landing line (the view's top plus the landing offset) is the current
 * one and is skipped. Right after a jump the prompt it landed on is the
 * anchor, so quick presses step one prompt at a time even while the
 * smooth scroll is still moving. Going down from the end there is nowhere
 * to go.
 */
export function promptJumpTarget(
  prompts: readonly PromptPlace[],
  direction: "previous" | "next",
  {
    viewportTop,
    landingOffset,
    atBottom,
    anchor,
    firstOnScreenIndex = -1,
  }: {
    viewportTop: number;
    landingOffset: number;
    atBottom: boolean;
    anchor?: string | null;
    firstOnScreenIndex?: number;
  },
): PromptPlace | null {
  if (anchor) {
    const index = prompts.findIndex((prompt) => prompt.id === anchor);
    if (index >= 0)
      return prompts[direction === "previous" ? index - 1 : index + 1] ?? null;
  }
  if (direction === "next" && atBottom) return null;
  const above = viewportTop - SLACK;
  const below = viewportTop + landingOffset + SLACK;
  let last: PromptPlace | null = null;
  for (const prompt of prompts) {
    const place =
      prompt.top === null
        ? firstOnScreenIndex >= 0 && prompt.index < firstOnScreenIndex
          ? "above"
          : "below"
        : prompt.top < above
          ? "above"
          : prompt.top > below
            ? "below"
            : "current";
    if (place === "above") {
      last = prompt;
      continue;
    }
    if (place !== "current") return direction === "next" ? prompt : last;
  }
  return direction === "previous" ? last : null;
}

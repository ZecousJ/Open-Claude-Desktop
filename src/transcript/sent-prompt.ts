import type { Turn } from "../../shared/types";

/**
 * The text the model got for a prompt, where it differs from the prompt as
 * shown: only then is there a sent prompt to view. Turns sent before 0.0.33
 * kept it always.
 */
export function sentPromptOf(turn: Turn) {
  const sent = turn.rawOriginals;
  if (!sent?.length) return undefined;
  return sent.length === 1 && sent[0] === turn.prompt ? undefined : sent;
}

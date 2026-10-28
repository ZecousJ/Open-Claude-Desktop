/**
 * How the transcript shows the pull request messages of a Code session. Kept
 * apart because the transcript loads with the window while the branch row,
 * which writes and reads those messages, loads with the first Code session.
 */

/** Create PR's message is wrapped in this tag (shared/pull-request.ts writes it). */
const open = "<create-pr-command>";
const close = "</create-pr-command>";

/**
 * A prompt as the transcript shows it: Create PR's message reads as
 * `/create-pr` (`/create-pr --draft`), as the original shows it.
 */
export function displayPrompt(prompt: string) {
  const text = prompt.trim();
  if (
    !text.startsWith(open) ||
    !text.endsWith(close) ||
    text.indexOf(open, open.length) >= 0
  )
    return prompt;
  return text.includes("`gh pr create --draft`") ||
    text.includes("with `draft` true")
    ? "/create-pr --draft"
    : "/create-pr";
}

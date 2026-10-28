import type { ReviewTarget } from "../../shared/composer-api";

/** A branch or commit name the app-server may be given: never an option. */
const refName = /^[\w][\w./@+-]*$/;
const commitName = /^[0-9a-fA-F]{4,64}$/;

/**
 * What the text after `/review` asks Codex to look at:
 * nothing → the uncommitted changes;
 * `base <branch>` → the branch against that base branch;
 * `commit <sha>` → one commit;
 * anything else → those instructions.
 */
export function parseReviewArguments(
  text: string,
): ReviewTarget | { error: string } {
  const value = text.trim();
  if (!value) return { type: "uncommittedChanges" };
  const [word, ...rest] = value.split(/\s+/);
  const argument = rest.join(" ");
  if (word === "base") {
    if (!argument || rest.length > 1 || !refName.test(argument))
      return { error: "Name the branch to compare with: /review base main" };
    return { type: "baseBranch", branch: argument };
  }
  if (word === "commit") {
    if (!commitName.test(argument))
      return { error: "Give the commit to review: /review commit 1a2b3c4" };
    return { type: "commit", sha: argument };
  }
  return { type: "custom", instructions: value };
}

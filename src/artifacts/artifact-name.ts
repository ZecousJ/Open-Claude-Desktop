/**
 * A name typed into an artifact's rename field, as the original keeps it:
 * invisible formatting characters dropped, control characters and blank-looking
 * letters turned into spaces, runs of white space folded into one, the ends
 * trimmed. A name with nothing visible left comes back empty, so the rename is
 * cancelled.
 */
export function cleanArtifactName(value: string) {
  const text = value
    .replace(/[­؜​‎‏‪-‮⁠-⁯﻿]/gu, "")
    .replace(/[\p{Cc}ᅟᅠ⠀ㅤﾠ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[^\p{Cf}\p{Cc}\p{Mn}\p{Me}\s]/u.test(text) ? text : "";
}

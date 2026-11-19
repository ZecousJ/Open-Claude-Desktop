/** The original skill dialogs' typed name and Unicode/NFKC saved-name rules. */
const nameLetter = /[\p{Lu}\p{Ll}\p{Lt}\p{Lm}\p{Lo}\p{Nl}\p{Mn}\p{Mc}\p{Nd}]/u;
const connector = /\p{Pc}/u;

export function skillNamePlan(raw: unknown): {
  name: string;
  displayName: string;
} {
  if (typeof raw !== "string") throw Error("Enter a skill name.");
  const displayName = Array.from(raw, (letter) =>
    [28, 29, 30, 31, 133].includes(letter.codePointAt(0)!) ? " " : letter,
  )
    .join("")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  let slug = "";
  for (const letter of displayName.normalize("NFKC")) {
    for (const normalized of letter.normalize("NFKC")) {
      if (normalized === " " || connector.test(normalized)) slug += "-";
      else if (normalized === "-" || nameLetter.test(normalized))
        slug += normalized;
    }
  }
  const name = slug
    .toLowerCase()
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name) throw Error("Enter a skill name.");
  if ([...name].length > 64 || [...displayName].length > 64)
    throw Error("Skill names can be up to 64 characters.");
  if (
    ["anthropic", "claude"].some((word) => name.includes(word)) ||
    /[<\uFE64\uFF1C].+[>\uFE65\uFF1E]/s.test(displayName)
  )
    throw Error("That name can’t be used. Choose a different one.");
  return { name, displayName };
}

/** A final saved name, not a request to normalize a caller's path. */
export function isSavedSkillName(name: string): boolean {
  try {
    return skillNamePlan(name).name === name;
  } catch {
    return false;
  }
}

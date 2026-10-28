import type { CustomizeSkill } from "../../shared/collections-api";
import { snapToMentions, type MentionRange } from "./mention";
import { skillMessage } from "./code/code-slash-commands";

/** The draft's atomic skill reference; the real transport remains `$name`. */
export interface SkillToken extends MentionRange {
  name: string;
}
// The existing skills/list → slashSkills → skillMessage protocol accepts
// these names. An unsupported or ambiguous identity cannot be invoked by
// inventing a different path or changing the global installation setting.
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export function callableSkills(skills: readonly CustomizeSkill[]) {
  const enabled = skills.filter(
    (skill) => skill.enabled && skill.path && namePattern.test(skill.name),
  );
  const counts = new Map<string, number>();
  for (const skill of enabled)
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  return enabled
    .filter((skill) => counts.get(skill.name) === 1)
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function validSkillTokens(text: string, input: unknown): SkillToken[] {
  if (!Array.isArray(input)) return [];
  const sorted = input
    .slice(0, 100)
    .filter((token): token is SkillToken =>
      Boolean(
        token &&
        typeof token.name === "string" &&
        namePattern.test(token.name) &&
        Number.isInteger(token.start) &&
        Number.isInteger(token.end) &&
        token.start >= 0 &&
        token.end <= text.length &&
        token.start < token.end &&
        text.slice(token.start, token.end) === `$${token.name}` &&
        (token.start === 0 || /\s/.test(text[token.start - 1]!)) &&
        (token.end === text.length || /\s/.test(text[token.end]!)),
      ),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: SkillToken[] = [];
  for (const { name, start, end } of sorted)
    if (!result.length || start >= result[result.length - 1]!.end)
      result.push({ name, start, end });
  return result;
}
/** Map one actual text edit, dropping metadata if the token itself changed. */
export function editSkillTokens(
  before: string,
  after: string,
  tokens: readonly SkillToken[],
) {
  if (before === after) return validSkillTokens(after, tokens);
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const end = before.length - tail;
  const delta = after.length - before.length;
  return validSkillTokens(
    after,
    tokens.flatMap((token) => {
      if (token.end <= start) return [token];
      if (token.start >= end)
        return [
          { ...token, start: token.start + delta, end: token.end + delta },
        ];
      return [];
    }),
  );
}
export function insertSkillToken(
  text: string,
  tokens: readonly SkillToken[],
  name: string,
  start: number,
  end = start,
) {
  if (!namePattern.test(name)) return undefined;
  const range = snapToMentions(
    Math.max(0, Math.min(start, text.length)),
    Math.max(0, Math.min(end, text.length)),
    tokens,
  );
  const before = text.slice(0, range.start);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const token = skillMessage(name, "");
  const inserted = `${prefix}${token} `;
  const next = before + inserted + text.slice(range.end);
  const delta = inserted.length - (range.end - range.start);
  const kept = tokens.flatMap((value) =>
    value.end <= range.start
      ? [value]
      : value.start >= range.end
        ? [{ ...value, start: value.start + delta, end: value.end + delta }]
        : [],
  );
  return {
    text: next,
    skillTokens: validSkillTokens(next, [
      ...kept,
      {
        name,
        start: range.start + prefix.length,
        end: range.start + prefix.length + token.length,
      },
    ]),
    caret: range.start + inserted.length,
  };
}
/** Queue edit restores the real references together with the prepended text. */
export function prependSkillDraft(
  entry: { text: string; skillTokens?: SkillToken[] },
  current: { text: string; skillTokens?: SkillToken[] },
) {
  const separator = current.text.trim() ? "\n" : "";
  const suffix = separator ? current.text : "";
  const text = entry.text + separator + suffix;
  const shift = entry.text.length + separator.length;
  return {
    text,
    skillTokens: validSkillTokens(text, [
      ...validSkillTokens(entry.text, entry.skillTokens),
      ...(separator
        ? validSkillTokens(current.text, current.skillTokens).map((token) => ({
            ...token,
            start: token.start + shift,
            end: token.end + shift,
          }))
        : []),
    ]),
  };
}

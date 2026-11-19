import { parseSkillReferences, type SkillReference } from "../../../shared/skill-references";

const prefix = "claudex-skill-references-v1:";

export function readOfficialSkillReferences(
  prompt: string,
  context: readonly string[] | undefined,
  allowOtherContext = false,
): SkillReference[] | undefined {
  if (!context?.length) return;
  const lines = allowOtherContext ? context.filter(line => line.startsWith(prefix)) : context;
  if (!lines.length) return;
  if (lines.length > 8) throw Error("Invalid skill selection for this message.");
  const references = lines.flatMap(line => {
    if (!line.startsWith(prefix) || line.length > 4096)
      throw Error("Invalid skill selection for this message.");
    const parsed: unknown = JSON.parse(line.slice(prefix.length));
    if (!Array.isArray(parsed) || !parsed.length)
      throw Error("Invalid skill selection for this message.");
    return parsed;
  });
  return parseSkillReferences(prompt, references);
}

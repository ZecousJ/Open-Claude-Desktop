import { z } from "zod";

const span = {
  name: z.string().min(1).max(256).regex(/^\S+$/u),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
};
const localSkillReferenceSchema = z
  .object({ kind: z.literal("local"), ...span })
  .strict();
const remoteSkillReferenceSchema = z
  .object({
    kind: z.literal("remote"),
    connectorId: z.string().uuid(),
    ...span,
  })
  .strict();

export const skillReferencesSchema = z.array(
  z.discriminatedUnion("kind", [
    localSkillReferenceSchema,
    remoteSkillReferenceSchema,
  ]),
);
export type LocalSkillReference = z.infer<typeof localSkillReferenceSchema>;
export type RemoteSkillReference = z.infer<typeof remoteSkillReferenceSchema>;
export type SkillReference = LocalSkillReference | RemoteSkillReference;
export type SkillInvocationIdentity =
  | { kind: "local"; name: string; path: string }
  | {
      kind: "remote";
      name: string;
      connectorId: string;
      resource: string;
      connection: string;
    };

export function skillReferenceText(reference: SkillReference) {
  return reference.kind === "local"
    ? `/${reference.name}`
    : `/${reference.connectorId}:${reference.name}`;
}

export function parseSkillReferences(
  text: string,
  value: unknown,
): SkillReference[] {
  const references = skillReferencesSchema.parse(value);
  let previousEnd = 0;
  for (const reference of references) {
    if (
      reference.start < previousEnd ||
      reference.end > text.length ||
      text.slice(reference.start, reference.end) !==
        skillReferenceText(reference)
    )
      throw Error(
        "A selected skill no longer matches the message. Select it again.",
      );
    previousEnd = reference.end;
  }
  return references;
}

import path from "node:path";
import { z } from "zod";
import {
  skillReferenceText,
  type LocalSkillReference,
  type SkillInvocationIdentity,
  type SkillReference,
} from "../../shared/skill-references";
import type { Conversation, Turn } from "../../shared/types";

const catalog = z.object({
  data: z.array(
    z.object({
      cwd: z.string().optional(),
      skills: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          enabled: z.boolean().optional(),
        }),
      ),
      errors: z.array(z.unknown()).optional(),
    }),
  ),
});

type RemoteSkillIdentity = Pick<
  Extract<SkillInvocationIdentity, { kind: "remote" }>,
  "resource" | "connection"
>;

export type RemoteConnectorSkillResolver = (input: {
  connectorId: string;
  name: string;
  conversation: Conversation;
  expected?: RemoteSkillIdentity;
  current: () => boolean;
}) => Promise<RemoteSkillIdentity & { text: string; validate: () => void }>;

type SkillInvocationRuntime = {
  cwd: string;
  platform: NodeJS.Platform;
  enabled: () => boolean;
  current: () => boolean;
  list: () => Promise<unknown>;
  remote?: RemoteConnectorSkillResolver;
  conversation: Conversation;
  disabledPaths?: () => ReadonlySet<string>;
  managedImagePaths?: { own: string; mounted: string };
};

const identityKey = (skill: SkillReference | SkillInvocationIdentity) =>
  skill.kind === "local"
    ? `local:${skill.name}`
    : `remote:${skill.connectorId}:${skill.name}`;

export async function prepareSkillInvocation(
  references: SkillReference[],
  expected: SkillInvocationIdentity[],
  runtime: SkillInvocationRuntime,
) {
  const check = () => {
    if (!runtime.current())
      throw Error(
        "The account or skill runtime changed. Reopen the conversation before sending.",
      );
    if (!runtime.enabled())
      throw Error(
        "Skills are unavailable while code execution is off for Chat.",
      );
  };
  const paths = runtime.platform === "win32" ? path.win32 : path.posix;
  const read = async () => {
    check();
    let raw: unknown;
    try {
      raw = await runtime.list();
    } catch {
      check();
      throw Error("The installed skill catalog could not be read.");
    }
    check();
    const parsed = catalog.safeParse(raw);
    if (!parsed.success || !parsed.data.data.length)
      throw Error("The installed skill catalog is incomplete or malformed.");
    if (
      parsed.data.data.some(
        (group) =>
          group.cwd !== undefined &&
          paths.normalize(group.cwd) !== paths.normalize(runtime.cwd),
      )
    )
      throw Error("The installed skill catalog belongs to a different folder.");
    return parsed.data.data;
  };
  const resolveLocal = (
    groups: Awaited<ReturnType<typeof read>>,
    name: string,
    expectedPath?: string,
  ) => {
    let matches = groups.flatMap((group) =>
      group.skills.filter((skill) => skill.name === name),
    );
    const image = runtime.managedImagePaths;
    if (
      image &&
      name === "api-image" &&
      matches.some((skill) => skill.path === image.own)
    )
      matches = matches.filter((skill) => skill.path !== image.mounted);
    const selected = matches[0];
    if (!selected) {
      if (expectedPath)
        throw Error(`The selected skill "${name}" was removed.`);
      if (groups.some((group) => group.errors?.length))
        throw Error(
          `The selected skill "${name}" could not be loaded from the installed catalog.`,
        );
      throw Error(`The selected skill "${name}" is no longer installed.`);
    }
    if (
      !paths.isAbsolute(selected.path) ||
      matches.some((skill) => skill.path !== selected.path)
    )
      throw Error(
        `The selected skill "${name}" is ambiguous. Choose a uniquely named installed skill.`,
      );
    const disabled = runtime.disabledPaths?.();
    if (
      matches.some(
        (skill) => skill.enabled === false || disabled?.has(skill.path),
      )
    )
      throw Error(
        `The selected skill "${name}" is disabled. Enable it before invoking it.`,
      );
    if (expectedPath && selected.path !== expectedPath)
      throw Error(
        `The selected skill "${name}" changed. Select it in a new message.`,
      );
    return selected.path;
  };

  check();
  const skills = new Map(
    references.map((reference) => [identityKey(reference), reference]),
  );
  const previous = new Map(
    expected.map((identity) => [identityKey(identity), identity]),
  );
  const groups = references.some((reference) => reference.kind === "local")
    ? await read()
    : [];
  const identities: SkillInvocationIdentity[] = [];
  const parts: (
    | { type: "skill"; name: string; path: string }
    | { type: "text"; text: string; text_elements: [] }
  )[] = [];
  const remoteChecks: (() => void)[] = [];
  for (const [key, reference] of skills) {
    const old = previous.get(key);
    if (reference.kind === "local") {
      const { name } = reference;
      const skillPath = resolveLocal(
        groups,
        name,
        old?.kind === "local" ? old.path : undefined,
      );
      identities.push({ kind: "local", name, path: skillPath });
      parts.push({ type: "skill", name, path: skillPath });
      continue;
    }
    const { connectorId, name } = reference;
    if (!runtime.remote)
      throw Error(
        "Remote connector skill invocation is not available on this host.",
      );
    const selected = await runtime.remote({
      connectorId,
      name,
      conversation: runtime.conversation,
      current: runtime.current,
      expected:
        old?.kind === "remote"
          ? { resource: old.resource, connection: old.connection }
          : undefined,
    });
    check();
    const { resource, connection, text, validate } = selected;
    if (
      old?.kind === "remote" &&
      (old.resource !== resource || old.connection !== connection)
    )
      throw Error(
        `The selected connector skill "${name}" changed. Select it in a new message.`,
      );
    identities.push({
      kind: "remote",
      connectorId,
      name,
      resource,
      connection,
    });
    remoteChecks.push(validate);
    // Codex also parses $skill in supplemental text. JSON escapes keep connector content inert there.
    const content = JSON.stringify({ name, content: text }).replaceAll(
      "$",
      "\\u0024",
    );
    parts.push({
      type: "text",
      text: `Use this selected connector skill for the user's request.\n${content}`,
      text_elements: [],
    });
  }
  return {
    identities,
    parts,
    validate: async () => {
      if (groups.length) {
        const latest = await read();
        for (const identity of identities)
          if (identity.kind === "local")
            resolveLocal(latest, identity.name, identity.path);
      }
      check();
      for (const validate of remoteChecks) validate();
    },
  };
}

function legacyReference(
  text: string,
  name: string,
): LocalSkillReference | undefined {
  const start = text.length - text.trimStart().length;
  const end = start + name.length + 1;
  if (
    text.slice(start, end) === `/${name}` &&
    (end === text.length || /\s/.test(text[end]))
  )
    return { kind: "local", name, start, end };
}

export function retrySkillSelection(
  turn: Turn,
  text: string,
  selected?: SkillReference[],
) {
  const legacy = turn.skillInvocation;
  if (!turn.skillReferences?.length && legacy) {
    const reference = legacyReference(text, legacy.name);
    return {
      references: selected ?? (reference ? [reference] : []),
      identities: [
        { kind: "local", ...legacy } satisfies SkillInvocationIdentity,
      ],
    };
  }
  const references = turn.skillReferences ?? [];
  const identities = turn.skillInvocations ?? [];
  if (selected !== undefined) return { references: selected, identities };
  if (text === turn.prompt || !references.length)
    return { references, identities };

  const old = turn.prompt;
  const commonLength = Math.min(old.length, text.length);
  let start = 0;
  while (start < commonLength && old[start] === text[start]) start++;
  let tail = 0;
  while (
    tail < commonLength - start &&
    old[old.length - 1 - tail] === text[text.length - 1 - tail]
  )
    tail++;
  const shift = text.length - old.length;
  const moved = references.flatMap((reference) => {
    if (reference.end <= start) return [reference];
    if (reference.start >= old.length - tail)
      return [
        {
          ...reference,
          start: reference.start + shift,
          end: reference.end + shift,
        },
      ];
    if (
      text.includes(
        skillReferenceText(reference),
        Math.max(0, start - skillReferenceText(reference).length + 1),
      )
    )
      throw Error(
        "A selected skill moved while editing the message. Select it again.",
      );
    return [];
  });
  return { references: moved, identities };
}

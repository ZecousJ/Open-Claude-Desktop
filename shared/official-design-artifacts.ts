import { z } from "zod";
import type { Conversation } from "./types";

export const officialDesignType = {
  slug: "bcd2878f-a88d-4094-a616-8e39d8a5fd8a",
  title: "Design",
};
const typesPath = "/api/frame/types";
const createPath = `${typesPath}/${officialDesignType.slug}/create`;
const galleryPath = "/api/frame/frames";
const uuid = z.uuid();
const normalizedUuid = uuid.transform((value) => value.toLowerCase());
const typeFilter = z.union([
  z.literal("none"),
  z
    .string()
    .transform((value) => value.toLowerCase().split(","))
    .pipe(z.array(uuid)),
]);
const typesQuery = z.strictObject({ org: normalizedUuid });
const createQuery = typesQuery.extend({
  idempotency_key: normalizedUuid.optional(),
});
const galleryQuery = typesQuery.extend({
  limit: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .pipe(z.int().max(100)),
  thumb: z.literal("1").optional(),
  rel: z.literal("shared").optional(),
  type: typeFilter.optional(),
});

export const officialDesignCreateMaxBytes = 4096;
export const officialDesignCreateBody = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  target_type_version: z.null(),
  entrypoint: z.string().optional(),
});

function query<T>(schema: z.ZodType<T>, search: string): T | undefined {
  const params = new URLSearchParams(search);
  if (params.size !== new Set(params.keys()).size) return undefined;
  const result = schema.safeParse(Object.fromEntries(params));
  return result.success ? result.data : undefined;
}

export function officialDesignArtifactKind(method: string, path: string) {
  const pathname = path.split("?", 1)[0];
  if (method === "GET" && pathname === typesPath) return "types";
  if (method === "GET" && pathname === galleryPath) return "list";
  if (method === "POST" && pathname === createPath) return "create";
  return undefined;
}

export function officialDesignArtifactTarget(method: string, path: string) {
  const kind = officialDesignArtifactKind(method, path);
  if (!kind) return undefined;
  const i = path.indexOf("?");
  const search = i < 0 ? "" : path.slice(i);
  switch (kind) {
    case "types":
      return { kind, query: query(typesQuery, search) } as const;
    case "list":
      return { kind, query: query(galleryQuery, search) } as const;
    case "create":
      return { kind, query: query(createQuery, search) } as const;
  }
}

export function isOwnedDesign(
  conversation: Conversation,
  owner: string,
  organization: string,
): conversation is Conversation & {
  blankArtifact: NonNullable<Conversation["blankArtifact"]> & {
    kind: "design";
  };
} {
  return (
    conversation.mode === "chat" &&
    !conversation.archived &&
    !conversation.incognito &&
    conversation.blankArtifact?.kind === "design" &&
    (!conversation.sessionAuthors ||
      conversation.sessionAuthors.ownerAccountUuid === owner) &&
    (!conversation.projectOrganizationId ||
      conversation.projectOrganizationId === organization)
  );
}

export function officialDesignWorkspacePath(pathname: string) {
  if (/^\/(?:design|desktop-design|claude-design)\/?$/.test(pathname) ||
      /^\/design\/p\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/?$/.test(pathname))
    return "/artifacts/design";
  if (/^\/design\/settings\/?$/.test(pathname))
    return "/settings/design-systems";
}

export function officialDesignWorkspaceDestination(url: URL, origin: string) {
  if (url.origin === origin || /^https:\/\/(?:preview\.)?claude\.(?:ai|com)$/.test(url.origin))
    return officialDesignWorkspacePath(url.pathname);
}

const frameSlugAlphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function officialDesignArtifactRoute(pathname: string, search: string) {
  const codeId = /^\/(?:code|epitaxy)\/artifact\/([^/]+)$/.exec(pathname)?.[1];
  const shortId = /^(?:\/epitaxy)?\/artifact\/([1-9A-HJ-NP-Za-km-z]{1,22})$/.exec(pathname)?.[1];
  let rawId = codeId;
  if (shortId) {
    let value = 0n;
    for (const letter of shortId) value = value * 58n + BigInt(frameSlugAlphabet.indexOf(letter));
    const hex = value.toString(16).padStart(32, "0");
    if (hex.length !== 32) return undefined;
    rawId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  const id = normalizedUuid.safeParse(rawId);
  const organization = normalizedUuid.safeParse(new URLSearchParams(search).get("org"));
  if (id.success && organization.success)
    return { id: id.data, organization: organization.data };
}

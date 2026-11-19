const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const memory = new RegExp(`^/v1/environment_providers/private/organizations/(${uuid})/users/me/memory\\?repo=cowork$`);

export const coworkMemoryMaxRequestBytes = 4 * 1024 * 1024;
export const coworkMemoryRevision = /^(?:0|[1-9][0-9]{0,18})$/;
export const coworkMemoryIfMatch = /^"((?:0|[1-9][0-9]{0,18}))"$/;

export function officialCoworkMemory(method: string, path: string) {
  const organization = memory.exec(path)?.[1];
  if (!organization) return;
  if (method === "GET") return { organization, operation: "read" as const };
  if (method === "PUT") return { organization, operation: "patch" as const };
  if (method === "DELETE") return { organization, operation: "reset" as const };
}

import type { OfficialUiReadRequest } from "./official-ui-web";

export type OfficialToolPreferences = Readonly<Record<string, boolean | null>>;
export type OfficialConnectorPreference =
  | { kind: "account"; tools: OfficialToolPreferences }
  | {
      kind: "chat";
      organizationId: string;
      pageId: string;
      tools: OfficialToolPreferences;
    };

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const chat = new RegExp(
  `^/api/organizations/(${uuid})/chat_conversations/(${uuid})\\?rendering_mode=raw$`,
);
export const officialConnectorPreferenceMaxBytes = 64 * 1024;

export function officialChatConnectorTarget(method: string, path: string) {
  const match = method === "PUT" ? chat.exec(path) : null;
  return match ? { organizationId: match[1]!, pageId: match[2]! } : undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseOfficialToolPreferences(
  value: unknown,
): OfficialToolPreferences {
  if (!object(value)) throw Error("Invalid connector tool preferences.");
  const entries = Object.entries(value);
  if (
    entries.length > 500 ||
    entries.some(
      ([key, choice]) =>
        !key ||
        key.length > 1024 ||
        (choice !== null && typeof choice !== "boolean"),
    )
  )
    throw Error("Invalid connector tool preferences.");
  return Object.fromEntries(entries) as Record<string, boolean | null>;
}

export function parseOfficialConnectorPreference(
  request: OfficialUiReadRequest,
): OfficialConnectorPreference | undefined {
  const target = officialChatConnectorTarget(request.method, request.path);
  const account =
    request.method === "PATCH" && request.path === "/api/account/settings";
  if (!target && !account) return undefined;
  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > officialConnectorPreferenceMaxBytes ||
    !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")
  )
    throw Error("Invalid connector settings request.");
  const body: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(request.body),
  );
  return parseOfficialConnectorPreferenceBody(
    request.method,
    request.path,
    body,
  );
}

export function parseOfficialConnectorPreferenceBody(
  method: string,
  path: string,
  body: unknown,
): OfficialConnectorPreference | undefined {
  const target = officialChatConnectorTarget(method, path);
  const account = method === "PATCH" && path === "/api/account/settings";
  if (!target && !account) return undefined;
  if (!object(body)) throw Error("Invalid connector settings request.");
  if (account) {
    if (!Object.hasOwn(body, "enabled_mcp_tools")) return undefined;
    if (Object.keys(body).length !== 1)
      throw Error("Update connector settings separately.");
    return {
      kind: "account",
      tools: parseOfficialToolPreferences(body.enabled_mcp_tools),
    };
  }
  if (
    !object(body.settings) ||
    !Object.hasOwn(body.settings, "enabled_mcp_tools")
  )
    return undefined;
  if (Object.keys(body).length !== 1 || Object.keys(body.settings).length !== 1)
    throw Error("Update connector settings separately.");
  return {
    kind: "chat",
    ...target!,
    tools: parseOfficialToolPreferences(body.settings.enabled_mcp_tools),
  };
}

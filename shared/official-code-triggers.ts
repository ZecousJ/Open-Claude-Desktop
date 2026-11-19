const collection = "/v1/code/triggers";
const id = "([A-Za-z0-9_-]{1,128})";
const idPrefix = "trig_";
const publicId = new RegExp(`^${idPrefix}${id}$`);
const itemPath = new RegExp(`^${collection}/${idPrefix}${id}$`);
const itemActionPath = new RegExp(
  `^${collection}/${idPrefix}${id}/(run|fork|api-token)$`,
);
const cancelPath = new RegExp(
  `^${collection}/${idPrefix}${id}/runs/((?:session|cse)_[a-f0-9]{32})/cancel$`,
);
const environments = "/v1/environments";
const webhooks = "/v1/code/webhook-triggers";
const webhookPath = /^\/v1\/code\/webhook-triggers\/(trg_[0-9A-Za-z]{24})$/;
const organizationEnvironments =
  /^\/v1\/environment_providers\/private\/organizations\/([a-fA-F0-9-]{36})\/environments$/;

export const officialCoworkTriggerTag = "cowork-scheduled";
export const officialCodeTriggerId = (routineId: string) =>
  idPrefix + routineId;
export const routineIdFromOfficialCodeTrigger = (triggerId: string) =>
  publicId.exec(triggerId)?.[1];

export type OfficialCodeTriggerRequest =
  | { kind: "list"; query: URLSearchParams }
  | { kind: "environments"; query: URLSearchParams; organization?: string }
  | { kind: "webhooks"; query: URLSearchParams }
  | { kind: "create-webhook" }
  | { kind: "delete-webhook"; webhookId: string }
  | { kind: "create" }
  | {
      kind:
        | "detail"
        | "update"
        | "delete"
        | "run"
        | "fork"
        | "generate-token"
        | "delete-token";
      id: string;
    }
  | { kind: "cancel"; id: string; sessionId: string };

export function isOfficialCodeTriggerPath(pathname: string) {
  return (
    pathname === collection ||
    pathname.startsWith(collection + "/") ||
    pathname === "/v1/code/organization/triggers" ||
    pathname === environments ||
    organizationEnvironments.test(pathname) ||
    pathname === webhooks ||
    pathname.startsWith(webhooks + "/")
  );
}

export function officialCodeTriggerRequest(
  method: string,
  pathname: string,
  search = "",
): OfficialCodeTriggerRequest | undefined {
  if (pathname === collection && method === "GET")
    return { kind: "list", query: new URLSearchParams(search) };
  if (pathname === webhooks && method === "GET")
    return { kind: "webhooks", query: new URLSearchParams(search) };
  if (method === "GET") {
    const organization = organizationEnvironments.exec(pathname)?.[1];
    if (pathname === environments || organization)
      return {
        kind: "environments",
        query: new URLSearchParams(search),
        organization,
      };
  }
  if (search) return;
  if (pathname === webhooks && method === "POST")
    return { kind: "create-webhook" };
  const webhookId = method === "DELETE" && webhookPath.exec(pathname)?.[1];
  if (webhookId) return { kind: "delete-webhook", webhookId };
  if (pathname === collection && method === "POST") return { kind: "create" };
  const item = itemPath.exec(pathname);
  if (item) {
    const kind =
      method === "GET"
        ? "detail"
        : method === "POST"
          ? "update"
          : method === "DELETE"
            ? "delete"
            : undefined;
    return kind && { kind, id: item[1] };
  }
  const cancel = cancelPath.exec(pathname);
  if (cancel && method === "POST")
    return { kind: "cancel", id: cancel[1], sessionId: cancel[2] };
  const action = itemActionPath.exec(pathname);
  if (!action) return;
  if (action[2] === "api-token") {
    const kind =
      method === "POST"
        ? "generate-token"
        : method === "DELETE"
          ? "delete-token"
          : undefined;
    return kind && { kind, id: action[1] };
  }
  if (method === "POST")
    return { kind: action[2] === "run" ? "run" : "fork", id: action[1] };
}

export function isOfficialCodeTriggerRead(request: OfficialCodeTriggerRequest) {
  return (
    request.kind === "list" ||
    request.kind === "detail" ||
    request.kind === "webhooks" ||
    request.kind === "environments"
  );
}

export function codeTriggerOperationAllowed(
  kind: OfficialCodeTriggerRequest["kind"],
  method: string,
) {
  if (method === "listSchedules") return kind !== "environments";
  switch (kind) {
    case "create":
    case "update":
    case "fork":
    case "create-webhook":
    case "delete-webhook":
      return method === "saveSchedule";
    case "delete":
      return method === "deleteSchedule";
    case "run":
      return method === "officialCodeRoutineRun";
    case "cancel":
      return method === "officialCodeRoutineCancel" || method === "routineRuns";
    case "generate-token":
      return method === "saveSchedule" || method === "routineApiToken";
    case "delete-token":
      return method === "routineApiToken";
    default:
      return false;
  }
}

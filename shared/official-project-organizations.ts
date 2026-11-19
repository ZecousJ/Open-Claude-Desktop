const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const resolveProject = new RegExp(`^/api/claudex/project-organizations/resolve/(${uuid})$`, "i");
const orgPath = new RegExp(`^/api/organizations/(${uuid})/(.+)$`, "i");
const accessPath = new RegExp(`^/api/bootstrap/(${uuid})/current_user_access$`, "i");
const projectPath = new RegExp(`^projects(?:_v2)?/(${uuid})(?:/(.+))?$`, "i");
const accountPath = new RegExp(`^accounts/(${uuid})$`, "i");
const knowledgeItem = new RegExp(`^(docs|knowledge)/(${uuid})$`, "i");

export type OfficialOrganizationProjectTarget =
  | { kind: "resolve"; project: string }
  | { kind: "access" | "members" | "policy" | "features" | "count"; organization: string }
  | { kind: "list"; organization: string; paginated: boolean }
  | { kind: "create"; organization: string }
  | { kind: "detail" | "update" | "delete" | "permissions" | "accounts" | "bulk" | "roles" | "conversations" | "syncs";
      organization: string; project: string }
  | { kind: "knowledge"; organization: string; project: string;
      action: "docs" | "files" | "upload" | "stats" | "doc" | "file" | "delete-docs" | "delete-files"; file?: string }
  | { kind: "grant"; organization: string; project: string; account: string };

export function officialOrganizationProjectTarget(
  method: string,
  path: string,
): OfficialOrganizationProjectTarget | undefined {
  if (method === "GET") {
    const match = resolveProject.exec(path);
    if (match) return { kind: "resolve", project: match[1].toLowerCase() };
    const bootstrap = accessPath.exec(path);
    if (bootstrap) return { kind: "access", organization: bootstrap[1].toLowerCase() };
  }
  const org = orgPath.exec(path);
  if (!org) return;
  const organization = org[1].toLowerCase();
  const tail = org[2];
  if (method === "GET" && tail === "members_v2") return { kind: "members", organization };
  if ((method === "GET" || method === "PUT") && tail === "privacy_settings")
    return { kind: "policy", organization };
  if (method === "GET" && (tail === "feature_overview" || tail === "feature_settings"))
    return { kind: "features", organization };
  if (method === "GET" && (tail === "projects_v2" || tail === "projects"))
    return { kind: "list", organization, paginated: tail === "projects_v2" };
  if (method === "GET" && (tail === "projects/count" || tail === "projects_v2/count"))
    return { kind: "count", organization };
  if (method === "POST" && tail === "projects") return { kind: "create", organization };

  const match = projectPath.exec(tail);
  if (!match) return;
  const project = match[1].toLowerCase();
  const action = match[2];
  const scope = { organization, project };
  if (!action) {
    if (method === "GET") return { kind: "detail", ...scope };
    if (method === "PUT") return { kind: "update", ...scope };
    if (method === "DELETE") return { kind: "delete", ...scope };
  }
  if (method === "GET") {
    if (action === "permissions" || action === "accounts" || action === "roles" || action === "syncs")
      return { kind: action, ...scope };
    if (action === "conversations_v2") return { kind: "conversations", ...scope };
    if (action === "docs" || action === "files") return { kind: "knowledge", ...scope, action };
    if (action === "kb/stats") return { kind: "knowledge", ...scope, action: "stats" };
  }
  const file = action && knowledgeItem.exec(action);
  if (file && (method === "GET" || method === "DELETE" && file[1] === "docs"))
    return { kind: "knowledge", ...scope, action: file[1] === "docs" ? "doc" : "file", file: file[2].toLowerCase() };
  if (method === "POST") {
    if (action === "docs" || action === "upload") return { kind: "knowledge", ...scope, action };
    if (action === "docs/delete_many" || action === "files/delete_many")
      return { kind: "knowledge", ...scope, action: action === "docs/delete_many" ? "delete-docs" : "delete-files" };
  }
  if (method === "POST" && action === "accounts_bulk") return { kind: "bulk", ...scope };
  if (method === "PUT" && action) {
    const match = accountPath.exec(action);
    if (match) return { kind: "grant", ...scope, account: match[1].toLowerCase() };
  }
}

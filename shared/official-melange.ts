const uuid =
  "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const organization = `/api/organizations/(${uuid})`;
const melangePath = new RegExp(
  `^${organization}/melange/(list|read|delete|edit|import_external|import_external/status|switch_import/status)$`,
);
const streamPath = new RegExp(
  `^${organization}/claudex_melange_edit/(${uuid})(/stop)?$`,
);

export const officialMelangeEditBodyBytes = 16_384;
export const officialMelangeImportBodyBytes = 6 * 65_536 + 1024;

type Operation =
  | "list"
  | "read"
  | "delete"
  | "edit"
  | "external-import"
  | "external-status"
  | "switch-status";

export function officialMelangeRoute(
  method: string,
  pathname: string,
  search = "",
): { organization: string; operation: Operation } | undefined {
  if (search) return undefined;
  const match = melangePath.exec(pathname);
  if (!match) return undefined;
  const organization = match[1].toLowerCase();
  switch (match[2]) {
    case "list":
    case "read":
    case "delete":
    case "edit": {
      const operation = match[2];
      return method === "POST" ? { organization, operation } : undefined;
    }
    case "import_external":
      return method === "POST"
        ? { organization, operation: "external-import" }
        : undefined;
    case "import_external/status":
      return method === "GET"
        ? { organization, operation: "external-status" }
        : undefined;
    case "switch_import/status":
      return method === "GET"
        ? { organization, operation: "switch-status" }
        : undefined;
  }
}

export function officialMelangeEditPath(organization: string, id: string) {
  return `/api/organizations/${organization}/claudex_melange_edit/${id}`;
}

export function officialMelangeEditRequest(method: string, path: string) {
  const query = path.indexOf("?");
  const pathname = query < 0 ? path : path.slice(0, query);
  const search = query < 0 ? "" : path.slice(query);
  const match = streamPath.exec(pathname);
  if (!match) return undefined;
  const target = {
    organization: match[1].toLowerCase(),
    id: match[2].toLowerCase(),
  };
  if (method === "POST" && !search)
    return {
      ...target,
      kind: match[3] ? ("stop" as const) : ("start" as const),
    };
  if (
    method === "GET" &&
    !match[3] &&
    /^\?cursor=(0|[1-9][0-9]{0,6})$/.test(search)
  )
    return {
      ...target,
      kind: "poll" as const,
      cursor: Number(search.slice(8)),
    };
}

const cleanupPath = new RegExp(`^${organization}/melange/sensitive_cleanup$`);
const orgConsentQuery = new RegExp(`^\\?organization_uuid=(${uuid})&consent_type=memory\\.sensitive_info$`);
type PrivacyOperation =
  | "consent-check"
  | "consent-write"
  | "org-consent-read"
  | "org-consent-write"
  | "cleanup-status"
  | "cleanup-start";

export function officialMelangePrivacyRoute(
  method: string,
  pathname: string,
  search = "",
): { operation: PrivacyOperation; organization?: string } | undefined {
  if (method === "GET" && pathname === "/v1/privacy-consents/org") {
    const match = orgConsentQuery.exec(search);
    return match ? { operation: "org-consent-read", organization: match[1].toLowerCase() } : undefined;
  }
  if (search) return undefined;
  if (method === "POST" && pathname === "/v1/privacy-consents/check")
    return { operation: "consent-check" };
  if (method === "PUT" && pathname === "/v1/privacy-consents")
    return { operation: "consent-write" };
  if (method === "PUT" && pathname === "/v1/privacy-consents/org")
    return { operation: "org-consent-write" };
  const match = cleanupPath.exec(pathname);
  if (match && (method === "GET" || method === "POST"))
    return { operation: method === "GET" ? "cleanup-status" : "cleanup-start", organization: match[1].toLowerCase() };
}

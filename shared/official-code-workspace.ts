const route =
  /^\/v1\/code\/sessions\/(?:session|cse)_([a-f0-9]{32})\/workspace$/;
export function isOfficialCodeWorkspacePath(pathname: string) {
  return route.test(pathname);
}
export function officialCodeWorkspace(
  method: string,
  pathname: string,
  search: string,
) {
  const key = route.exec(pathname)?.[1];
  if (method !== "GET" || !key) return undefined;
  const p = new URLSearchParams(search);
  if ([...p.keys()].some((k) => p.getAll(k).length !== 1)) return undefined;
  const op = p.get("op");
  if (
    op !== "list" &&
    op !== "read" &&
    op !== "search" &&
    op !== "mentions" &&
    op !== "changes"
  )
    return undefined;
  const allowed =
    op === "list" || op === "read"
      ? ["op", "path"]
      : op === "search"
        ? ["op", "query", "maxResults", "matchCase", "wholeWord", "regexp"]
        : op === "mentions"
          ? ["op", "query"]
          : ["op", "context"];
  if ([...p.keys()].some((k) => !allowed.includes(k))) return undefined;
  const file = p.get("path");
  const query = p.get("query");
  if (
    (op === "list" || op === "read") &&
    (file === null || file.length > 4096 || file.includes("\0"))
  )
    return undefined;
  if (
    (op === "search" || op === "mentions") &&
    (query === null ||
      query.length > (op === "search" ? 1000 : 300) ||
      query.includes("\0"))
  )
    return undefined;
  const max = p.get("maxResults");
  const context = p.get("context");
  if (max !== null && (!/^\d+$/.test(max) || +max < 1 || +max > 241))
    return undefined;
  if (context !== null && (!/^\d+$/.test(context) || +context > 10000))
    return undefined;
  for (const flag of ["matchCase", "wholeWord", "regexp"])
    if (p.has(flag) && !["true", "false"].includes(p.get(flag)!))
      return undefined;
  return {
    key,
    op,
    file: file ?? "",
    query: query ?? "",
    maxResults: max === null ? 200 : +max,
    context: context === null ? undefined : +context,
    options: {
      matchCase: p.get("matchCase") === "true",
      wholeWord: p.get("wholeWord") === "true",
      regexp: p.get("regexp") === "true",
    },
  };
}

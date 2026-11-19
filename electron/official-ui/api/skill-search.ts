/** Installed-library search only. Never substitutes for Discover/catalog reads. */
import { createHash } from "node:crypto";
import type http from "node:http";
import { organizationUuid, reply, type AdapterContext } from "./context";
interface Item {
  id: string;
  name: string;
  display_name?: string | null;
  description: string | null;
  updated_at: string | null;
  provenance: { source: string };
}
export async function installedSkillSearch<T extends Item>(
  res: http.ServerResponse,
  url: URL,
  ctx: AdapterContext,
  read: () => Promise<T[]>,
) {
  const diagnostic = (status: number) => {
    try {
      ctx.log("[skill-search] library.mine", { status });
    } catch {
      /* Diagnostics cannot alter the read outcome. */
    }
  };
  const fail = (status: number, message: string) => {
    diagnostic(status);
    return reply(
      res,
      { error: { type: "invalid_request_error", message } },
      status,
    );
  };
  const owner = ctx.account()?.id,
    identity = ctx.sessionIdentity?.(),
    root = ctx.stateDirectory?.();
  const current = () => {
    try {
      return (
        !!owner &&
        identity != null &&
        identity !== "" &&
        ctx.isCurrent?.() !== false &&
        ctx.account()?.id === owner &&
        ctx.sessionIdentity?.() === identity &&
        ctx.stateDirectory?.() === root
      );
    } catch {
      return false;
    }
  };
  if (!owner) return fail(401, "Sign in to continue.");
  if (url.pathname.split("/")[3] !== organizationUuid(owner))
    return fail(404, "Organization not found.");
  if (!current()) return fail(409, "The account changed. Reopen skill search.");
  const p = url.searchParams,
    allowed = new Set([
      "kind",
      "q",
      "limit",
      "cursor",
      "sort",
      "source",
      "group_by_kind",
    ]);
  if (
    [...p.keys()].some((k) => !allowed.has(k)) ||
    [...allowed].some((k) => k !== "kind" && p.getAll(k).length > 1)
  )
    return fail(400, "Unsupported installed-skill search query.");
  if (p.has("group_by_kind") && p.get("group_by_kind") !== "true")
    return fail(400, "Invalid library grouping.");
  const kinds = p.getAll("kind").flatMap((k) => k.split(","));
  if (kinds.some((k) => k !== "skill" && k !== "plugin"))
    return fail(501, "This search supports installed skills and plugins only.");
  const q = p.get("q") ?? "",
    sort = p.get("sort"),
    source = p.get("source"),
    limitText = p.get("limit") ?? "1000";
  if (
    q.length > 2000 ||
    !/^[1-9][0-9]{0,3}$/.test(limitText) ||
    Number(limitText) > 1000 ||
    (sort !== null && !["name", "recent"].includes(sort)) ||
    (source !== null &&
      !["personal", "organization", "default"].includes(source))
  )
    return fail(400, "Invalid installed-skill search filter.");
  if (sort === "recent" && (!kinds.length || kinds.includes("plugin")))
    return fail(501, "Plugin installation timestamps are unavailable.");
  let items: T[];
  try {
    items = await read();
  } catch {
    return current()
      ? fail(503, "Installed skills could not be read. Try again.")
      : fail(409, "The account changed. Reopen skill search.");
  }
  if (!current()) return fail(409, "The account changed. Reopen skill search.");
  const needle = q.trim().toLowerCase();
  items = items.filter(
    (item) =>
      (!needle ||
        `${item.name}\n${item.display_name ?? ""}\n${item.description ?? ""}`
          .toLowerCase()
          .includes(needle)) &&
      (!source || item.provenance.source === source),
  );
  if (sort === "name")
    items.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  if (sort === "recent")
    items.sort(
      (a, b) =>
        (b.updated_at ?? "").localeCompare(a.updated_at ?? "") ||
        a.id.localeCompare(b.id),
    );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([owner, needle, sort, source, items.map((item) => item.id)]))
    .digest("hex")
    .slice(0, 24);
  let offset = 0;
  const cursor = p.get("cursor");
  if (cursor !== null) {
    const m = /^([1-9][0-9]*):([a-f0-9]{24})$/.exec(cursor);
    if (
      !m ||
      m[2] !== fingerprint ||
      !Number.isSafeInteger(Number(m[1])) ||
      Number(m[1]) >= items.length
    )
      return fail(409, "The search results changed. Search again.");
    offset = Number(m[1]);
  }
  const next = offset + Number(limitText),
    body = {
      items: items.slice(offset, next),
      next_cursor: next < items.length ? `${next}:${fingerprint}` : null,
      total_count: items.length,
      facets: { categories: [] },
    };
  if (Buffer.byteLength(JSON.stringify(body)) > 4 * 1024 * 1024)
    return fail(413, "The installed-skill search response is too large.");
  diagnostic(200);
  return reply(res, body);
}

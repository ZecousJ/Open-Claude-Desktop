import type http from "node:http";
import { officialWorkspaceDownload } from "../../../shared/official-workspace-download";
import { organizationUuid, reply, type AdapterContext } from "./context";

/** The native renderer uses the same account-bound runner read as the Web renderer. */
export async function workspaceDownloadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AdapterContext,
) {
  const query = officialWorkspaceDownload(
    req.method ?? "",
    url.pathname,
    url.search,
  );
  if (!query || !ctx.readWorkspaceDownload) return false;
  const account = ctx.account();
  const organization = query.organization ?? req.headers["x-organization-uuid"];
  if (!account || organization !== organizationUuid(account.id))
    return reply(res, { error: { message: "Workspace file not found." } }, 404);
  const unavailable = () =>
    reply(
      res,
      { error: { message: "The workspace is unavailable. Try again." } },
      503,
    );
  try {
    const answer = await ctx.readWorkspaceDownload({
      method: "GET",
      path: url.pathname + url.search,
      ...(!query.organization && { codeOrganizationId: organization }),
    });
    if (!answer || ctx.isCurrent?.() === false) return unavailable();
    res.writeHead(answer.status, {
      "Content-Type": answer.contentType,
      "Content-Length": String(answer.body.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(answer.contentDisposition && {
        "Content-Disposition": answer.contentDisposition,
      }),
    });
    res.end(answer.body);
    return true;
  } catch {
    return unavailable();
  }
}

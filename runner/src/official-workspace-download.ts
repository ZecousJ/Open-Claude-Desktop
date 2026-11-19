import fs from "node:fs";
import path from "node:path";
import {
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
  isOwnedCloudCoworkSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  attachmentResponseHeaders,
  mediaTypeOf,
} from "../../electron/official-ui/api/files";
import {
  officialUiReadMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { officialWorkspaceDownload } from "../../shared/official-workspace-download";
import { inCodeWorkspace } from "./code-workspace";
import { within } from "./sandbox/driver";
import { openVerified } from "./sandbox/snapshot";
import type { WebAppContext } from "./web-app-context";

type Download = NonNullable<ReturnType<typeof officialWorkspaceDownload>>;

function json(status: number, value: object): OfficialUiReadResponse {
  return {
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(value)),
  };
}

/** Resolve only an account-owned runner workspace, with no remote or symlinked root. */
export function resolveOfficialWorkspace(
  ctx: WebAppContext,
  key: string,
  organization: string | undefined,
  headerOrganization: unknown,
  modes: readonly string[],
) {
  const owner = ctx.activeAccount?.id;
  if (
    !owner ||
    (organization ?? headerOrganization) !== organizationUuid(owner)
  )
    return undefined;
  const conversation = ctx.store.conversations.find(
    (c) =>
      (c.mode === "code" || c.mode === "cowork") &&
      (!organization || c.mode === "cowork") &&
      modes.includes(c.mode) &&
      (c.mode === "cowork"
        ? isOwnedCloudCoworkSession(c, owner)
        : isOwnedCloudCodeSession(c, owner) &&
          !c.linkedToComputer &&
          !c.chatDeviceBinding &&
          (!c.sessionAuthors ||
            c.sessionAuthors.viewerAccountUuid === owner)) &&
      cloudCodeSessionKey(c, owner) === key,
  );
  if (!conversation?.cwd || conversation.environment?.kind === "ssh")
    return undefined;
  const cwd = path.resolve(conversation.cwd);
  const environment = conversation.environment;
  try {
    const workspace =
      environment?.kind === "space"
        ? path.join(ctx.spaceRoot(environment.spaceId), "workspace")
        : ctx.workspace;
    if (
      conversation.mode === "code"
        ? !inCodeWorkspace(workspace, cwd)
        : cwd !== workspace
    )
      return undefined;
    const root = fs.realpathSync(ctx.store.root);
    const relative = path.relative(ctx.store.root, cwd);
    if (
      !within(cwd, ctx.store.root) ||
      fs.realpathSync(cwd) !== path.join(root, relative)
    )
      return undefined;
    return { conversation, cwd, root: path.join(root, relative) };
  } catch {
    return undefined;
  }
}

/** Read the named file from the runner-owned workspace of this stored session. */
export function readOfficialWorkspaceDownload(
  ctx: WebAppContext,
  query: Download,
  headerOrganization: unknown,
  modes: readonly string[],
): OfficialUiReadResponse {
  const missing = () =>
    json(404, { error: { message: "Workspace file not found." } });
  const workspace = resolveOfficialWorkspace(
    ctx,
    query.key,
    query.organization,
    headerOrganization,
    modes,
  );
  if (!workspace) return missing();
  const { conversation, cwd } = workspace;

  // The original Cowork UI addresses the working/outputs mounts. They point
  // at this conversation's runner workspace and its outputs subdirectory.
  const file =
    conversation.mode === "cowork"
      ? query.file
          .replace(/^\/mnt\/user-data\/working\//, "")
          .replace(/^\/mnt\/user-data\/outputs\//, "outputs/")
      : query.file === "/workspace"
        ? ""
        : query.file.startsWith("/workspace/")
          ? query.file.slice(11)
          : query.file;
  const target = path.resolve(cwd, file);
  if (!within(target, cwd) || target === cwd) return missing();

  const contentType = mediaTypeOf(target);
  // Base64 and the JSON envelope must fit the same browser bridge as raw downloads.
  const limit = query.organization
    ? officialUiReadMaxBytes
    : Math.floor((officialUiReadMaxBytes - 256) / 4) * 3;
  const tooLarge = () =>
    json(400, {
      error: {
        type: "invalid_request_error",
        reason: "session_file_too_large",
        message: "This workspace file is too large to download.",
      },
    });
  try {
    const resolved = fs.realpathSync(target);
    if (!within(resolved, workspace.root)) return missing();
    const fd = openVerified(resolved, resolved);
    if (fd === undefined) return missing();
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return missing();
      if (stat.size > limit) return tooLarge();
      const body = Buffer.alloc(stat.size);
      let read = 0;
      while (read < body.length) {
        const size = fs.readSync(fd, body, read, body.length - read, null);
        if (!size)
          return json(409, {
            error: { message: "The workspace file changed. Try again." },
          });
        read += size;
      }
      if (!query.organization)
        return json(200, {
          content: body.toString("base64"),
          content_type: contentType,
        });
      const headers = attachmentResponseHeaders(
        { name: path.basename(target) },
        "application/octet-stream",
      );
      return {
        status: 200,
        contentType: headers["Content-Type"],
        ...("Content-Disposition" in headers && {
          contentDisposition: headers["Content-Disposition"],
        }),
        body,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      return missing();
    return json(503, {
      error: { message: "The workspace file could not be read. Try again." },
    });
  }
}

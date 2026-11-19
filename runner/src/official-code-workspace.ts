import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { mediaTypeOf } from "../../electron/official-ui/api/files";
import { officialUiReadMaxBytes } from "../../shared/official-ui-web";
import { mentionFiles } from "../../electron/engine/composer-files";
import { searchProjectFiles } from "../../electron/projects/project-files";
import { parseUnifiedDiff } from "../../shared/diff-model";
import { workingTreeChanges } from "../../electron/git/working-tree";
import type { officialCodeWorkspace } from "../../shared/official-code-workspace";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import { within } from "./sandbox/driver";
import { openVerified } from "./sandbox/snapshot";
import { resolveOfficialWorkspace } from "./official-workspace-download";
import type { WebAppContext } from "./web-app-context";

type Query = NonNullable<ReturnType<typeof officialCodeWorkspace>>;
const json = (status: number, value: unknown): OfficialUiReadResponse => {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > officialUiReadMaxBytes)
    return {
      status: 413,
      contentType: "application/json",
      body: Buffer.from(
        '{"error":"Workspace result is too large. Narrow the request."}',
      ),
    };
  return { status, contentType: "application/json", body };
};

/** The original Web's native Files methods, scoped to one owned cloud Code session. */
export async function readOfficialCodeWorkspace(
  ctx: WebAppContext,
  query: Query,
  organization: unknown,
  modes: readonly string[],
): Promise<OfficialUiReadResponse> {
  const workspace = resolveOfficialWorkspace(
    ctx,
    query.key,
    undefined,
    organization,
    modes,
  );
  if (!workspace || workspace.conversation.mode !== "code")
    return json(404, { error: "Workspace not found." });
  const { cwd, root } = workspace;
  const virtual = (file: string) =>
    `/workspace${path.relative(cwd, file) ? `/${path.relative(cwd, file).split(path.sep).join("/")}` : ""}`;
  try {
    if (query.op === "changes") {
      const environment = workspace.conversation.environment;
      const host =
        environment?.kind === "space" && ctx.runtime?.workingTree
          ? ctx.runtime.workingTree({
              userId: ctx.userId,
              storeRoot: ctx.spaceRoot(environment.spaceId),
              spaceId: environment.spaceId,
            })
          : ctx.services.workingTree;
      if (!host) return json(503, { error: "Changes are unavailable." });
      const tree = await workingTreeChanges(cwd, query.context, host);
      if (tree.state !== "ready") return json(200, { status: "no_repo" });
      if (tree.truncated)
        return json(503, {
          error: "Changes are too large to display completely.",
        });
      const untracked = new Set(
        (
          await host.git(cwd, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean),
      );
      const files = parseUnifiedDiff(tree.diff);
      return json(200, {
        status: "ok",
        diff: {
          stats: {
            filesCount: files.length,
            linesAdded: files.reduce((n, f) => n + f.additions, 0),
            linesRemoved: files.reduce((n, f) => n + f.deletions, 0),
          },
          perFileStats: files.map((f) => ({
            path: f.path,
            added: f.additions,
            removed: f.deletions,
            isBinary: !!f.binary,
            isUntracked: untracked.has(f.path),
            status: f.status === "deleted" ? "removed" : f.status,
            previousPath: f.oldPath,
            newPath: f.path,
          })),
          hunks: files.map((f) => ({
            path: f.path,
            hunks: f.hunks.map((h) => ({
              ...h,
              lines: h.lines.map(
                (l) =>
                  (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") +
                  l.text,
              ),
            })),
          })),
          skippedLarge: [],
          restricted: [],
          source: { kind: "working-tree" },
        },
      });
    }
    if (query.op === "mentions") {
      return json(
        200,
        mentionFiles(root, query.query).map((file) => ({
          id: `file-/workspace/${file.path}`,
          label: file.path,
          icon: file.kind === "folder" ? "directory" : "file",
          category: "Files",
          metadata: JSON.stringify({
            path: file.path,
            isDirectory: file.kind === "folder",
          }),
        })),
      );
    }
    if (query.op === "search") {
      const result = await searchProjectFiles(root, query.query, {
        ...query.options,
        strict: true,
        filesPane: true,
        maxResults: query.maxResults,
      });
      if (result.truncated && result.matches.length < query.maxResults)
        return json(503, {
          error: "Search was truncated. Narrow the query and retry.",
        });
      return json(200, {
        matches: result.matches.map((m) => ({
          relativePath: m.path,
          absPath: `/workspace/${m.path}`,
          line: m.line,
          column: m.column,
          preview: m.preview,
          ...(m.previewMatches ? { previewMatches: m.previewMatches } : {}),
        })),
        patternRefused: result.patternRefused === true,
      });
    }
    const input =
      query.file === "/workspace"
        ? ""
        : query.file.startsWith("/workspace/")
          ? query.file.slice(11)
          : query.file;
    const target = path.resolve(cwd, input || ".");
    if (!within(target, cwd))
      return json(200, { status: "outsideSessionFolders" });
    let resolved: string;
    try {
      resolved = fs.realpathSync(target);
    } catch {
      return json(200, { status: "notFound", creatable: false });
    }
    if (!within(resolved, root))
      return json(200, { status: "outsideSessionFolders" });
    const fd = openVerified(resolved, resolved);
    if (fd === undefined) return json(200, { status: "readError" });
    try {
      const stat = fs.fstatSync(fd);
      if (query.op === "list") {
        if (!stat.isDirectory()) return json(200, { status: "readError" });
        const directory =
          process.platform === "linux" ? `/proc/self/fd/${fd}` : resolved;
        const entries = fs.readdirSync(directory, { withFileTypes: true });
        if (entries.length > 10000)
          return json(400, { error: "Too many entries." });
        return json(
          200,
          entries.flatMap((entry) => {
            const file = path.join(directory, entry.name);
            const info = fs.lstatSync(file, { throwIfNoEntry: false });
            if (!info) return [];
            let isDirectory = info.isDirectory();
            if (info.isSymbolicLink()) {
              try {
                const real = fs.realpathSync(file);
                isDirectory =
                  within(real, root) && fs.statSync(real).isDirectory();
              } catch {}
            }
            return [
              {
                name: entry.name,
                path: virtual(path.join(target, entry.name)),
                isDirectory,
                mtimeMs: info.mtimeMs,
                size: info.size,
              },
            ];
          }),
        );
      }
      if (!stat.isFile()) return json(200, { status: "readError" });
      const maxBytes = Math.floor((officialUiReadMaxBytes - 4096) / 4) * 3;
      if (stat.size > maxBytes)
        return json(200, { status: "tooLarge", maxBytes });
      const data = Buffer.alloc(stat.size);
      let read = 0;
      while (read < data.length) {
        const n = fs.readSync(fd, data, read, data.length - read, null);
        if (!n) return json(409, { error: "File changed while reading." });
        read += n;
      }
      const mime = mediaTypeOf(resolved);
      const office = /\.(?:docx?|xlsx?|pptx?)$/i.test(resolved);
      const binary = office || !isUtf8(data) || data.includes(0);
      const dataUrl = mime.startsWith("image/") || mime === "application/pdf";
      const contents = dataUrl
        ? `data:${mime};base64,${data.toString("base64")}`
        : binary
          ? data.toString("base64")
          : data.toString("utf8");
      return json(200, {
        status: "ok",
        file: {
          absPath: virtual(target),
          contents,
          ...(binary && !dataUrl ? { encoding: "base64", mimeType: mime } : {}),
          hash: createHash("sha256").update(data).digest("hex"),
          fileSize: stat.size,
          inSessionFolders: true,
        },
      });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return json(503, { error: "Workspace could not be read. Try again." });
  }
}

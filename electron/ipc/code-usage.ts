import { z } from "zod";
import { registerSyncBaseExtension } from "../git/sync-base-branch";
import { startPullRequestAutoFix } from "../git/pr-autofix";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { CodeUsageDashboard } from "../../shared/code-usage-api";
import type { UsageRange } from "../../shared/types";
import { requestJson } from "../sub2api/http";
import { workspaceGit, workspaceRepository } from "../git/git-branch";
import { pullRequestForBranch } from "../git/github-cli";
import {
  folderBranches,
  folderChanges,
  resolveFolderChanges,
  switchFolderBranch,
} from "../git/folder-branch";
import {
  contextSources,
  environmentInput,
  workspaceFsFor,
} from "../workspace/workspace-fs";

const range = z.enum(["all", "30d", "7d"]);

/** `YYYY-MM-DD` in the computer's time zone. */
function localDate(at: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The dashboard query for a range: whole local days, today included. */
export function dashboardQuery(value: UsageRange, now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() - (value === "7d" ? 6 : 29));
  const params = new URLSearchParams({
    // "All": the service keeps its own retention; ask from well before any use.
    start_date: value === "all" ? "2000-01-01" : localDate(start),
    end_date: localDate(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    granularity: "day",
    include_trend: "true",
    include_model_stats: "true",
  });
  return params.toString();
}

const count = z.number().finite().nonnegative().catch(0);
const snapshot = z.object({
  trend: z.array(z.object({ date: z.string(), total_tokens: count })).catch([]),
  models: z
    .array(
      z.object({
        model: z.string(),
        input_tokens: count,
        output_tokens: count,
        total_tokens: count,
      }),
    )
    .catch([]),
});

/** The service's snapshot, in the card's terms. */
export function dashboardFrom(data: unknown): CodeUsageDashboard {
  const parsed = snapshot.parse(data ?? {});
  const models = parsed.models
    .map((m) => ({
      model: m.model,
      input: m.input_tokens,
      output: m.output_tokens,
      total: m.total_tokens || m.input_tokens + m.output_tokens,
    }))
    .filter((m) => m.model && m.total > 0)
    .sort((a, b) => b.total - a.total);
  return {
    tokens: models.reduce((n, m) => n + m.total, 0),
    models,
    daily: parsed.trend
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
      .map((d) => ({ date: d.date, tokens: d.total_tokens }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * The Code home: the local usage log; for a Sub2API account the service's
 * `/api/v1/usage/dashboard/snapshot-v2` through the signed-in session; and the
 * chosen folder's Git branch and remotes.
 */
export function registerCodeUsageHandlers(handle: IpcHandle, ctx: AppContext) {
  // Worktree sessions can merge their base branch in (sync_with_base_branch).
  registerSyncBaseExtension(ctx);
  // Auto-fix pull requests: the desktop watches with the machine's gh.
  if (process.versions.electron || ctx.services.readPullRequestAutoFix) {
    let stop: (() => void) | undefined;
    ctx.onAccountActivated?.(() => {
      stop?.();
      stop = startPullRequestAutoFix(ctx);
    });
    ctx.onAccountDeactivating?.(() => {
      stop?.();
      stop = undefined;
    });
  }
  handle("usageSummary", (value: unknown = "all") =>
    ctx.engine.usageSummary(range.parse(value)),
  );
  handle("codeUsageDashboard", async (value: unknown) => {
    const parsed = range.parse(value);
    const remote = ctx.remote;
    if (!remote?.ready) return null;
    const url = `${remote.backend.client.baseUrl}/api/v1/usage/dashboard/snapshot-v2?${dashboardQuery(parsed)}`;
    try {
      const data = await remote.session.authorized((token) =>
        requestJson(fetch, url, { token }),
      );
      return dashboardFrom(data);
    } catch {
      // Offline or refused: the card keeps the local figures.
      return null;
    }
  });
  handle("workspaceGit", async (folder: unknown, rawEnvironment: unknown) => {
    const path = z.string().min(1).max(4096).parse(folder);
    // A folder on an SSH host is asked of the host's git (R9).
    const environment = environmentInput.optional().parse(rawEnvironment);
    try {
      ctx.allowedFolder(path, environment);
    } catch {
      return null;
    }
    if (environment?.kind !== "ssh") return workspaceGit(path);
    try {
      return await workspaceFsFor(
        contextSources(ctx),
        environment,
      ).workspaceGit(path);
    } catch {
      return null;
    }
  });
  // The new task's folder (a folder the person chose): its branches, its
  // changes, switching branch and clearing changes first.
  const folderOf = (raw: unknown) => {
    const path = z.string().min(1).max(4096).parse(raw);
    ctx.allowedFolder(path);
    return path;
  };
  const branchName = z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !name.startsWith("-"));
  handle("folderBranches", (folder: unknown) =>
    folderBranches(folderOf(folder)),
  );
  handle("folderChanges", (folder: unknown) => folderChanges(folderOf(folder)));
  handle("switchFolderBranch", (folder: unknown, branch: unknown) =>
    switchFolderBranch(folderOf(folder), branchName.parse(branch)),
  );
  handle("folderPullRequest", async (folder: unknown) => {
    const path = folderOf(folder);
    const repository = workspaceRepository(path);
    const branch = (await folderBranches(path))?.current;
    return repository && branch
      ? pullRequestForBranch(repository, branch)
      : null;
  });
  handle("resolveFolderChanges", (folder: unknown, action: unknown) =>
    resolveFolderChanges(
      folderOf(folder),
      z.enum(["stash", "commit", "discard"]).parse(action),
    ),
  );
}

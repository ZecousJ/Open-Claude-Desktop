import type { Conversation, SessionPullRequest } from "../../shared/types";
import type { GitHubPullRequest } from "../../shared/github-api";
import { parsePullRequestUrl, sessionPullRequests } from "../../shared/pull-request";
import { getPullRequest, readGitHubPullRequestForBranch, runGh, type GhRunner } from "../git/github-cli";
import { workspaceGit, workspaceRepository } from "../git/git-branch";

function pullRequestFact(pr: GitHubPullRequest): SessionPullRequest {
  return {
    repository: pr.repository, number: pr.number, url: pr.url,
    title: pr.title, headRef: pr.headRef, baseRef: pr.baseRef,
    headRepository: pr.headRepository, own: pr.viewerIsAuthor, createdAt: pr.createdAt,
    state: pr.state, checkedAt: Date.now(),
  };
}

interface DesktopPullRequestBranch {
  cwd: string;
  branch?: string | null;
}

export async function readDesktopArchivePullRequests(
  c: Conversation,
  query?: DesktopPullRequestBranch,
  run: GhRunner = runGh,
): Promise<SessionPullRequest[] | undefined> {
  if (c.environment && c.environment.kind !== "local") return;
  const primary = c.worktree?.state === "deleted" ? c.worktree.origin : c.cwd;
  const target = (cwd: string) => ({
    repository: workspaceRepository(cwd),
    branch: workspaceGit(cwd).branch,
  });
  const folders = new Set([primary, ...(c.additionalFolders ?? []),
    ...(c.additionalWorktrees ?? []).flatMap(tree => tree.folders.map(folder => folder.cwd))]);
  const targets = [...folders].flatMap(cwd => cwd ? [target(cwd)] : []);
  const bindings = new Map<string, SessionPullRequest>();
  const identity = (repository: string, number: number) => `${repository.toLowerCase()}#${number}`;
  const verifiedAddress = (pr: GitHubPullRequest, repository: string, number = pr.number) => {
    const address = parsePullRequestUrl(pr.url);
    return address?.host === "github.com" && address.number === number && pr.number === number &&
      address.repository.toLowerCase() === repository.toLowerCase();
  };
  for (const row of c.pullRequests ?? []) {
    if (parsePullRequestUrl(row.url)?.host === "github.com")
      bindings.set(identity(row.repository, row.number), row);
  }
  const forkIndex = c.forkedFrom ? c.turns.findIndex(turn => turn.id === c.forkedFrom?.turnId) : -1;
  const ownTurns = c.forkedFrom ? forkIndex < 0 ? [] : c.turns.slice(forkIndex + 1) : c.turns;
  for (const binding of [...bindings.values()]) {
    const { pullRequest: pr } = await getPullRequest(binding.repository, binding.number, run);
    if (!pr || !verifiedAddress(pr, binding.repository, binding.number)) return;
    bindings.set(identity(pr.repository, pr.number), { ...binding, ...pullRequestFact(pr) });
  }
  for (const ref of sessionPullRequests({ turns: ownTurns })) {
    const repo = ref.repository.toLowerCase();
    const key = identity(ref.repository, ref.number);
    if (ref.host !== "github.com" || bindings.has(key)) continue;
    const branches = targets.flatMap(({ repository, branch }) =>
      repository?.toLowerCase() === repo && branch ? [branch] : []);
    if (!branches.length) continue;
    const { pullRequest: pr, problem } = await getPullRequest(ref.repository, ref.number, run);
    if (problem) return;
    if (pr && verifiedAddress(pr, ref.repository, ref.number) &&
        pr.headRepository?.toLowerCase() === repo && branches.includes(pr.headRef))
      bindings.set(key, pullRequestFact(pr));
  }
  const branchFolder = query?.cwd || primary;
  const branchTarget = branchFolder && target(branchFolder);
  if ((query || !bindings.size && c.worktree) && branchTarget) {
    const { repository, branch: currentBranch } = branchTarget;
    const branch = query?.branch || currentBranch;
    if (repository && branch && branch === currentBranch && ![...bindings.values()].some(row =>
      row.repository.toLowerCase() === repository.toLowerCase() && row.headRef === branch)) {
      const { pullRequest: pr, problem } = await readGitHubPullRequestForBranch(repository, branch, run, "all");
      if (problem) return;
      if (pr && verifiedAddress(pr, repository) &&
          pr.headRepository?.toLowerCase() === repository.toLowerCase() && pr.headRef === branch)
        bindings.set(identity(pr.repository, pr.number), pullRequestFact(pr));
    }
  }
  return [...bindings.values()];
}

import type {
  GitHubBranchesPage,
  GitHubRepositoriesPage,
} from "../../shared/github-api";
import { validRepositoryName } from "../../shared/github-parse";
import { runGh, type GhRunner } from "./github-cli";

const failure = "Something went wrong. You can try again.";

export async function listChatRepositories(
  input?: { query?: string; page?: number },
  run: GhRunner = runGh,
): Promise<GitHubRepositoriesPage> {
  const page = input?.page ?? 1;
  const result = await run([
    "api",
    `user/repos?per_page=100&sort=updated&page=${page}`,
  ]);
  if (result.code !== 0) throw Error(failure);
  const rows = JSON.parse(result.stdout) as {
    full_name: string;
    name: string;
    owner: { login: string };
    private: boolean;
    description: string | null;
    default_branch: string;
    clone_url: string;
  }[];
  const query = input?.query?.toLowerCase() ?? "";
  return {
    items: rows
      .filter(
        (repo) =>
          validRepositoryName(repo.full_name) &&
          repo.full_name.toLowerCase().includes(query),
      )
      .map((repo) => ({
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        private: repo.private,
        description: repo.description ?? "",
        defaultBranch: repo.default_branch,
        cloneUrl: repo.clone_url,
      })),
    nextPage: rows.length === 100 ? page + 1 : null,
    truncated: false,
  };
}

export async function listChatBranches(
  input: { repository: string; query?: string; page?: number },
  run: GhRunner = runGh,
): Promise<GitHubBranchesPage> {
  if (!validRepositoryName(input.repository)) throw Error(failure);
  const page = input.page ?? 1;
  const result = await run([
    "api",
    `repos/${input.repository}/branches?per_page=100&page=${page}`,
  ]);
  if (result.code !== 0) throw Error(failure);
  const rows = JSON.parse(result.stdout) as {
    name: string;
    protected: boolean;
  }[];
  return {
    items: rows.filter((branch) =>
      branch.name.toLowerCase().includes(input.query?.toLowerCase() ?? ""),
    ),
    defaultBranch: "",
    nextPage: rows.length === 100 ? page + 1 : null,
    truncated: false,
  };
}

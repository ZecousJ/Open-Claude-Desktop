const createPath =
  /^\/api\/github\/organizations\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/github_create_pr$/i;

export const officialCodePullRequestCreateMaxBytes = 192 * 1024;

export const officialCodePullRequestCreatePath = (organization: string) =>
  `/api/github/organizations/${organization}/github_create_pr`;

export function officialCodePullRequestCreate(method: string, path: string) {
  if (method === "POST") return createPath.exec(path)?.[1]?.toLowerCase();
}

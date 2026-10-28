/**
 * The web Code home's GitHub connection (package W-GITHUB). Nothing leaves
 * the page: the service is synthetic.
 *
 * `github=off` (the default) is a service where an administrator has not set
 * GitHub up. `connect`: set up, the person has not connected yet. `repos`:
 * connected, with 45 repositories (two private) and branches. `empty`:
 * connected and no repositories. `error`: connected, but GitHub fails.
 * Use with `cloud=code` (web-cloud.ts) on the web surface.
 */
import type {
  GitHubBranchesPage,
  GitHubRepositoriesPage,
  GitHubRepository,
  GitHubStatus,
} from "../../../shared/github-api";
import type { FixtureDomain } from "./index";

const repositories: GitHubRepository[] = Array.from(
  { length: 45 },
  (_, i) => {
    const name = i === 0 ? "claudex" : i === 1 ? "notes" : `project-${i}`;
    return {
      fullName: `ada/${name}`,
      name,
      owner: "ada",
      private: i === 1 || i === 7,
      description:
        i === 0
          ? "A Claude-like client"
          : i % 3 === 0
            ? "Experiments and scratch work"
            : "",
      defaultBranch: "main",
      cloneUrl: `https://github.com/ada/${name}.git`,
    };
  },
);
const branches = ["main", "develop", "feature/picker", "fix/askpass", "release"];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const webGithubFixture: FixtureDomain = {
  params: {
    github:
      "off (default: not set up) | connect | repos | empty | error: the GitHub connection",
  },
  bridge: ({ params }) => {
    const mode = params.get("github") ?? "off";
    let connected = mode === "repos" || mode === "empty" || mode === "error";
    const status = (): GitHubStatus =>
      mode === "off"
        ? { configured: false, connected: false }
        : connected
          ? { configured: true, connected: true, login: "ada" }
          : { configured: true, connected: false };
    return {
      githubStatus: async () => status(),
      githubConnect: async () => {
        connected = true;
        return { authorizeUrl: "https://github.com/login/oauth/authorize" };
      },
      githubDisconnect: async () => {
        connected = false;
        return status();
      },
      githubRepositories: async (input): Promise<GitHubRepositoriesPage> => {
        await wait(120);
        if (mode === "error")
          throw new Error("GitHub is temporarily unavailable. Try again.");
        if (mode === "empty")
          return { items: [], nextPage: null, truncated: false };
        const query = input?.query?.toLowerCase() ?? "";
        if (query)
          return {
            items: repositories.filter((r) =>
              r.fullName.toLowerCase().includes(query),
            ),
            nextPage: null,
            truncated: false,
          };
        const page = input?.page ?? 1;
        const items = repositories.slice((page - 1) * 30, page * 30);
        return {
          items,
          nextPage: page * 30 < repositories.length ? page + 1 : null,
          truncated: false,
        };
      },
      githubBranches: async (input): Promise<GitHubBranchesPage> => {
        await wait(120);
        const query = input.query?.toLowerCase() ?? "";
        return {
          defaultBranch: "main",
          items: branches
            .filter((b) => b.includes(query))
            .map((name) => ({ name, protected: name === "main" })),
          nextPage: null,
          truncated: false,
        };
      },
    };
  },
};

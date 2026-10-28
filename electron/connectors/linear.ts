import type { LinearIssue } from "../../shared/linear-api";

const unavailable = "Unable to load Linear issues.";
const fields = "identifier title url state { name color } team { name }";

export class LinearClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async graphql<T>(
    key: string,
    query: string,
    variables = {},
  ): Promise<T> {
    const response = await this.request("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw Error(unavailable);
    const result = (await response.json()) as { data?: T; errors?: unknown[] };
    if (result.errors?.length || !result.data) throw Error(unavailable);
    return result.data;
  }

  async connect(key: string) {
    const data = await this.graphql<{ viewer: { id: string } }>(
      key,
      "query { viewer { id } }",
    );
    if (!data.viewer?.id) throw Error(unavailable);
  }

  async issues(key: string, query: string): Promise<LinearIssue[]> {
    type Issue = Omit<LinearIssue, "state" | "team"> & {
      state?: { name?: string; color?: string };
      team?: { name?: string };
    };
    const data = query
      ? await this.graphql<{ issues: { nodes: Issue[] } }>(
          key,
          `query($query: String!) { issues: searchIssues(term: $query, first: 50) { nodes { ${fields} } } }`,
          { query },
        )
      : await this.graphql<{ viewer: { assignedIssues: { nodes: Issue[] } } }>(
          key,
          `query { viewer { assignedIssues(first: 50) { nodes { ${fields} } } } }`,
        );
    const issues =
      "issues" in data ? data.issues.nodes : data.viewer.assignedIssues.nodes;
    return issues.flatMap((issue) => {
      let address: URL;
      try {
        address = new URL(issue.url);
      } catch {
        return [];
      }
      if (
        address.protocol !== "https:" ||
        address.hostname !== "linear.app" ||
        address.username ||
        address.password
      )
        return [];
      return [
        {
          identifier: issue.identifier,
          title: issue.title || issue.identifier,
          url: address.href,
          state: issue.state?.name,
          stateColor: /^#[a-f\d]{6}$/i.test(issue.state?.color ?? "")
            ? issue.state?.color
            : undefined,
          team: issue.team?.name,
        },
      ];
    });
  }
}

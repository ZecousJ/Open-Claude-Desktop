import type { DynamicToolSpec } from "../../electron/engine/engine-extensions";

export const tools: Extract<DynamicToolSpec, { type: "namespace" }>["tools"] = [
  {
    type: "function",
    name: "push",
    description:
      "Push a branch of this session's repository to GitHub (never forced). Commit first. Defaults to the current branch, pushed under the same name.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Local branch to push" },
        remote_branch: {
          type: "string",
          description: "Branch name on GitHub (default: the same name)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_pull_request",
    description:
      "Open a pull request on this session's GitHub repository from a branch you pushed.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string", description: "The pushed branch" },
        base: {
          type: "string",
          description: "Target branch (default: the repository's default)",
        },
        draft: { type: "boolean" },
      },
      required: ["title", "head"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_issue",
    description: "Open an issue on this session's GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "comment",
    description:
      "Comment on an issue or pull request of this session's GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer" },
        body: { type: "string" },
      },
      required: ["number", "body"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_issue",
    description:
      "Read an issue or pull request of this session's GitHub repository, with its latest comments.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer" } },
      required: ["number"],
      additionalProperties: false,
    },
  },
];

/** The tools, with `repository` when the session has more than one. */
export function toolSpecs(several: boolean) {
  if (!several) return tools;
  return tools.map((tool) => {
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
    };
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: { ...schema.properties, repository: repositoryProperty },
      },
    };
  });
}

/** The `repository` argument a session with several repositories gets. */
export const repositoryProperty = {
  type: "string",
  description:
    "Which of this session's repositories, as owner/name (default: the session's main repository)",
};

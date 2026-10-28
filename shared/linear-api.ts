import { bridgeMethods } from "./bridge-methods";

export const linearMcpUrl = "https://mcp.linear.app/mcp";

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  state?: string;
  stateColor?: string;
  team?: string;
}

export interface LinearAPI {
  linearStatus(): Promise<{ connected: boolean }>;
  linearConnect(apiKey: string): Promise<void>;
  linearDisconnect(): Promise<void>;
  linearIssues(query?: string): Promise<LinearIssue[]>;
}

export const linearMethods = bridgeMethods<LinearAPI>({
  linearStatus: true,
  linearConnect: true,
  linearDisconnect: true,
  linearIssues: true,
});

// The issue's label and context.
export function linearIssueLabel(issue: LinearIssue) {
  return issue.title === issue.identifier
    ? issue.identifier
    : `${issue.identifier} ${issue.title}`;
}

export function withLinearIssue(text: string, issue?: LinearIssue) {
  return issue ? `${text}\n\nLinear issue: ${issue.url}`.trim() : text;
}

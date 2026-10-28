import { validRepositoryName } from "./github-parse";

export interface ChatGitHubLink {
  repository: string;
  branch: string;
}

export interface ChatGitHubRead extends ChatGitHubLink {
  path?: string;
}

export function chatGitHubLink(value: unknown): ChatGitHubLink | undefined {
  if (!value || typeof value !== "object") return;
  const { repository, branch } = value as ChatGitHubLink;
  if (
    typeof repository !== "string" ||
    repository.length > 140 ||
    !validRepositoryName(repository)
  )
    return;
  if (
    typeof branch !== "string" ||
    !branch ||
    branch.length > 200 ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
    /^[-/]|[/.]$|\.lock$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{")
  )
    return;
  return { repository, branch };
}

export function chatGitHubManifest(
  data: Uint8Array,
): ChatGitHubLink | undefined {
  if (data.byteLength > 2048) return;
  try {
    const value = JSON.parse(new TextDecoder().decode(data));
    return value.claudexGitHubRepository === true
      ? chatGitHubLink(value)
      : undefined;
  } catch {
    return;
  }
}

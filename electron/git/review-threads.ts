import fs from "node:fs";
import path from "node:path";
import { runGh, type GhRunner } from "./github-cli";
import { validRepositoryName } from "../../shared/github-parse";
import type {
  GitHubReviewComment,
  GitHubReviewThread,
} from "../../shared/github-api";
import { hasHiddenCharacters } from "../../shared/review-threads";

/**
 * A pull request's review threads in the Changes panel: read, replied to and
 * resolved with the machine's `gh`, and a reviewer's suggested change applied
 * to the file here when the lines it was written against are still there.
 */

export const reviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated path line startLine originalLine originalStartLine
        viewerCanReply viewerCanResolve
        comments(first: 50) { nodes {
          id databaseId body url diffHunk
          author { login avatarUrl }
        } }
      } }
    }
  }
}`;

type Json = any;

const commentOf = (node: Json): GitHubReviewComment | undefined =>
  typeof node?.id === "string" && typeof node.url === "string"
    ? {
        id: node.id,
        ...(typeof node.databaseId === "number"
          ? { databaseId: node.databaseId }
          : {}),
        author: String(node.author?.login ?? ""),
        ...(typeof node.author?.avatarUrl === "string"
          ? { avatarUrl: node.author.avatarUrl }
          : {}),
        body: String(node.body ?? ""),
        url: node.url,
        ...(typeof node.diffHunk === "string"
          ? { diffHunk: node.diffHunk }
          : {}),
      }
    : undefined;

export function reviewThreadsFrom(pull: Json): GitHubReviewThread[] {
  const threads: GitHubReviewThread[] = [];
  for (const node of (pull?.reviewThreads?.nodes ?? []) as Json[]) {
    if (typeof node?.id !== "string" || typeof node.path !== "string") continue;
    const comments = ((node.comments?.nodes ?? []) as Json[])
      .map(commentOf)
      .filter((comment): comment is GitHubReviewComment => Boolean(comment));
    if (!comments.length) continue;
    const line = typeof node.line === "number" ? node.line : undefined;
    const startLine =
      typeof node.startLine === "number" ? node.startLine : undefined;
    threads.push({
      id: node.id,
      resolved: node.isResolved === true,
      outdated: node.isOutdated === true || line === undefined,
      path: node.path,
      ...(line !== undefined ? { line } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      viewerCanReply: node.viewerCanReply !== false,
      viewerCanResolve: node.viewerCanResolve === true,
      comments,
    });
  }
  return threads;
}

export async function getReviewThreads(
  repository: string,
  number: number,
  run: GhRunner = runGh,
): Promise<GitHubReviewThread[] | null> {
  if (!validRepositoryName(repository)) return null;
  const [owner, name] = repository.split("/");
  const result = await run([
    "api",
    "graphql",
    "-f",
    `query=${reviewThreadsQuery}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  if (result.code !== 0) return null;
  try {
    return reviewThreadsFrom(
      JSON.parse(result.stdout)?.data?.repository?.pullRequest,
    );
  } catch {
    return null;
  }
}

const nodeId = /^[A-Za-z0-9_=-]{4,200}$/;

export async function replyToReviewThread(
  threadId: string,
  body: string,
  run: GhRunner = runGh,
): Promise<GitHubReviewComment> {
  if (!nodeId.test(threadId))
    throw new Error("This thread can't be replied to.");
  const result = await run([
    "api",
    "graphql",
    "-f",
    "query=mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id databaseId body url author { login avatarUrl } } } }",
    "-f",
    `id=${threadId}`,
    "-f",
    `body=${body}`,
  ]);
  const comment =
    result.code === 0
      ? commentOf(
          JSON.parse(result.stdout)?.data?.addPullRequestReviewThreadReply
            ?.comment,
        )
      : undefined;
  if (!comment) throw new Error("Couldn’t send the reply. Try again.");
  return comment;
}

export async function resolveReviewThread(
  threadId: string,
  run: GhRunner = runGh,
) {
  if (!nodeId.test(threadId)) throw new Error("This thread can't be resolved.");
  const result = await run([
    "api",
    "graphql",
    "-f",
    "query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }",
    "-f",
    `id=${threadId}`,
  ]);
  if (result.code !== 0)
    throw new Error("Couldn’t resolve this thread. Try again.");
}

export type ApplySuggestionResult =
  | { ok: true }
  | { ok: false; reason: "changed" | "denied" | "hidden" | "moved" };

/**
 * Replaces lines startLine..endLine of the file (inside `top`) with the
 * suggestion, when they still read `original`.
 */
export function applySuggestion(
  top: string,
  input: {
    path: string;
    startLine: number;
    endLine: number;
    original: string;
    suggestion: string;
  },
): ApplySuggestionResult {
  if (hasHiddenCharacters(input.suggestion))
    return { ok: false, reason: "hidden" };
  const root = path.resolve(top);
  const file = path.resolve(root, input.path);
  if (!file.startsWith(root + path.sep)) return { ok: false, reason: "denied" };
  let text: string;
  try {
    if (fs.lstatSync(file).isSymbolicLink())
      return { ok: false, reason: "denied" };
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "changed" };
  }
  const crlf = text.includes("\r\n");
  const trailing = /\r?\n$/.test(text);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (trailing) lines.pop();
  const want = input.original.replace(/\r\n/g, "\n").split("\n");
  const at = input.startLine - 1;
  const span = input.endLine - input.startLine + 1;
  if (at < 0 || span !== want.length) return { ok: false, reason: "changed" };
  const matches = (from: number) =>
    want.every((line, i) => lines[from + i] === line);
  if (!matches(at)) {
    // The same lines elsewhere: a newer commit moved the comment.
    for (let i = 0; i + span <= lines.length; i++)
      if (matches(i)) return { ok: false, reason: "moved" };
    return { ok: false, reason: "changed" };
  }
  const replacement = input.suggestion
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "");
  lines.splice(at, span, ...(replacement ? replacement.split("\n") : []));
  const out = lines.join("\n") + (trailing ? "\n" : "");
  try {
    fs.writeFileSync(file, crlf ? out.replace(/\n/g, "\r\n") : out);
  } catch {
    return { ok: false, reason: "denied" };
  }
  return { ok: true };
}

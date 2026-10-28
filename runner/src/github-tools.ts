/**
 * GitHub tools of a cloud Code session: the model can push its commits, open a
 * pull request or an issue, comment, and read an issue or pull request of the
 * session's repository. The sandbox cannot reach GitHub and never sees a
 * credential:
 *
 * - pushing runs here, outside the sandbox, with a credential the service
 *   leases for that one push (`github.push`). Git never runs inside the
 *   session's folder (its hooks and config are the model's to change): the
 *   branch is fetched from the folder into a fresh repository of our own and
 *   pushed from there, without force. A folder whose repository reaches outside
 *   it (a linked .git, objects or alternates) is refused;
 * - the other actions are made by the service with the user's own token
 *   (`github.api`);
 * - the repository is the session's: the address in the folder's .git/config
 *   must be the one its space was made for (the space id is the address's
 *   hash), so the model cannot point the tools elsewhere;
 * - a session with several repositories (Conversation.sessionRepositories, set
 *   by the runner) names another one with `repository` ("owner/name"): its
 *   checkout is the folder directly inside the session's whose origin is that
 *   repository (runner/src/code-workspace.ts extraRepositoryFolders).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DynamicToolCall,
  DynamicToolResult,
  EngineExtension,
} from "../../electron/engine/engine-extensions";
import type { WorkingTreeHost } from "../../electron/git/working-tree";
import { sessionRepositoryOf } from "../../shared/session-git";
import type { Conversation, Turn } from "../../shared/types";
import type { StoreTransport } from "./cloud-store";
import { repositoryKey } from "./code-workspace";
import {
  askpass,
  parseCloneGrant,
  repositorySpaceId,
  runGit as defaultRunGit,
  scrub,
  type RunGit,
} from "./github-workspace";
import {
  adoptTaggedPullRequests,
  applyGitFacts,
  branchCommit,
  pullRequestFromApi,
  readGitFacts,
  recordPullRequest,
  recordPush,
  refreshPullRequests,
} from "./session-git";
import { toolSpecs } from "./github-tool-specs";

const namespace = "github";

/** "owner/name" of a repository address (lower case). */
export function ownerAndName(url: string) {
  try {
    return new URL(repositoryKey(url)).pathname.replace(/^\/+/, "");
  } catch {
    return "";
  }
}

/** Branch names safe as git arguments (git's own rules, roughly). */
export function validBranch(name: string) {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("@{") &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(name)
  );
}

/** The `url` of [remote "origin"] in a git config text. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (match) return match[1]!.trim().replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}

const isLink = (target: string) => {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * The folder's repository, refused when it reaches outside the folder: the
 * push's fetch reads its objects on this host.
 */
export function ownRepository(cwd: string) {
  const git = path.join(cwd, ".git");
  const stat = fs.lstatSync(git, { throwIfNoEntry: false });
  if (!stat?.isDirectory())
    throw new Error("This session's folder isn't a git repository of its own.");
  for (const name of ["objects", "refs", "HEAD", "config", "packed-refs"])
    if (isLink(path.join(git, name)))
      throw new Error("The repository links outside its folder.");
  for (const name of [
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ])
    if (fs.existsSync(path.join(git, name)))
      throw new Error(
        "The repository borrows objects from outside its folder.",
      );
  // No link anywhere under objects or refs (a pack linked from elsewhere).
  let seen = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++seen > 500_000)
        throw new Error("The repository is too large to push here.");
      if (entry.isSymbolicLink())
        throw new Error("The repository links outside its folder.");
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };
  walk(path.join(git, "objects"));
  walk(path.join(git, "refs"));
  return git;
}

export interface GitHubToolsOptions {
  userId: number;
  transport: StoreTransport;
  runGit?: RunGit;
  tempRoot?: string;
  /**
   * The user's sandboxed working-tree reader. With it the session records
   * its branch and git state after each turn (runner/src/session-git.ts).
   */
  workingTree?: () => WorkingTreeHost | undefined;
}

/**
 * The repository a tool acts on, checked against the session: its main one
 * (the address its space was made for), or, named by `repository`, one of
 * the others added to the session.
 */
export function sessionRepository(call: DynamicToolCall, which = "") {
  const c = call.conversation;
  const spaceId = c.environment?.kind === "space" ? c.environment.spaceId : "";
  if (!spaceId.startsWith("r-") || !c.cwd)
    throw new Error("This session has no GitHub repository.");
  const git = path.join(c.cwd, ".git");
  const url = originUrl(fs.readFileSync(path.join(git, "config"), "utf8"));
  if (!url || repositorySpaceId(url) !== spaceId)
    throw new Error(
      "The repository's origin no longer matches the session's repository; set it back to push or use GitHub.",
    );
  const wanted = which
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!wanted || wanted === ownerAndName(url)) return { url, cwd: c.cwd };
  const other = (c.sessionRepositories ?? [])
    .slice(1)
    .find((repository) => ownerAndName(repository.url) === wanted);
  if (!other)
    throw new Error(
      `${which.trim()} isn't one of this session's repositories.`,
    );
  // Its checkout: a folder directly inside the session's (never a link)
  // whose origin is that repository.
  for (const entry of fs.readdirSync(c.cwd, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const folder = path.join(c.cwd, entry.name);
    const config = path.join(folder, ".git", "config");
    if (
      !fs
        .lstatSync(path.join(folder, ".git"), { throwIfNoEntry: false })
        ?.isDirectory() ||
      isLink(config)
    )
      continue;
    let origin: string | undefined;
    try {
      origin = originUrl(fs.readFileSync(config, "utf8"));
    } catch {
      continue;
    }
    if (origin && repositoryKey(origin) === repositoryKey(other.url))
      return { url: origin, cwd: folder };
  }
  throw new Error(
    `${which.trim()} isn't in this session's folder any more, or its origin was changed.`,
  );
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const result = (value: unknown, success = true): DynamicToolResult => ({
  contentItems: [
    {
      type: "inputText",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  success,
});

/**
 * Settings → Create pull requests automatically (and Create as draft): after
 * a push to a branch other than the default one the session opens its pull
 * request without asking, unless the branch already has one.
 */
export function autoPullRequestStep(
  kind: "ready" | "draft" | undefined,
  branch: string,
  base: string,
): { next?: string } {
  if (!kind || branch === base) return {};
  return {
    next:
      kind === "draft"
        ? `The user's settings open a pull request after every push, as a draft. If ${branch} has no open pull request yet, open one now with create_pull_request (draft true, base ${base}) without asking.`
        : `The user's settings open a pull request after every push. If ${branch} has no open pull request yet, open one now with create_pull_request (draft false, base ${base}) without asking.`,
  };
}

/** The extension that offers and answers the tools. */
export function gitHubTools(options: GitHubToolsOptions): EngineExtension {
  const run = options.runGit ?? defaultRunGit;
  const push = async (call: DynamicToolCall, args: Record<string, unknown>) => {
    const { url, cwd } = sessionRepository(call, text(args.repository));
    const git = ownRepository(cwd);
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    const current = head.startsWith("ref: refs/heads/")
      ? head.slice("ref: refs/heads/".length)
      : "";
    const branch = text(args.branch).trim() || current;
    if (!branch) throw new Error("HEAD is detached: name the branch to push.");
    const target = text(args.remote_branch).trim() || branch;
    if (!validBranch(branch) || !validBranch(target))
      throw new Error("That branch name isn't valid.");
    const grant = parseCloneGrant(
      await options.transport.request("github.push", options.userId, { url }),
    );
    const budget = Math.min(10 * 60_000, grant.expiresAt - Date.now());
    if (budget <= 0) throw new Error("The push credential expired.");
    const temp = fs.mkdtempSync(
      path.join(options.tempRoot ?? os.tmpdir(), "claudex-push-"),
    );
    fs.chmodSync(temp, 0o700);
    try {
      const helper = path.join(temp, "askpass.sh");
      fs.writeFileSync(helper, askpass, { mode: 0o700 });
      const own = path.join(temp, "repo.git");
      const base = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: temp,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      };
      const signal = AbortSignal.timeout(budget);
      const step = async (argv: string[], env: Record<string, string>) => {
        const out = await run({ argv, env, signal });
        if (out.code !== 0)
          throw new Error(
            `Couldn't push ${branch}: ${scrub(out.stderr, [grant.token]) || "git failed"}`,
          );
      };
      await step(["init", "--bare", "--quiet", own], base);
      // The branch's commits from the session's folder (read only).
      await step(
        [
          "-C",
          own,
          "-c",
          "protocol.file.allow=always",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          `file://${git}`,
          `refs/heads/${branch}:refs/heads/${branch}`,
        ],
        base,
      );
      await step(
        [
          "-C",
          own,
          "-c",
          "credential.helper=",
          "-c",
          `core.hooksPath=${os.devNull}`,
          "push",
          "--quiet",
          "--",
          grant.url,
          `refs/heads/${branch}:refs/heads/${target}`,
        ],
        {
          ...base,
          GIT_ASKPASS: helper,
          CLAUDEX_GIT_USERNAME: grant.username,
          CLAUDEX_GIT_TOKEN: grant.token,
        },
      );
      // Told to the session's lists: the folder's own remote-tracking refs do
      // not move when the push runs outside the sandbox.
      if (cwd === call.conversation.cwd) {
        recordPush(call.conversation, branch, branchCommit(git, branch));
        call.changed();
      }
      const web = grant.url.replace(/\.git$/, "");
      const baseBranch = grant.defaultBranch || "main";
      return {
        pushed: `${branch} → ${grant.repository}:${target}`,
        branch: target,
        branch_url: `${web}/tree/${encodeURI(target)}`,
        compare_url: `${web}/compare/${encodeURI(baseBranch)}...${encodeURI(target)}`,
        ...autoPullRequestStep(
          call.conversation.autoPullRequest,
          target,
          baseBranch,
        ),
      };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };
  const api = async (call: DynamicToolCall, body: Record<string, unknown>) => {
    const args = call.arguments as Record<string, unknown> | undefined;
    const { url } = sessionRepository(call, text(args?.repository));
    return options.transport.request("github.api", options.userId, {
      url,
      ...body,
    });
  };
  const refreshing = new Set<string>();
  /**
   * After a turn: the session's repository (older sessions lack it), its
   * branch and git state, the pull requests it named and their states. True
   * when the conversation changed.
   */
  const refreshSession = async (conversation: Conversation, turn: Turn) => {
    let updated = false;
    if (!conversation.repository && conversation.cwd) {
      try {
        const origin = originUrl(
          fs.readFileSync(
            path.join(conversation.cwd, ".git", "config"),
            "utf8",
          ),
        );
        const repository = origin
          ? sessionRepositoryOf({ url: origin })
          : undefined;
        if (repository) {
          conversation.repository = repository;
          updated = true;
        }
      } catch {
        // No readable origin: the lists show no repository.
      }
    }
    const host = options.workingTree?.();
    if (host && conversation.cwd) {
      const facts = await readGitFacts(
        conversation.cwd,
        host,
        conversation.gitState?.pushed,
      );
      if (facts && applyGitFacts(conversation, facts)) updated = true;
    }
    if (
      await adoptTaggedPullRequests(
        conversation,
        turn,
        options.transport,
        options.userId,
      )
    )
      updated = true;
    if (
      await refreshPullRequests(conversation, options.transport, options.userId)
    )
      updated = true;
    return updated;
  };
  return {
    id: "github-tools",
    dynamicTools(ctx) {
      const environment = ctx.conversation.environment;
      if (
        ctx.mode !== "code" ||
        environment?.kind !== "space" ||
        !environment.spaceId.startsWith("r-")
      )
        return undefined;
      const others = (ctx.conversation.sessionRepositories ?? [])
        .slice(1)
        .map((repository) => ownerAndName(repository.url))
        .filter(Boolean);
      return [
        {
          type: "namespace",
          name: namespace,
          description: others.length
            ? `This session's GitHub repositories: push, pull requests, issues and comments. The main one is the session's folder; ${others.join(", ")} ${others.length === 1 ? "is a folder" : "are folders"} inside it, named with \`repository\`.`
            : "This session's GitHub repository: push, pull requests, issues and comments.",
          tools: toolSpecs(others.length > 0),
        },
      ];
    },
    onTurnCompleted(conversation, turn, changed) {
      if (!options.workingTree) return;
      const environment = conversation.environment;
      if (
        conversation.mode !== "code" ||
        environment?.kind !== "space" ||
        !environment.spaceId.startsWith("r-") ||
        !conversation.cwd ||
        refreshing.has(conversation.id)
      )
        return;
      refreshing.add(conversation.id);
      void refreshSession(conversation, turn)
        .then((updated) => {
          if (updated) changed();
        })
        .catch(() => {
          // A failed read leaves the last one standing.
        })
        .finally(() => refreshing.delete(conversation.id));
    },
    async handleDynamicTool(call) {
      if (call.namespace !== namespace) return undefined;
      const args =
        call.arguments && typeof call.arguments === "object"
          ? (call.arguments as Record<string, unknown>)
          : {};
      try {
        switch (call.tool) {
          case "push":
            return result(await push(call, args));
          case "create_pull_request": {
            const created = await api(call, {
              action: "pr.create",
              title: text(args.title),
              body: text(args.body),
              head: text(args.head),
              base: text(args.base),
              draft: args.draft === true,
            });
            // The session's lists know its pull request (shared/session-git.ts).
            const pr = pullRequestFromApi(created, {
              headRef: text(args.head),
            });
            if (pr) {
              recordPullRequest(call.conversation, pr);
              call.changed();
            }
            return result(created);
          }
          case "create_issue":
            return result(
              await api(call, {
                action: "issue.create",
                title: text(args.title),
                body: text(args.body),
                labels: Array.isArray(args.labels)
                  ? args.labels.filter((l) => typeof l === "string")
                  : [],
              }),
            );
          case "comment":
            return result(
              await api(call, {
                action: "comment.create",
                number: Number(args.number),
                body: text(args.body),
              }),
            );
          case "get_issue":
            return result(
              await api(call, {
                action: "issue.get",
                number: Number(args.number),
              }),
            );
          default:
            return result(`Unknown GitHub tool: ${call.tool}`, false);
        }
      } catch (error) {
        return result(
          error instanceof Error ? error.message : String(error),
          false,
        );
      }
    },
  };
}

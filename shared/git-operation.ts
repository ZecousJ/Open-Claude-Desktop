/**
 * Git and pull request actions in a Code transcript (the official ccr rows
 * "Created PR #12", "Pushed to main", "Committed 1a2b3c4", "Rebased onto
 * origin/main"). The official Claude Code CLI reports a `gitOperation` with its
 * Bash result; Codex reports none, so Claudex works it out from what the
 * session ran:
 *
 * - a GitHub tool call of a cloud session (`github` namespace: push,
 *   create_pull_request, comment) knows its branch and pull request;
 * - a Bash command is read as shell words (quotes, heredocs and `&&` chains
 *   respected, so text inside a commit message never counts) and its output
 *   gives the commit hash or pull request number. A command that failed, or
 *   that still runs, is no operation.
 *
 * Pure functions, shared by the phones' transcript (the web and desktop keep
 * their own rows).
 */
import type { Item } from "./types";

export type PullRequestAction =
  "created" | "edited" | "merged" | "commented" | "closed" | "ready";
export type CommitKind = "committed" | "amended" | "cherry-picked";

export type GitOperation =
  | { kind: "pr"; action: PullRequestAction; meta: string; url?: string }
  | { kind: "push"; meta: string }
  | { kind: "branch"; action: "merged" | "rebased"; meta: string }
  | { kind: "commit"; commitKind: CommitKind; meta: string };

/** The row's verb (source English; the transcript translates it). */
export function gitOperationVerb(operation: GitOperation): string {
  switch (operation.kind) {
    case "pr":
      return {
        created: "Created PR",
        edited: "Edited PR",
        merged: "Merged PR",
        commented: "Commented on PR",
        closed: "Closed PR",
        ready: "Marked ready PR",
      }[operation.action];
    case "push":
      return "Pushed to";
    case "branch":
      return operation.action === "merged" ? "Merged" : "Rebased onto";
    case "commit":
      return {
        committed: "Committed",
        amended: "Amended commit",
        "cherry-picked": "Cherry-picked",
      }[operation.commitKind];
  }
}

/* ------------------------------------------------------------------ */
/* Shell words                                                         */
/* ------------------------------------------------------------------ */

/** Skips a `$( ... )` whose "(" is at `at`; returns the index after its ")". */
function skipSubstitution(source: string, at: number): number {
  let depth = 1;
  let i = at + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (c === "'") {
      i = source.indexOf("'", i + 1);
      if (i < 0) return source.length;
    } else if (c === '"') {
      i = skipDouble(source, i);
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return source.length;
}

/** Skips a double-quoted string starting at `at`; returns its closing quote. */
function skipDouble(source: string, at: number): number {
  for (let i = at + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (c === "$" && source[i + 1] === "(")
      i = skipSubstitution(source, i + 1) - 1;
    else if (c === '"') return i;
  }
  return source.length;
}

/**
 * The simple commands of a shell script as words. Operators (`;`, `&&`, `||`,
 * `|`, `&`, newlines, parentheses) end a command; quotes group a word;
 * heredoc bodies and comments are skipped.
 */
export function shellCommands(script: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < script.length) {
    const c = script[i]!;
    if (c === "\\") {
      if (script[i + 1] === "\n") i += 2;
      else {
        word = (word ?? "") + (script[i + 1] ?? "");
        i += 2;
      }
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      const stop = end < 0 ? script.length : end;
      word = (word ?? "") + script.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      const end = skipDouble(script, i);
      word = (word ?? "") + script.slice(i + 1, end);
      i = end + 1;
    } else if (c === "$" && script[i + 1] === "(") {
      // A substitution is part of the word it sits in.
      const end = skipSubstitution(script, i + 1);
      word = (word ?? "") + script.slice(i, end);
      i = end;
    } else if (c === "#" && word === undefined) {
      while (i < script.length && script[i] !== "\n") i++;
    } else if (c === "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
      // A heredoc: its body follows the line and is not a command.
      let j = i + 2;
      const strip = script[j] === "-";
      if (strip) j++;
      while (script[j] === " " || script[j] === "\t") j++;
      let delimiter = "";
      const quote = script[j] === "'" || script[j] === '"' ? script[j] : "";
      if (quote) j++;
      while (
        j < script.length &&
        (quote ? script[j] !== quote : !/[\s;&|()<>]/.test(script[j]!))
      )
        delimiter += script[j++];
      if (quote) j++;
      if (delimiter) heredocs.push({ delimiter, strip });
      endWord();
      i = j;
    } else if (c === "\n") {
      endCommand();
      i++;
      for (const doc of heredocs.splice(0)) {
        while (i < script.length) {
          const eol = script.indexOf("\n", i);
          const line = script.slice(i, eol < 0 ? script.length : eol);
          i = eol < 0 ? script.length : eol + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter)
            break;
        }
      }
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endCommand();
      i++;
    } else if (c === "{" || c === "}") {
      // A group brace on its own is syntax; inside a word it is text.
      if (word === undefined) {
        endCommand();
        i++;
      } else {
        word += c;
        i++;
      }
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  endCommand();
  return commands;
}

/** A shell wrapper's script: `bash -lc "..."` gives the quoted text. */
export function shellScript(command: string): string {
  const [first] = shellCommands(command.trim());
  const words = first ?? [];
  const program = words[0]?.split("/").at(-1) ?? "";
  if (/^(?:ba|z|da|k|a)?sh$/.test(program)) {
    const flag = words.findIndex(
      (word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word),
    );
    if (flag > 0 && words[flag + 1] !== undefined) {
      // The script is the rest of the command text after the flag.
      return words[flag + 1]!;
    }
  }
  return command;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

const prefixes = new Set([
  "command",
  "builtin",
  "exec",
  "time",
  "nohup",
  "env",
  "sudo",
  "if",
  "then",
  "do",
  "else",
  "elif",
  "while",
  "until",
  "!",
]);

/** Git options before the subcommand that take the next word as a value. */
const globalValueOptions = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

function stripPrefix(words: string[]): string[] {
  let i = 0;
  while (
    i < words.length &&
    (prefixes.has(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!))
  )
    i++;
  return words.slice(i);
}

/** `git <subcommand> args`; undefined for another program. */
function gitCommand(words: string[]) {
  if (words[0] !== "git" && !words[0]?.endsWith("/git")) return undefined;
  let i = 1;
  while (i < words.length && words[i]!.startsWith("-")) {
    const option = words[i]!;
    i += globalValueOptions.has(option) ? 2 : 1;
  }
  const subcommand = words[i];
  return subcommand ? { subcommand, args: words.slice(i + 1) } : undefined;
}

/** Options of a git subcommand that take a separate value, by subcommand. */
const valueOptions: Record<string, Set<string>> = {
  commit: new Set([
    "-m",
    "-F",
    "-C",
    "-c",
    "-t",
    "--message",
    "--file",
    "--author",
    "--date",
    "--template",
    "--reuse-message",
    "--reedit-message",
    "--cleanup",
    "--trailer",
  ]),
  push: new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]),
  rebase: new Set([
    "--onto",
    "-s",
    "--strategy",
    "-X",
    "--strategy-option",
    "-x",
    "--exec",
    "--empty",
  ]),
  merge: new Set([
    "-m",
    "-F",
    "-s",
    "--strategy",
    "-X",
    "--strategy-option",
    "--file",
    "--into-name",
    "--message",
  ]),
};

/** The words that are not options (or option values) of a subcommand. */
function positionals(subcommand: string, args: string[]) {
  const takesValue = valueOptions[subcommand] ?? new Set<string>();
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      found.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (takesValue.has(arg)) i++;
      continue;
    }
    found.push(arg);
  }
  return found;
}

const hasOption = (args: string[], ...names: string[]) =>
  args.some((arg) => names.includes(arg));

/** The branch a push sent: the last refspec's target, or its name. */
function pushedBranch(args: string[]): string | undefined {
  if (
    hasOption(
      args,
      "--delete",
      "-d",
      "--dry-run",
      "-n",
      "--tags",
      "--all",
      "--mirror",
    )
  )
    return undefined;
  const [, ...refspecs] = positionals("push", args);
  const last = refspecs.at(-1);
  if (!last) return undefined;
  const target = (last.includes(":") ? last.split(":").at(-1)! : last)
    .replace(/^\+/, "")
    .replace(/^refs\/heads\//, "");
  return target && target !== "HEAD" && !target.startsWith("-")
    ? target
    : undefined;
}

/** The commit hash a `git commit` / `cherry-pick` reported: "[branch 1a2b3c4] message". */
function reportedCommit(output: string): string | undefined {
  let found: string | undefined;
  for (const match of output.matchAll(/^\[[^\]\n]+? ([0-9a-f]{7,40})\]/gm))
    found = match[1];
  return found?.slice(0, 7);
}

/** The pull request number a `gh` command mentioned (its address, or "#12"). */
function reportedPullRequest(output: string): number | undefined {
  let found: number | undefined;
  for (const match of output.matchAll(/\/pull\/(\d+)/g))
    found = Number(match[1]);
  if (found) return found;
  for (const match of output.matchAll(/[Pp]ull request #(\d+)/g))
    found = Number(match[1]);
  return found;
}

const ghActions: Record<string, PullRequestAction> = {
  create: "created",
  edit: "edited",
  merge: "merged",
  comment: "commented",
  close: "closed",
  ready: "ready",
};

/** `gh pr <action> ...` */
function ghCommand(words: string[], output: string): GitOperation | undefined {
  if (words[0] !== "gh" && !words[0]?.endsWith("/gh")) return undefined;
  const rest = words.slice(1).filter((word, index, all) => {
    // `-R owner/name` before the group is not part of the command.
    return !(word === "-R" || all[index - 1] === "-R");
  });
  if (rest[0] !== "pr") return undefined;
  const action = ghActions[rest[1] ?? ""];
  if (!action) return undefined;
  const args = rest.slice(2);
  if (hasOption(args, "--help", "-h", "--web", "-w")) return undefined;
  if (action === "ready" && hasOption(args, "--undo")) return undefined;
  let number = reportedPullRequest(output);
  if (!number) {
    const word = args.find((arg) => /^\d+$/.test(arg));
    if (word) number = Number(word);
  }
  if (!number) return undefined;
  const url = /https?:\/\/\S+\/pull\/\d+/.exec(output)?.[0];
  return { kind: "pr", action, meta: `#${number}`, ...(url ? { url } : {}) };
}

/** The operations a script performed, in order. */
export function scriptOperations(
  script: string,
  output: string,
): GitOperation[] {
  const found: GitOperation[] = [];
  for (const raw of shellCommands(script)) {
    const words = stripPrefix(raw);
    const pr = ghCommand(words, output);
    if (pr) {
      found.push(pr);
      continue;
    }
    const git = gitCommand(words);
    if (!git) continue;
    const { subcommand, args } = git;
    if (
      hasOption(args, "--help", "-h", "--dry-run", "-n") &&
      subcommand !== "rebase"
    )
      continue;
    switch (subcommand) {
      case "commit": {
        const commit = reportedCommit(output);
        if (commit)
          found.push({
            kind: "commit",
            commitKind: hasOption(args, "--amend") ? "amended" : "committed",
            meta: commit,
          });
        break;
      }
      case "cherry-pick": {
        if (hasOption(args, "--abort", "--continue", "--skip", "--quit")) break;
        const commit = reportedCommit(output);
        if (commit)
          found.push({
            kind: "commit",
            commitKind: "cherry-picked",
            meta: commit,
          });
        break;
      }
      case "push": {
        const branch = pushedBranch(args);
        if (branch) found.push({ kind: "push", meta: branch });
        break;
      }
      case "rebase": {
        if (
          hasOption(
            args,
            "--abort",
            "--continue",
            "--skip",
            "--quit",
            "--edit-todo",
            "--show-current-patch",
          )
        )
          break;
        const onto = args.findIndex((arg) => arg === "--onto");
        const target =
          onto >= 0 && args[onto + 1]
            ? args[onto + 1]
            : positionals("rebase", args)[0];
        if (target)
          found.push({ kind: "branch", action: "rebased", meta: target });
        break;
      }
      case "merge": {
        if (hasOption(args, "--abort", "--continue", "--quit")) break;
        if (/Already up to date/i.test(output)) break;
        const target = positionals("merge", args).at(-1);
        if (target)
          found.push({ kind: "branch", action: "merged", meta: target });
        break;
      }
    }
  }
  return found;
}

/** Official order: a pull request, a push, a branch operation, then a commit. */
const order: GitOperation["kind"][] = ["pr", "push", "branch", "commit"];

/* ------------------------------------------------------------------ */
/* Transcript items                                                    */
/* ------------------------------------------------------------------ */

const textOf = (value: unknown) => (typeof value === "string" ? value : "");

function toolResult(item: Item): Record<string, unknown> | undefined {
  const text = (Array.isArray(item.contentItems) ? item.contentItems : [])
    .map((entry: any) =>
      entry?.type === "inputText" ? textOf(entry.text) : "",
    )
    .join("");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function githubOperation(item: Item): GitOperation | undefined {
  if (item.success === false) return undefined;
  const result = toolResult(item);
  const args =
    item.arguments && typeof item.arguments === "object"
      ? (item.arguments as Record<string, unknown>)
      : {};
  if (item.tool === "push") {
    const fromUrl = /\/tree\/([^?#]+)$/.exec(textOf(result?.branch_url))?.[1];
    let branch = textOf(result?.branch);
    if (!branch && fromUrl) {
      try {
        branch = decodeURIComponent(fromUrl);
      } catch {
        branch = fromUrl;
      }
    }
    branch ||= textOf(args.remote_branch) || textOf(args.branch);
    return result && branch ? { kind: "push", meta: branch } : undefined;
  }
  if (item.tool === "create_pull_request") {
    const number = Number(result?.number);
    return Number.isInteger(number) && number > 0
      ? {
          kind: "pr",
          action: "created",
          meta: `#${number}`,
          ...(typeof result?.html_url === "string"
            ? { url: result.html_url }
            : {}),
        }
      : undefined;
  }
  if (item.tool === "comment") {
    // A comment on a pull request has the request's address in its own.
    const match = /\/pull\/(\d+)(?:[#?]|$)/.exec(textOf(result?.html_url));
    return match
      ? { kind: "pr", action: "commented", meta: `#${match[1]}` }
      : undefined;
  }
  return undefined;
}

const finished = (item: Item) =>
  item.lifecycleStatus !== "inProgress" &&
  item.lifecycleStatus !== "failed" &&
  item.lifecycleStatus !== "interrupted" &&
  item.status !== "inProgress" &&
  item.status !== "failed" &&
  item.status !== "declined" &&
  item.status !== "interrupted" &&
  (typeof item.exitCode === "number"
    ? item.exitCode === 0
    : item.status === "completed" || item.lifecycleStatus === "completed");

/**
 * The git or pull request action a finished tool call performed, if any:
 * what the phones' row words as "Created PR #12" in place of "Ran a command".
 */
export function gitOperationOf(item: Item): GitOperation | undefined {
  if (item.type === "dynamicToolCall") {
    if (item.namespace !== "github") return undefined;
    if (item.lifecycleStatus && item.lifecycleStatus !== "completed")
      return undefined;
    return githubOperation(item);
  }
  if (item.type !== "commandExecution" || typeof item.command !== "string")
    return undefined;
  if (!finished(item)) return undefined;
  const operations = scriptOperations(
    shellScript(item.command),
    textOf(item.aggregatedOutput),
  );
  for (const kind of order) {
    const same = operations.filter((operation) => operation.kind === kind);
    if (same.length) return same.at(-1);
  }
  return undefined;
}

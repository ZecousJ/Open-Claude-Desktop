import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  askpass,
  parseCloneGrant,
  scrub,
  type CloneGrant,
} from "../../shared/git-lease";
import type { CloudPushFailure } from "../../shared/cloud-continue-api";
import type { RepositoryRef } from "../../shared/host";
import { validBranch, fileUrl, snapshotSubject } from "./continue-in-cloud";

/**
 * The note the cloud session's first message starts with: where its checkout
 * came from.
 */
export function transportPreamble(work: {
  branch: string;
  snapshot: boolean;
  tip: string;
  aheadOfUpstream?: number;
}) {
  const from = work.branch
    ? `the desktop's \`${work.branch}\` branch`
    : "the desktop's checkout";
  const lines = ["[Moved from the Claudex desktop app]"];
  lines.push(
    work.snapshot
      ? `This repository was checked out from ${from} exactly as it was, and the uncommitted changes came along as the top commit ${work.tip.slice(0, 12)} ("${snapshotSubject}"). That commit was never made on the desktop: treat its contents as work in progress, and fold it into your next real commit (\`git commit --amend\`) or unstage it first (\`git reset --mixed HEAD~1\`) rather than pushing it as is.`
      : `This repository was checked out from ${from} exactly as it was, including commits that were not pushed yet.`,
  );
  if (work.aheadOfUpstream && work.aheadOfUpstream > 0)
    lines.push(
      `${work.aheadOfUpstream} commit(s) under it had not been pushed from the desktop; they are only here and on the desktop until this branch is pushed.`,
    );
  return lines.join("\n");
}

/** One git process of the upload (argv, environment, its time budget). */
export interface PushRun {
  argv: string[];
  env: Record<string, string>;
  signal: AbortSignal;
}

export type PushGit = (
  run: PushRun,
) => Promise<{ code: number; stdout?: string; stderr: string }>;

const runPushGit: PushGit = ({ argv, env, signal }) =>
  new Promise((resolve) => {
    execFile(
      "git",
      argv,
      { env, signal, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : signal.aborted
                ? 124
                : 1;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr) || error?.message || "",
        });
      },
    );
  });

/** An upload that did not happen, with git's own words (scrubbed) to show. */
export class CloudPushError extends Error {
  constructor(
    readonly failure: CloudPushFailure,
    message: string,
    readonly excerpt?: string,
    readonly command?: string,
  ) {
    super(message);
  }
}

/** The upload failure's words. */
export const uploadFailureMessages: Record<CloudPushFailure, string> = {
  auth: "The remote didn’t accept the upload from this app. Your terminal’s git may be signed in differently.",
  network:
    "Couldn’t reach the remote to upload your work. Check your internet (and VPN or proxy).",
  remote_rejected: "The remote rejected the upload.",
  timed_out: "Uploading your work took too long and was stopped.",
  non_fast_forward: "Couldn’t upload your work.",
  unknown: "Couldn’t upload your work.",
};

/** Which failure git's words describe. */
export function classifyPushFailure(
  stderr: string,
  timedOut: boolean,
): CloudPushFailure {
  if (timedOut) return "timed_out";
  const text = stderr.toLowerCase();
  if (/non-fast-forward|fetch first|\[rejected\].*(behind|stale)/.test(text))
    return "non_fast_forward";
  if (
    /authentication failed|could not read username|permission to .* denied|403|401|invalid username or password/.test(
      text,
    )
  )
    return "auth";
  if (
    /could not resolve host|failed to connect|connection (timed out|refused|reset)|network is unreachable|ssl|tls/.test(
      text,
    )
  )
    return "network";
  if (
    /\[remote rejected\]|pre-receive hook declined|protected branch/.test(text)
  )
    return "remote_rejected";
  return "unknown";
}

export interface UploadOptions {
  /** The folder's shared git directory (`commonGitDir`). */
  gitDir: string;
  /** The saved work and where it came from. */
  tip: string;
  snapshot: boolean;
  branch: string;
  /** "owner/name": the repository origin names. */
  repository: string;
  /** The session's own ref (`transportRef`). */
  ref: string;
  /** The service's lease for this repository (POST …/push-grant). */
  lease: (repository: string) => Promise<unknown>;
  /** The person had it pushed outside this app: a refused push is trusted. */
  alreadyUploaded?: boolean;
  run?: PushGit;
  tempRoot?: string;
  now?: () => number;
}

/** The longest the upload may take, whatever the lease says. */
const maxPushMs = 10 * 60_000;

/** The push the person can run in a terminal (or ask Claudex to run). */
export function uploadCommand(repository: string, tip: string, ref: string) {
  return `git push --no-follow-tags https://github.com/${repository}.git +${tip}:${ref}`;
}

/**
 * Uploads the saved work and returns what the cloud session clones. A
 * clean folder whose branch origin already has at HEAD starts from that
 * branch and uploads nothing; work already at the session's ref is not
 * uploaded again. Throws `CloudPushError` when git refused.
 */
export async function uploadForCloud(
  options: UploadOptions,
): Promise<{ repository: RepositoryRef; unverified?: boolean }> {
  const { tip, ref, branch } = options;
  if (!/^[0-9a-f]{40,64}$/.test(tip) || (branch && !validBranch(branch)))
    throw new Error(
      "Couldn’t read this folder’s git state. Check again in a moment.",
    );
  try {
    return await uploadOnce(options);
  } catch (error) {
    // Pushed outside this app (the person, or Claudex in the session):
    // trusted, and said so when the cloud session is ready.
    if (options.alreadyUploaded && error instanceof CloudPushError)
      return {
        repository: {
          url: `https://github.com/${options.repository}.git`,
          ref,
          ...(branch ? { branch } : {}),
        },
        unverified: true,
      };
    throw error;
  }
}

async function uploadOnce(
  options: UploadOptions,
): Promise<{ repository: RepositoryRef }> {
  const { tip, ref, branch } = options;
  const run = options.run ?? runPushGit;
  const now = options.now ?? Date.now;
  const command = uploadCommand(options.repository, tip, ref);
  const grant: CloneGrant = parseCloneGrant(
    await options.lease(options.repository),
  );
  if (!grant.canPush)
    throw new CloudPushError(
      "auth",
      uploadFailureMessages.auth,
      undefined,
      command,
    );
  const budget = Math.min(maxPushMs, grant.expiresAt - now());
  if (budget <= 0) throw new Error("The push credential expired.");
  const temp = fs.mkdtempSync(
    path.join(options.tempRoot ?? os.tmpdir(), "claudex-push-"),
  );
  fs.chmodSync(temp, 0o700);
  const cloned = (gitRef: string): RepositoryRef => ({
    url: grant.url,
    ref: gitRef,
    ...(branch && gitRef !== branch ? { branch } : {}),
  });
  try {
    const helper = path.join(temp, "askpass.sh");
    fs.writeFileSync(helper, askpass, { mode: 0o700 });
    const own = path.join(temp, "repo.git");
    const base: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: temp,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    // A proxy the person's computer needs still applies.
    for (const name of [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "NO_PROXY",
      "no_proxy",
      "SYSTEMROOT",
    ])
      if (process.env[name]) base[name] = process.env[name]!;
    const withCredential = {
      ...base,
      GIT_ASKPASS: helper,
      CLAUDEX_GIT_USERNAME: grant.username,
      CLAUDEX_GIT_TOKEN: grant.token,
    };
    const signal = AbortSignal.timeout(budget);
    const step = async (argv: string[], env: Record<string, string>) => {
      const out = await run({ argv, env, signal });
      if (out.code === 0) return out.stdout ?? "";
      const excerpt = scrub(out.stderr, [grant.token]) || undefined;
      const failure = classifyPushFailure(out.stderr, signal.aborted);
      throw new CloudPushError(
        failure,
        uploadFailureMessages[failure],
        excerpt,
        command,
      );
    };
    // What origin has: the branch, and the session's ref.
    const listed = await step(
      [
        "-c",
        "credential.helper=",
        "ls-remote",
        "--",
        grant.url,
        ...(branch ? [`refs/heads/${branch}`] : []),
        ref,
      ],
      withCredential,
    );
    const remote = new Map<string, string>();
    for (const line of listed.split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (sha && name) remote.set(name, sha);
    }
    if (
      !options.snapshot &&
      branch &&
      remote.get(`refs/heads/${branch}`) === tip
    )
      return { repository: cloned(branch) };
    if (remote.get(ref) === tip) return { repository: cloned(ref) };
    await step(["init", "--bare", "--quiet", own], base);
    // The commit from the person's folder (read only, no hooks); it is on
    // no ref of theirs, so upload-pack is told to hand it out by name.
    await step(
      [
        "-C",
        own,
        "-c",
        "protocol.file.allow=always",
        "-c",
        "uploadpack.allowAnySHA1InWant=true",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        fileUrl(options.gitDir),
        `${tip}:refs/heads/work`,
      ],
      base,
    );
    // The session's own ref may hold an earlier upload: replaced.
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
        "--no-follow-tags",
        "--",
        grant.url,
        `+refs/heads/work:${ref}`,
      ],
      withCredential,
    );
    return { repository: cloned(ref) };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

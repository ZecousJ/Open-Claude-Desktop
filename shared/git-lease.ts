/**
 * A GitHub credential the service leases for one git operation (W-GITHUB,
 * backend/backend/internal/claudex/ghconn): the runner's clones and pushes
 * (`github.clone`, `github.push` on the runner link) and the desktop's push
 * before it continues a local session in the cloud (POST
 * /api/v1/claudex/web/github/push-grant). Whoever runs git hands the
 * credential to that one child process through a throw-away GIT_ASKPASS
 * script, never in argv or the remote address, and scrubs git's words of it.
 */

/** The service's answer: where to reach the repository and with what. */
export interface CloneGrant {
  /** An https address without credentials. */
  url: string;
  username: string;
  token: string;
  /** When the caller must be done and have dropped the credential. */
  expiresAt: number;
  /** "owner/name" */
  repository: string;
  defaultBranch: string;
  ref?: string;
  canPush: boolean;
}

export function parseCloneGrant(value: unknown): CloneGrant {
  const v = (value ?? {}) as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" ? x : "");
  const expiresAt = Date.parse(text(v.expiresAt));
  let url: URL | undefined;
  try {
    url = new URL(text(v.url));
  } catch {
    // refused below
  }
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !text(v.token) ||
    !text(v.username) ||
    !Number.isFinite(expiresAt)
  )
    throw new Error("The service's clone credential is not valid.");
  const ref = text(v.ref);
  return {
    url: url.href,
    username: text(v.username),
    token: text(v.token),
    expiresAt,
    repository: text(v.repository) || url.pathname.replace(/^\/|\.git$/g, ""),
    defaultBranch: text(v.defaultBranch),
    ...(ref ? { ref } : {}),
    canPush: v.canPush === true,
  };
}

/** The askpass helper: git asks for the username first, then the password. */
export const askpass = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\\n' "$CLAUDEX_GIT_USERNAME" ;;
  *) printf '%s\\n' "$CLAUDEX_GIT_TOKEN" ;;
esac
`;

/** Git's last lines without the secrets, short enough to show. */
export function scrub(text: string, secrets: string[]) {
  let out = text;
  for (const secret of secrets)
    if (secret) out = out.split(secret).join("[token]");
  return out.trim().split("\n").slice(-3).join(" ").slice(0, 400);
}

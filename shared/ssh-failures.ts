/**
 * Why this computer's ssh failed before reaching the host. The original's two
 * "built-in SSH library" reasons are left out: Claudex always runs the system
 * OpenSSH, which handles ProxyJump and host key sources itself.
 */
export const sshLocalFailureMessages = {
  local_ssh_helper_blocked:
    "This computer won’t start Claudex’s SSH sign-in helper. Ask your admin to allow it, then reconnect. Your sessions there are kept.",
  local_ssh_login_refused:
    "This computer’s ssh refuses a backslash or dollar sign in user names. Send a message in one of your sessions there to see what to do. Your sessions are kept.",
} as const;

export type SshLocalFailure = keyof typeof sshLocalFailureMessages;

export function sshLocalFailureMessage(code: string): string | undefined {
  return Object.hasOwn(sshLocalFailureMessages, code)
    ? sshLocalFailureMessages[code as SshLocalFailure]
    : undefined;
}

export function classifySshLocalFailure(failure: {
  stderr: string;
  interactive: boolean;
}): SshLocalFailure | undefined {
  // OpenSSH's own refusal.
  if (/^remote username contains invalid characters\r?$/m.test(failure.stderr))
    return "local_ssh_login_refused";

  // The askpass helper could not be started.
  if (
    failure.interactive &&
    /Permission denied \([^)]*\b(?:password|keyboard-interactive)\b[^)]*\)/i.test(
      failure.stderr,
    ) &&
    /^ssh_askpass: (?:exec\(|posix_spawn|CreateProcess).*?(?:Permission denied|Operation not permitted|Access is denied|error[ =]5\b|EACCES|EPERM)/im.test(
      failure.stderr,
    )
  )
    return "local_ssh_helper_blocked";
  return undefined;
}

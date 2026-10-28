/**
 * SSH remote environments (R9): hosts the person added, the connection to
 * each, askpass prompts and remote folders. Code conversations, projects and
 * routines name their environment with `EnvironmentRef` (shared/types.ts).
 *
 * The method list is frozen (S0); the handlers are in `electron/ipc/ssh.ts`
 * (R9-S1). A connection reaching "ready" means the SSH connection is up and
 * the host was checked; running Codex there arrives with R9-S2 and R9-S3.
 * Passwords and passphrases are never stored: each prompt is answered once
 * and forgotten.
 */
import { bridgeMethods } from "./bridge-methods";
import type { SshLocalFailure } from "./ssh-failures";
import type { SshDiagnosticCode } from "./ssh-diagnostics";

export interface SshHost {
  id: string;
  /** Display name; the destination unless the person renamed it. */
  label: string;
  /** "alias" or "user@host": no leading "-", no whitespace or control characters. */
  destination: string;
  port?: number;
  /** A path only; the key itself is never read. */
  identityFile?: string;
  /** Where Claudex keeps its runtime on the host (default ~/.claudex-remote/<clientId>). */
  remoteRoot?: string;
  defaultFolder?: string;
  /** Advanced: a custom ssh executable (an absolute path to a file named ssh). */
  sshPath?: string;
  /**
   * Forward the local ssh-agent to the host (off unless the person turns it
   * on: anyone with root on the host can use a forwarded agent).
   */
  forwardAgent?: boolean;
  /** A password is saved for it (electron/ssh/password-store.ts); the password itself never leaves the main process. */
  hasPassword?: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

export type SshErrorCode =
  | SshDiagnosticCode
  | SshLocalFailure
  | "ssh-missing"
  | "auth-failed"
  | "host-key-changed"
  | "host-unreachable"
  | "timeout"
  | "unsupported-platform"
  | "install-failed"
  | "forward-failed"
  | "engine-exited"
  | "policy-disabled"
  | "host-not-allowed";

export type SshStatus =
  | { state: "idle" | "connecting" | "probing" | "starting" | "ready" }
  | {
      state: "installing";
      progress?: number;
      phase: "download" | "upload" | "verify";
    }
  | { state: "needs-auth" }
  | { state: "reconnecting"; attempt: number }
  | { state: "error"; code: SshErrorCode; message: string; details?: string };

/** A question ssh asked through askpass (password, passphrase, host key). */
export interface SshPrompt {
  id: string;
  /** The saved host; "" while testing a connection that is not saved yet. */
  hostId: string;
  kind: "password" | "passphrase" | "hostkey" | "other";
  /** ssh's own words (control characters removed, at most 2000 characters). */
  text: string;
  /** "SHA256:…" for a host key question. */
  fingerprint?: string;
  /**
   * A yes/no question (host keys, ssh-agent confirmations): answer any
   * string for yes, null for no. Without it the answer is typed text.
   */
  confirm?: boolean;
  /**
   * Only a notice (for example "Confirm user presence for key …" while a
   * security key waits for a touch): nothing to answer; it closes by itself
   * (ssh-prompt-closed). Answering null cancels the connection attempt.
   */
  notice?: boolean;
}

export type SshHostInput = Omit<SshHost, "id" | "createdAt" | "hasPassword"> & {
  id?: string;
  /** A new password to save; empty or absent keeps the saved one. */
  password?: string;
  /** Removes the saved password. */
  clearPassword?: boolean;
};

export interface SshToolGrant {
  endpointKey: string;
  server: string;
  toolName: string;
  hostLabel: string;
  serverLabel: string;
  toolLabel: string;
  grantedAt: number;
  serverKey: string;
  hostKey: string;
}

export interface SshAPI {
  sshToolGrants(): Promise<SshToolGrant[]>;
  sshRemoveToolGrant(
    endpointKey: string,
    server: string,
    toolName: string,
  ): Promise<void>;
  sshClearToolGrants(): Promise<void>;
  sshListHosts(): Promise<{
    hosts: SshHost[];
    /** Host aliases from ~/.ssh/config the person has not added yet. */
    suggestions: string[];
    sshAvailable: boolean;
    sshVersion?: string;
  }>;
  sshSaveHost(input: SshHostInput): Promise<SshHost>;
  /** Forgets the host on this computer. */
  sshDeleteHost(id: string): Promise<void>;
  sshConnect(id: string): Promise<SshStatus>;
  sshDisconnect(id: string): Promise<void>;
  sshStatus(id: string): Promise<SshStatus>;
  sshTestHost(
    input: Pick<SshHost, "destination" | "port" | "identityFile"> & {
      sshPath?: string;
      /** The password typed in the form. */
      password?: string;
      /** A saved host being edited: its saved password when none is typed. */
      id?: string;
    },
  ): Promise<{
    ok: boolean;
    platform?: string;
    error?: string;
    code?: SshErrorCode;
    details?: string;
  }>;
  /**
   * Removes the host's entries from known_hosts after its key changed (the
   * next connection asks about the new key); the host's address as saved or
   * typed.
   */
  sshForgetHostKey(
    input: Pick<SshHost, "destination" | "port" | "sshPath">,
  ): Promise<{ removed: boolean }>;
  /** Answers a prompt; null cancels it (for a host key: don't connect). */
  sshAnswerPrompt(promptId: string, answer: string | null): Promise<void>;
  sshListDirectory(
    hostId: string,
    path?: string,
  ): Promise<{
    path: string;
    entries: { name: string; kind: "folder" | "file" }[];
  }>;
  /** Records a remote folder the person chose as a working folder. */
  sshChooseFolder(hostId: string, path: string): Promise<void>;
}

export const sshMethods = bridgeMethods<SshAPI>({
  sshToolGrants: true,
  sshRemoveToolGrant: true,
  sshClearToolGrants: true,
  sshListHosts: true,
  sshSaveHost: true,
  sshDeleteHost: true,
  sshConnect: true,
  sshDisconnect: true,
  sshStatus: true,
  sshTestHost: true,
  sshForgetHostKey: true,
  sshAnswerPrompt: true,
  sshListDirectory: true,
  sshChooseFolder: true,
});

export type SshEvent =
  | { type: "ssh-status"; hostId: string; status: SshStatus }
  | { type: "ssh-prompt"; prompt: SshPrompt }
  | { type: "ssh-prompt-closed"; id: string };

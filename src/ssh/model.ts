/**
 * What the SSH environment UI shows, as plain functions (R9-S5): labels,
 * the environment menu, status wording, askpass dialogs and the checks the
 * Add connection dialog runs before the main process checks again.
 */
import type {
  SshErrorCode,
  SshHost,
  SshHostInput,
  SshPrompt,
  SshStatus,
} from "../../shared/ssh-api";
import type { EnvironmentRef } from "../../shared/types";
import type { MenuEntry } from "../ui/Menu";
import { formatText, t, tf } from "../i18n";
import { sshLocalFailureMessage } from "../../shared/ssh-failures";
import { sshDiagnosticMessage } from "../../shared/ssh-diagnostics";

export const localEnvironment: EnvironmentRef = { kind: "local" };

/** The SSH host an environment names; undefined for this computer. */
export const sshHostId = (environment?: EnvironmentRef) =>
  environment?.kind === "ssh" ? environment.hostId : undefined;

export const sameEnvironment = (a?: EnvironmentRef, b?: EnvironmentRef) =>
  sshHostId(a) === sshHostId(b);

/** "user@host:2222", as rows and tooltips show a host. */
export const hostAddress = (host: Pick<SshHost, "destination" | "port">) =>
  host.port ? `${host.destination}:${host.port}` : host.destination;

/** Grey detail beside a host in menus and Settings; empty while idle or ready. */
export function statusDetail(status?: SshStatus): string {
  switch (status?.state) {
    case "connecting":
    case "probing":
    case "starting":
      return "Connecting…";
    case "installing":
      return "Setting up…";
    case "reconnecting":
      return "Reconnecting…";
    case "needs-auth":
      return "Sign in";
    case "error":
      return "Offline";
    default:
      return "";
  }
}

export const isBusy = (status?: SshStatus) =>
  status?.state === "connecting" ||
  status?.state === "probing" ||
  status?.state === "starting" ||
  status?.state === "installing" ||
  status?.state === "reconnecting";

/** Why a connection failed, in words, for the error code the main process gives. */
export function errorExplanation(code: SshErrorCode, host = "{host}"): string {
  const diagnostic = sshDiagnosticMessage(code);
  if (diagnostic) return tf(diagnostic, { host });
  switch (code) {
    case "local_ssh_helper_blocked":
    case "local_ssh_login_refused":
      return t(sshLocalFailureMessage(code)!);
    case "ssh-missing":
      return "OpenSSH isn't installed on this computer.";
    case "auth-failed":
      return "The host didn't accept your key or password.";
    case "host-key-changed":
      // The live app's warning: a changed key is trusted only for a reinstalled
      // or re-keyed machine.
      return "The host's key changed since you last connected. Don't trust the new key unless the machine was reinstalled or re-keyed. If it was, remove the old key and try again.";
    case "host-unreachable":
      return "The host can't be reached from this network.";
    case "timeout":
      return "The host took too long to answer.";
    case "unsupported-platform":
      return "Claudex can't run on this host's system yet.";
    case "install-failed":
      return "Claudex couldn't be set up on the host.";
    case "forward-failed":
      return "The host refused the connection Claudex needs for model requests.";
    case "engine-exited":
      return "Claudex stopped on the host.";
    case "policy-disabled":
      return "SSH connections are disabled by your organization's managed settings.";
    case "host-not-allowed":
      return 'SSH host "{host}" is not allowed by your organization\'s managed settings.';
  }
  return "The host can't be reached from this network.";
}

export interface EnvironmentMenuOptions {
  hosts: SshHost[];
  statuses: Record<string, SshStatus | undefined>;
  selected: EnvironmentRef;
  /** SSH shows only when connections are available (availability.ts). */
  ssh: boolean;
  loading?: boolean;
  onLocal: () => void;
  onHost: (host: SshHost) => void;
  onAdd: () => void;
  onEdit?: (host: SshHost) => void;
}

/**
 * SSH hosts, their edit actions and Add SSH connection…. The parent supplies
 * Cloud and Remote Control groups.
 */
export function environmentMenu(options: EnvironmentMenuOptions): MenuEntry[] {
  const current = sshHostId(options.selected);
  const selectedHost = options.hosts.find((host) => host.id === current);
  const entries: MenuEntry[] = [
    { label: "Local", checked: !selectedHost, onSelect: options.onLocal },
  ];
  if (!options.ssh) return entries;
  entries.push({
    label: "SSH",
    value: selectedHost?.label,
    // Searchable connections.
    searchable: "Search",
    searchEmpty: "No matching connections",
    submenu: [
      ...(options.loading
        ? [
            {
              label: "SSH hosts are still loading. Try again in a moment.",
              disabled: true,
            },
          ]
        : !options.hosts.length
          ? [{ label: "No SSH hosts yet", disabled: true }]
          : []),
      ...options.hosts.map((host): MenuEntry => ({
        // Submenu rows show only their label, so the state rides along in it.
        // The host's name stays as written; its state is translated alone.
        label: [host.label, t(statusDetail(options.statuses[host.id]))]
          .filter(Boolean)
          .join(" · "),
        noTranslate: true,
        title: hostAddress(host),
        checked: host.id === selectedHost?.id,
        // Edit affordance.
        settings: options.onEdit
          ? {
              label: "Edit connection…",
              onSelect: () => options.onEdit?.(host),
            }
          : undefined,
        onSelect: () => options.onHost(host),
        ...(options.onEdit
          ? {
              settings: {
                label: "Edit connection…",
                onSelect: () => options.onEdit?.(host),
              },
            }
          : {}),
      })),
      ...(options.hosts.length ? [{ separator: true } as const] : []),
      { label: "Add SSH connection…", onSelect: options.onAdd },
    ],
  });
  return entries;
}

export interface BannerView {
  text: string;
  /** Spinner before the text while something is under way. */
  busy: boolean;
  /** 0–1 while Claudex is being set up on the host. */
  progress?: number;
  action?: { label: string; kind: "connect" | "forget-key" };
  error: boolean;
}

/**
 * The strip above an SSH conversation's composer while its host is not
 * ready (design 5.4); undefined once it is.
 */
export function bannerFor(
  status: SshStatus | undefined,
  label: string,
): BannerView | undefined {
  switch (status?.state ?? "idle") {
    case "ready":
      return undefined;
    case "connecting":
    case "probing":
    case "starting":
      return {
        text: formatText("Connecting to {host}…", { host: label }),
        busy: true,
        error: false,
      };
    case "installing": {
      const progress =
        status?.state === "installing" ? status.progress : undefined;
      const percent =
        progress === undefined
          ? ""
          : ` ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
      return {
        text: `${formatText("Setting up Claudex on {host}…", { host: label })}${percent}`,
        busy: true,
        progress,
        error: false,
      };
    }
    case "reconnecting":
      return {
        text: formatText("Reconnecting to {host}…", { host: label }),
        busy: true,
        error: false,
      };
    case "needs-auth":
      return {
        text: formatText("{host} needs you to sign in.", { host: label }),
        busy: false,
        action: {
          label: formatText("Sign in to {host}", { host: label }),
          kind: "connect",
        },
        error: false,
      };
    case "error": {
      const reason =
        status?.state === "error"
          ? sshDiagnosticMessage(status.code)
            ? errorExplanation(status.code, label)
            : status.message || errorExplanation(status.code, label)
          : "";
      const final =
        status?.state === "error" &&
        (status.code === "policy-disabled" ||
          status.code === "host-not-allowed");
      const changed =
        status?.state === "error" && status.code === "host-key-changed";
      return {
        text:
          status?.state === "error" && sshLocalFailureMessage(status.code)
            ? errorExplanation(status.code)
            : formatText("Can’t reach {host}: {reason}", {
                host: label,
                reason,
              }),
        busy: false,
        action: final
          ? undefined
          : changed
            ? { label: "Remove the old key and try again", kind: "forget-key" }
            : { label: "Try again", kind: "connect" },
        error: true,
      };
    }
    default:
      return {
        text: formatText("Not connected to {host}.", { host: label }),
        busy: false,
        action: { label: "Connect", kind: "connect" },
        error: false,
      };
  }
}

export interface PromptView {
  title: string;
  /** The answer field's type; none for a host key question. */
  input?: "password" | "text";
  confirm: string;
  note?: string;
}

/** Wording of the askpass dialog for what ssh asked (design 5.3). */
export function promptView(prompt: SshPrompt, label: string): PromptView {
  switch (prompt.kind) {
    case "password":
      return {
        title: `Sign in to ${label}`,
        input: "password",
        confirm: "Continue",
      };
    case "passphrase":
      return {
        title: "Unlock SSH key",
        input: "password",
        confirm: "Continue",
      };
    case "hostkey":
      return {
        title: "Verify host",
        confirm: "Connect",
        note: "Make sure this matches the server's fingerprint before connecting.",
      };
    default:
      return { title: label, input: "text", confirm: "Continue" };
  }
}

const control = /[\u0000-\u001f\u007f]/;

/**
 * What is wrong with a host before it is saved or tested; undefined when
 * nothing is. The main process checks again (the renderer is not trusted).
 */
export function hostInputError(
  input: Partial<SshHostInput>,
): string | undefined {
  const destination = input.destination?.trim() ?? "";
  if (!destination) return "Enter a host.";
  if (destination.startsWith("-")) return "A host can't start with “-”.";
  if (/\s/.test(destination) || control.test(destination))
    return "A host can't contain spaces.";
  if (destination.length > 255) return "That host is too long.";
  if (input.port !== undefined) {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
      return "Enter a port from 1 to 65535.";
  }
  for (const [name, value] of [
    ["identity file", input.identityFile],
    ["remote folder", input.remoteRoot],
    ["default folder", input.defaultFolder],
    ["SSH program", input.sshPath],
  ] as const)
    if (value && (control.test(value) || value.length > 1024))
      return `That ${name} isn't a valid path.`;
  if ((input.label?.length ?? 0) > 100) return "That name is too long.";
  return undefined;
}

/** A port field's text as a number; undefined for an empty field. */
export function parsePort(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The folder above a remote POSIX path; the root stays the root. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0) return trimmed.startsWith("/") ? "/" : trimmed;
  return trimmed.slice(0, cut);
}

/** A child of a remote POSIX folder. */
export const childPath = (folder: string, name: string) =>
  `${folder.replace(/\/+$/, "")}/${name}`;

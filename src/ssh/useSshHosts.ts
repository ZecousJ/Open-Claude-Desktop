/**
 * The window's view of SSH connections (R9): saved hosts, each one's
 * connection status and the askpass questions waiting for an answer. One
 * store per window, filled from the bridge and kept current by the
 * `ssh-status` / `ssh-prompt` / `ssh-prompt-closed` events.
 */
import { useSyncExternalStore } from "react";
import { surface } from "../../shared/host";
import type {
  SshHost,
  SshHostInput,
  SshPrompt,
  SshStatus,
} from "../../shared/ssh-api";
import type { AppEvent } from "../../shared/types";
import { sshUiReady } from "./availability";

export interface SshState {
  loaded: boolean;
  hosts: SshHost[];
  suggestions: string[];
  sshAvailable: boolean;
  sshVersion?: string;
  statuses: Record<string, SshStatus | undefined>;
  /** Questions from ssh, oldest first. */
  prompts: SshPrompt[];
}

const empty: SshState = {
  loaded: false,
  hosts: [],
  suggestions: [],
  sshAvailable: false,
  statuses: {},
  prompts: [],
};

let state = empty;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
let loading: Promise<void> | undefined;

function set(next: SshState) {
  state = next;
  listeners.forEach((listener) => listener());
}

const desktop = () =>
  typeof window === "undefined" ? undefined : window.desktop;

/** Applies an event from the main process; other events are ignored. */
export function applySshEvent(event: AppEvent) {
  if (event.type === "ssh-status")
    set({
      ...state,
      statuses: { ...state.statuses, [event.hostId]: event.status },
    });
  else if (event.type === "ssh-prompt")
    set({
      ...state,
      prompts: [
        ...state.prompts.filter((p) => p.id !== event.prompt.id),
        event.prompt,
      ],
    });
  else if (event.type === "ssh-prompt-closed")
    set({ ...state, prompts: state.prompts.filter((p) => p.id !== event.id) });
}

/** Reads the hosts and their statuses again. */
export function reloadSsh(): Promise<void> {
  if (surface === "web") return Promise.resolve();
  const api = desktop();
  if (!api?.sshListHosts) return Promise.resolve();
  loading = (async () => {
    try {
      const list = await api.sshListHosts();
      const statuses: SshState["statuses"] = {};
      await Promise.all(
        list.hosts.map(async (host) => {
          statuses[host.id] = await api
            .sshStatus(host.id)
            .catch(() => undefined);
        }),
      );
      set({
        ...state,
        loaded: true,
        hosts: list.hosts,
        suggestions: list.suggestions,
        sshAvailable: list.sshAvailable,
        sshVersion: list.sshVersion,
        // Events that arrived while reading win over the answers.
        statuses: { ...statuses, ...pickKnown(state.statuses, list.hosts) },
      });
    } catch {
      set({ ...state, loaded: true, sshAvailable: false });
    }
  })();
  return loading;
}

function pickKnown(
  statuses: SshState["statuses"],
  hosts: SshHost[],
): SshState["statuses"] {
  const known: SshState["statuses"] = {};
  for (const host of hosts)
    if (statuses[host.id]) known[host.id] = statuses[host.id];
  return known;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!unsubscribe) {
    const api = desktop();
    unsubscribe = api?.onEvent?.(applySshEvent) ?? (() => {});
    if (!loading) void reloadSsh();
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The window's SSH state; `ready` is whether the SSH UI shows at all. */
export function useSshHosts() {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  return { ...current, ready: sshUiReady(current.sshAvailable) };
}

export const sshState = () => state;

// Actions: each updates the store as soon as the main process answers.

export async function saveSshHost(input: SshHostInput) {
  const saved = await window.desktop.sshSaveHost(input);
  const hosts = state.hosts.some((host) => host.id === saved.id)
    ? state.hosts.map((host) => (host.id === saved.id ? saved : host))
    : [...state.hosts, saved];
  set({
    ...state,
    hosts,
    suggestions: state.suggestions.filter((s) => s !== saved.destination),
  });
  return saved;
}

export async function deleteSshHost(id: string) {
  await window.desktop.sshDeleteHost(id);
  const statuses = { ...state.statuses };
  delete statuses[id];
  set({
    ...state,
    hosts: state.hosts.filter((host) => host.id !== id),
    statuses,
  });
}

export async function connectSshHost(id: string) {
  set({
    ...state,
    statuses: { ...state.statuses, [id]: { state: "connecting" } },
  });
  try {
    const status = await window.desktop.sshConnect(id);
    set({ ...state, statuses: { ...state.statuses, [id]: status } });
    return status;
  } catch (error) {
    const status: SshStatus = {
      state: "error",
      code: "engine-exited",
      message: error instanceof Error ? error.message : String(error),
    };
    set({ ...state, statuses: { ...state.statuses, [id]: status } });
    return status;
  }
}

/**
 * The host's key changed: remove its old key from known_hosts, then
 * connect again (ssh asks about the new key as for a new host).
 */
export async function forgetHostKeyAndConnect(host: SshHost) {
  try {
    await window.desktop.sshForgetHostKey({
      destination: host.destination,
      port: host.port,
      sshPath: host.sshPath,
    });
  } catch (error) {
    const status: SshStatus = {
      state: "error",
      code: "host-key-changed",
      message: error instanceof Error ? error.message : String(error),
    };
    set({ ...state, statuses: { ...state.statuses, [host.id]: status } });
    return status;
  }
  return connectSshHost(host.id);
}

export async function disconnectSshHost(id: string) {
  await window.desktop.sshDisconnect(id);
  set({ ...state, statuses: { ...state.statuses, [id]: { state: "idle" } } });
}

/** Answers the question ssh asked; null cancels it. */
export async function answerSshPrompt(id: string, answer: string | null) {
  set({ ...state, prompts: state.prompts.filter((p) => p.id !== id) });
  await window.desktop.sshAnswerPrompt(id, answer);
}

/** For tests: forget everything, as a new window starts. */
export function resetSshStore(next: Partial<SshState> = {}) {
  unsubscribe?.();
  unsubscribe = undefined;
  loading = undefined;
  set({ ...empty, ...next });
}

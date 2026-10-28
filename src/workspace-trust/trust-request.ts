import { useEffect, useState, useSyncExternalStore } from "react";
import type { EnvironmentRef } from "../../shared/types";
import {
  isWorkspaceTrustError,
  type WorkspaceTrust,
  type WorkspaceTrustAPI,
  type WorkspaceTrustPlace,
} from "../../shared/workspace-trust-api";

/**
 * "Trust this workspace?" (shared/workspace-trust-api.ts), as the live
 * * one question at a time, shown by the oldest mounted host (the primary
 *   pane's composer when split panes each mount one); a second request for the
 *   same workspace waits for the same answer and one for another workspace is
 *   declined. With no host mounted the request is declined.
 */
export type TrustOutcome = "accepted" | "declined";

export interface TrustQuestion {
  trust: WorkspaceTrust;
  /** The person's answer: Trust workspace, or Cancel / Escape. */
  answer(accepted: boolean): void;
}

let current: TrustQuestion | undefined;
let resolvers: ((outcome: TrustOutcome) => void)[] = [];
/** Mounted hosts, oldest first; only the first one shows the dialog. */
let hosts: object[] = [];
const listeners = new Set<() => void>();
const publish = (next: TrustQuestion | undefined) => {
  current = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The same workspace: its root, on the same SSH host (or this computer). */
const sameWorkspace = (a: WorkspaceTrust, b: WorkspaceTrust) =>
  a.root === b.root && (a.host ?? "") === (b.host ?? "");

/** Asks the person whether to trust a folder Codex doesn't trust yet. */
export function askWorkspaceTrust(
  trust: WorkspaceTrust,
): Promise<TrustOutcome> {
  if (!hosts.length) return Promise.resolve("declined");
  if (current)
    return sameWorkspace(current.trust, trust)
      ? new Promise((resolve) => resolvers.push(resolve))
      : Promise.resolve("declined");
  return new Promise((resolve) => {
    resolvers = [resolve];
    const question: TrustQuestion = {
      trust,
      answer(accepted) {
        if (current !== question) return;
        const waiting = resolvers;
        resolvers = [];
        publish(undefined);
        for (const done of waiting) done(accepted ? "accepted" : "declined");
      },
    };
    publish(question);
  });
}

/** The question being asked now, whichever host shows it. */
export function currentTrustQuestion() {
  return current;
}

/** A host that shows the questions; returns its unmount. */
export function mountTrustHost(host: object = {}) {
  hosts = [...hosts, host];
  publish(current);
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    hosts = hosts.filter((value) => value !== host);
    if (!hosts.length) current?.answer(false);
    else publish(current);
  };
}

/**
 * Mounts a host for the component's lifetime and returns the question it
 * shows: the current one for the oldest host, nothing for the others.
 */
export function useHostedTrustQuestion() {
  const [host] = useState(() => ({}));
  useEffect(() => mountTrustHost(host), [host]);
  return useSyncExternalStore(
    subscribe,
    () => (hosts[0] === host ? current : undefined),
    () => undefined,
  );
}

type Bridge = Pick<
  WorkspaceTrustAPI,
  "checkWorkspaceTrust" | "saveWorkspaceTrust"
>;

/** Why trust couldn't be settled. */
export const trustCheckFailed =
  "Couldn’t check whether this workspace is trusted. Try again.";
export const trustSaveFailed =
  "Trust settings couldn’t be saved. You can try again.";

/**
 * Makes sure Codex trusts `folder`, asking the person when it doesn't.
 * Resolves true once it is trusted, false when they decline or it couldn't
 * be settled (the reason goes to `notify`). `place` names the SSH host the
 * folder is on (an empty folder there is the host's default folder).
 */
export async function ensureWorkspaceTrusted(
  folder: string,
  options: {
    api: Bridge;
    notify: (message: string) => void;
    place?: WorkspaceTrustPlace;
  },
): Promise<boolean> {
  const { api, notify, place } = options;
  let trust: WorkspaceTrust;
  try {
    trust = place
      ? await api.checkWorkspaceTrust(folder, place)
      : await api.checkWorkspaceTrust(folder);
  } catch {
    notify(trustCheckFailed);
    return false;
  }
  if (trust.trusted) return true;
  if ((await askWorkspaceTrust(trust)) !== "accepted") return false;
  try {
    // An SSH host records the folder that was asked about (its real path).
    return (
      place
        ? await api.saveWorkspaceTrust(trust.folder, place)
        : await api.saveWorkspaceTrust(folder)
    ).trusted;
  } catch {
    notify(trustSaveFailed);
    return false;
  }
}

/** The workspace a conversation's turns run in, for `ensureWorkspaceTrusted`. */
export function trustTarget(target: {
  cwd?: string;
  environment?: EnvironmentRef;
}): { folder: string; place?: WorkspaceTrustPlace } | undefined {
  const environment = target.environment;
  if (environment?.kind === "ssh")
    return {
      folder: target.cwd ?? "",
      place: { kind: "ssh", hostId: environment.hostId },
    };
  if (environment && environment.kind !== "local") return undefined;
  return target.cwd ? { folder: target.cwd } : undefined;
}

/** What `withWorkspaceTrust` resolves to when the person declined. */
export const trustDeclined = Symbol("trust declined");

/**
 * Runs a Code send that may be refused for an untrusted workspace (a
 * queued message, a split pane's send, an edit, a retry): on that refusal
 * it asks "Trust this workspace?" and runs it again once trusted (once).
 * Resolves `trustDeclined` when the person cancels or trust couldn't be
 * settled; any other error goes to the caller.
 */
export async function withWorkspaceTrust<T>(
  run: () => Promise<T>,
  target: { cwd?: string; environment?: EnvironmentRef } | undefined,
  options: { api?: Bridge; notify: (message: string) => void },
): Promise<T | typeof trustDeclined> {
  try {
    return await run();
  } catch (error) {
    const workspace = target && trustTarget(target);
    const api = options.api;
    if (!isWorkspaceTrustError(error) || !workspace || !api) throw error;
    const trusted = await ensureWorkspaceTrusted(workspace.folder, {
      api,
      notify: options.notify,
      ...(workspace.place ? { place: workspace.place } : {}),
    });
    if (!trusted) return trustDeclined;
    return run();
  }
}

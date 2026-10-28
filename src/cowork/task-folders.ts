import { useContext, useEffect, useState } from "react";
import { type Conversation, type DesktopAPI } from "../../shared/types";
import type { TaskFolderSnapshot } from "../../shared/folder-browser";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import { AppContext } from "../app/AppContext";
import { requestFolderAccess } from "./useFolderAccess";

export type CoworkTaskFolders = TaskFolderSnapshot;
type TaskFoldersBridge = Pick<DesktopAPI, "coworkFolders" | "onEvent">;
export const folderAccessUnavailable =
  "Folder access is unavailable for this session.";

export function watchCoworkFolders(
  desktop: TaskFoldersBridge,
  conversationId: string,
  set: (folders: CoworkTaskFolders) => void,
  onError: (error: unknown) => void,
  onLoading?: () => void,
) {
  let live = true;
  let latest = 0;
  const load = () => {
    const request = ++latest;
    onLoading?.();
    return Promise.resolve()
      .then(() => desktop.coworkFolders(conversationId))
      .then((folders) => {
        if (live && request === latest) set(folders);
      })
      .catch((error: unknown) => {
        if (live && request === latest) onError(error);
      });
  };
  void load();
  const off = desktop.onEvent((event) => {
    if (
      event.type === "cowork-folders" &&
      (!event.conversationId || event.conversationId === conversationId)
    )
      void load();
  });
  return () => {
    live = false;
    off();
  };
}

export type TaskFolderRead = {
  status: "unsupported" | "loading" | "ready" | "error";
  folders?: CoworkTaskFolders;
  error?: string;
};

/** Account/bridge/environment changes discard old replies, even for the same id. */
export function useTaskFolderState(
  conversation: Pick<Conversation, "id" | "mode" | "environment"> | undefined,
  allowRemote = false,
): TaskFolderRead & { retry(): void } {
  const app = useContext(AppContext);
  const desktop = typeof window === "undefined" ? undefined : window.desktop;
  const [revision, setRevision] = useState(0);
  const id =
    conversation &&
    (conversation.mode === "cowork" || conversation.mode === "chat") &&
    conversation.environment?.kind !== "ssh" &&
    (!conversation.environment ||
      conversation.environment.kind === "local" ||
      allowRemote)
      ? conversation.id
      : undefined;
  const environment = conversation?.environment;
  const hostKey =
    environment?.kind === "space"
      ? `space:${environment.spaceId}`
      : (environment?.kind ?? "local");
  const mode = conversation?.mode;
  const scope = app?.controllerScope ?? app;
  const account = app?.accountId;
  const [state, setState] = useState<{
    id?: string;
    hostKey: string;
    mode?: string;
    desktop: typeof desktop;
    scope: typeof scope;
    account?: string;
    read: TaskFolderRead;
  }>();
  const matches =
    state?.id === id &&
    state?.hostKey === hostKey &&
    state?.mode === mode &&
    state?.desktop === desktop &&
    state?.scope === scope &&
    state?.account === account;
  useEffect(() => {
    if (!id || !desktop?.coworkFolders) return;
    const write = (
      update: (previous: TaskFolderRead | undefined) => TaskFolderRead,
    ) =>
      setState((previous) => ({
        id,
        hostKey,
        mode,
        desktop,
        scope,
        account,
        read: update(
          previous?.id === id &&
            previous.hostKey === hostKey &&
            previous.mode === mode &&
            previous.desktop === desktop &&
            previous.scope === scope &&
            previous.account === account
            ? previous.read
            : undefined,
        ),
      }));
    return watchCoworkFolders(
      desktop,
      id,
      (folders) => write(() => ({ status: "ready", folders })),
      (error) =>
        write((previous) => {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            status: message.includes(notAvailableOnWeb)
              ? "unsupported"
              : "error",
            folders: previous?.folders,
            error: message,
          };
        }),
      () =>
        write((previous) => ({
          status: "loading",
          folders: previous?.folders,
        })),
    );
  }, [id, hostKey, mode, desktop, scope, account, revision]);
  return {
    ...(!id || !desktop?.coworkFolders
      ? { status: "unsupported" as const }
      : matches && state
        ? state.read
        : { status: "loading" as const }),
    retry: () => setRevision((value) => value + 1),
  };
}

/** Existing context consumers keep their last successful folder list on retry. */
export function useCoworkFolders(
  conversation: Pick<Conversation, "id" | "mode" | "environment"> | undefined,
  allowRemote = false,
): CoworkTaskFolders | undefined {
  return useTaskFolderState(conversation, allowRemote).folders;
}

type AddFolderBridge = Pick<
  DesktopAPI,
  "chooseFolder" | "coworkFolderAccess" | "grantCoworkFolder"
>;

/** A path from the execution browser still goes through the same access prompt. */
export async function addCoworkTaskFolder(
  conversation: Pick<Conversation, "id" | "turns">,
  options: {
    notify?: (message: string) => void;
    api?: AddFolderBridge;
    folder?: string;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  const { notify, api = window.desktop } = options;
  const check = () => {
    if (options.signal?.aborted || options.isCurrent?.() === false)
      throw Error("This task session changed. Try again.");
  };
  check();
  const folder = options.folder ?? (await api.chooseFolder());
  check();
  if (!folder) return undefined;
  const target = { conversationId: conversation.id };
  const access = await api.coworkFolderAccess(folder, conversation.id);
  check();
  if (access.state === "refused") {
    notify?.(access.reason ?? "Some folders couldn’t be added.");
    return undefined;
  }
  if (access.state === "granted") {
    notify?.("This folder is already part of this task.");
    return undefined;
  }
  if (access.state === "default") {
    notify?.("Cowork's own workspace can't be added to a task.");
    return undefined;
  }
  // Validate the backend answer before the access host is allowed to resolve
  // a grant. A refused/malformed response keeps its confirmation retryable.
  const checkedAPI = {
    ...api,
    coworkFolderAccess: async (
      ...args: Parameters<AddFolderBridge["coworkFolderAccess"]>
    ) => {
      check();
      const value = await api.coworkFolderAccess(...args);
      check();
      return value;
    },
    grantCoworkFolder: async (
      ...args: Parameters<AddFolderBridge["grantCoworkFolder"]>
    ) => {
      check();
      const result = await api.grantCoworkFolder(...args);
      check();
      if (result.state !== "granted" && result.state !== "trusted")
        throw new Error(
          result.reason ?? "This folder couldn’t be added. Try again.",
        );
      return result;
    },
  };
  if (access.state === "trusted")
    await checkedAPI.grantCoworkFolder(folder, "session", target);
  else if (
    (await requestFolderAccess(folder, {
      ...target,
      notify,
      api: checkedAPI,
      signal: options.signal,
    })) !== "granted"
  )
    return undefined;
  check();
  if (conversation.turns.at(-1)?.status === "inProgress")
    notify?.("Claudex can use this folder from its next turn.");
  return access.folder;
}

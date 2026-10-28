import {
  Suspense,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Conversation } from "../../shared/types";
import { AppContext } from "../app/AppContext";
import { IconButton } from "../ui/Controls";
import { FolderPlusIcon } from "../ui/icons";
import { useHost } from "../host/HostContext";
import { lazyPiece } from "../ui/lazy-piece";
import { formatText, useLocale } from "../i18n";
import { linkFailureMessage } from "./link-to-computer";
import {
  addCoworkTaskFolder,
  folderAccessUnavailable,
  useTaskFolderState,
} from "./task-folders";

const TaskFolderBrowser = lazyPiece(
  () => import("./TaskFolderBrowser"),
  "TaskFolderBrowser",
);

/** Native picker for native execution; advertised execution browser otherwise. */
export function CoworkTaskFolderButton({
  conversation,
}: {
  conversation: Conversation;
}) {
  useLocale();
  const app = useContext(AppContext);
  const host = useHost();
  const desktop = window.desktop;
  const eligible =
    (host.capabilities.localFolders || host.capabilities.cloudCowork) &&
    conversation.environment?.kind !== "ssh" &&
    (conversation.mode === "cowork" || conversation.mode === "chat");
  const state = useTaskFolderState(eligible ? conversation : undefined, true);
  const owner = useMemo(
    () => ({}),
    [
      conversation.id,
      conversation.mode,
      conversation.environment?.kind,
      conversation.environment?.kind === "space"
        ? conversation.environment.spaceId
        : undefined,
      desktop,
      app?.accountId,
      app?.controllerScope,
      host,
    ],
  );
  const current = useRef(owner);
  current.current = owner;
  const lease = useRef<{ owner: object; abort: AbortController } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    const active = { owner, abort: new AbortController() };
    lease.current = active;
    return () => {
      active.abort.abort();
      if (lease.current === active) lease.current = undefined;
    };
  }, [owner]);
  const capture = () => {
    const active = lease.current;
    const valid = () => {
      if (
        !active ||
        lease.current !== active ||
        active.owner !== owner ||
        active.abort.signal.aborted ||
        current.current !== owner ||
        window.desktop !== desktop
      )
        return false;
      const now = app?.currentController?.current;
      return (
        !app?.currentController ||
        Boolean(
          now &&
          now.accountId === app.accountId &&
          now.controllerScope === app.controllerScope &&
          now.active?.id === conversation.id,
        )
      );
    };
    return { valid, signal: active?.abort.signal };
  };
  const [open, setOpen] = useState<object>();
  const [busy, setBusy] = useState<object>();
  const [error, setError] = useState<{ owner: object; message: string }>();
  const capability =
    state.folders?.browser ??
    (host.capabilities.localFolders &&
    conversation.mode === "cowork" &&
    conversation.environment?.kind !== "space" &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding
      ? { kind: "native" as const }
      : undefined);
  const native =
    capability?.kind === "native" &&
    host.capabilities.localFolders &&
    conversation.environment?.kind !== "space";
  const execution =
    capability?.kind === "execution" &&
    typeof desktop.listTaskFolderDirectory === "function"
      ? capability
      : undefined;
  const listDirectory = useMemo(
    () => async (path: string) => {
      const action = capture();
      if (!action.valid()) throw Error("This task session changed. Try again.");
      const result = await desktop.listTaskFolderDirectory(
        conversation.id,
        path,
      );
      if (!action.valid()) throw Error("This task session changed. Try again.");
      return result;
    },
    [desktop, conversation.id, owner],
  );
  const activeBusy = busy === owner;
  const add = async (folder?: string) => {
    const action = capture();
    if (!action.valid()) return false;
    setBusy(owner);
    setError(undefined);
    try {
      const added = await addCoworkTaskFolder(conversation, {
        api: desktop,
        notify: app?.notify,
        folder,
        isCurrent: action.valid,
        signal: action.signal,
      });
      if (!action.valid()) return false;
      if (added) state.retry();
      return Boolean(added);
    } catch (error) {
      if (!action.valid()) return false;
      if (folder) throw error;
      setError({
        owner,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (action.valid()) setBusy(undefined);
    }
  };
  // A cloud task on this computer that is not linked to it yet: the button
  // links it first.
  const unbound =
    host.kind !== "web" &&
    host.capabilities.localFolders &&
    conversation.environment?.kind === "space" &&
    !conversation.linkedToComputer &&
    typeof desktop.linkCoworkTaskToComputer === "function";
  const linkHere = async () => {
    const action = capture();
    if (!action.valid()) return;
    setBusy(owner);
    try {
      await desktop.linkCoworkTaskToComputer(conversation.id);
      if (action.valid()) app?.notify("Linked to this computer.");
    } catch (reason) {
      if (action.valid()) app?.notify(linkFailureMessage(reason));
    } finally {
      if (action.valid()) setBusy(undefined);
    }
  };
  if (!eligible) return null;
  if (unbound)
    return (
      <IconButton
        label={formatText("Link this task to this computer to add folders")}
        className="cowork-task-folder"
        disabled={activeBusy}
        onClick={() => void linkHere()}
      >
        <FolderPlusIcon size={17} />
      </IconButton>
    );
  const failed = state.status === "error" || error?.owner === owner;
  const loading = state.status === "loading" || activeBusy;
  const unsupported =
    state.status === "unsupported" ||
    (state.status === "ready" && !native && !execution);
  // A Chat on this computer with no folder access has no folder button, as in
  // the original; a reason (a cloud task, a Cowork task) keeps it disabled.
  if (
    unsupported &&
    conversation.mode === "chat" &&
    conversation.environment?.kind !== "space"
  )
    return null;
  return (
    <>
      <IconButton
        label={
          loading
            ? formatText("Loading folders…")
            : failed
              ? formatText("Retry folder access")
              : unsupported
                ? formatText(folderAccessUnavailable)
                : formatText("Add folder")
        }
        className="cowork-task-folder"
        disabled={loading || unsupported}
        title={unsupported ? formatText(folderAccessUnavailable) : undefined}
        onClick={() => {
          if (!capture().valid()) return;
          if (failed) {
            setError(undefined);
            state.retry();
          } else if (execution) setOpen(owner);
          else if (native) void add();
        }}
      >
        <FolderPlusIcon size={17} />
      </IconButton>
      {failed && (
        <span role="alert" className="cowork-folder-read-error">
          {formatText("Couldn’t load folders. Try again.")}
        </span>
      )}
      {open === owner && execution && (
        <Suspense
          fallback={<span role="status">{formatText("Loading folders…")}</span>}
        >
          <TaskFolderBrowser
            capability={execution}
            listDirectory={listDirectory}
            onSelect={add}
            onClose={() => {
              if (capture().valid()) setOpen(undefined);
            }}
          />
        </Suspense>
      )}
    </>
  );
}

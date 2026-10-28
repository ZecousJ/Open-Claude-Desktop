import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { onThisMachine } from "../../shared/types";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import { AppContext } from "../app/AppContext";
import { t } from "../i18n";
import type {
  ShareDialogState,
  ShareTarget,
} from "../conversation/ConversationShareDialog";
import { conversationShareUrl, conversationShareWritable } from "./share-link";

const initialState = (): ShareDialogState => ({
  share: undefined,
  busy: false,
  confirmStop: false,
  copied: false,
  repository: false,
});
const bridgeNow = () =>
  typeof window === "undefined" ? undefined : window.desktop;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** State belongs to one conversation/account/controller/bridge, including its
 * first render and retained callbacks. It never changes the sharing protocol. */
export function useConversationShare(
  conversation: ShareTarget,
  status?: SharingStatus,
) {
  const app = useContext(AppContext);
  const bridge = bridgeNow();
  const owner = app?.accountId,
    controller = app?.controllerScope;
  const scope = useMemo(
    () => ({
      id: conversation.id,
      owner,
      controller,
      bridge,
      mounted: true,
      reads: 0,
      repositoryReads: 0,
      operation: false,
      value: initialState(),
      target: conversation,
      status,
    }),
    [conversation.id, owner, controller, bridge],
  );
  scope.status = status;
  scope.target = conversation;
  const latest = useRef(scope);
  latest.current = scope;
  const [stored, setStored] = useState(() => ({ scope, value: scope.value }));
  const state = stored.scope === scope ? stored.value : scope.value;
  scope.value = state;
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const current = () =>
    latest.current === scope &&
    scope.mounted &&
    bridgeNow() === bridge &&
    (!app?.currentController ||
      (app.currentController.current?.accountId === owner &&
        app.currentController.current?.controllerScope === controller));
  const patch = (value: Partial<ShareDialogState>) => {
    if (!current()) return;
    const next = { ...scope.value, ...value };
    scope.value = next;
    setStored((previous) => (current() ? { scope, value: next } : previous));
  };
  useLayoutEffect(() => {
    scope.mounted = true;
    return () => {
      scope.mounted = false;
      scope.reads++;
      scope.repositoryReads++;
      clearTimeout(copiedTimer.current);
    };
  }, [scope]);

  const read = async () => {
    if (!current() || !bridge?.conversationShare) return;
    const sequence = ++scope.reads;
    patch({ checking: true, checkFailed: false, error: undefined });
    try {
      const share = await bridge.conversationShare(scope.id);
      if (current() && sequence === scope.reads)
        patch({
          share: share ?? null,
          checking: false,
          checkFailed: false,
          confirmStop: share ? scope.value.confirmStop : false,
        });
    } catch (error) {
      if (current() && sequence === scope.reads)
        patch({ checking: false, checkFailed: true, error: message(error) });
    }
  };
  useEffect(() => {
    void read();
    return bridge?.onEvent?.((event) => {
      if (
        event.type === "sharing" &&
        (!event.kind || event.kind === "conversation") &&
        (!event.sourceKey || event.sourceKey === scope.id)
      )
        void read();
    });
  }, [scope]);

  const folder =
    conversation.mode !== "chat" && onThisMachine(conversation.environment)
      ? conversation.cwd
      : undefined;
  useEffect(() => {
    const sequence = ++scope.repositoryReads;
    patch({ repository: false });
    if (!folder || !bridge?.workspaceGit) return;
    void bridge
      .workspaceGit(folder)
      .then((git) => {
        if (current() && sequence === scope.repositoryReads)
          patch({ repository: Boolean(git && git.branch !== null) });
      })
      .catch(() => {});
    return () => {
      scope.repositoryReads++;
    };
  }, [scope, folder]);

  const writable = () =>
    !scope.target.incognito &&
    !scope.target.slim &&
    conversationShareWritable(scope.status, scope.value.share);
  async function copyValue(url: string) {
    if (!current()) return;
    if (bridge?.copyText) await bridge.copyText(url);
    else await navigator.clipboard.writeText(url);
    if (!current()) return;
    patch({ copied: true });
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      if (current()) patch({ copied: false });
    }, 2000);
  }
  async function run(write: boolean, action: () => Promise<void>) {
    if (
      !current() ||
      !bridge ||
      scope.operation ||
      scope.value.share === undefined ||
      (write && !writable())
    )
      return false;
    scope.operation = true;
    scope.reads++;
    patch({ busy: true, error: undefined, notice: undefined });
    try {
      await action();
      return current();
    } catch (error) {
      if (current()) patch({ error: message(error) });
      return false;
    } finally {
      scope.operation = false;
      scope.reads++;
      if (current()) patch({ busy: false, checking: false });
    }
  }
  function received(share: HostedShare | null) {
    if (!current()) return;
    scope.reads++;
    patch({ share, checking: false, checkFailed: false, copied: false });
  }
  async function copy(_knownUrl: string) {
    if (!conversationShareUrl(scope.value.share)) return false;
    return run(false, async () => {
      const share = await bridge!.conversationShare(scope.id);
      if (!current()) return;
      received(share);
      const url = conversationShareUrl(share);
      if (!url) throw new Error("Couldn't copy the link.");
      await copyValue(url);
    });
  }
  const share = (copyAfter: boolean) =>
    run(true, async () => {
      const result = await bridge!.shareConversation(
        scope.id,
        scope.value.share?.access ?? "link",
      );
      if (!current()) return;
      received(result);
      const url = conversationShareUrl(result);
      if (copyAfter && url) await copyValue(url);
    });
  const copyNew = () => {
    if (scope.value.share !== null) return Promise.resolve(false);
    return run(true, async () => {
      const result = await bridge!.shareConversation(scope.id, "invited");
      if (!current()) return;
      received(result);
      const url = conversationShareUrl(result);
      if (url) await copyValue(url);
    });
  };
  const stop = () =>
    run(false, async () => {
      if (!scope.value.share) return;
      await bridge!.unshareConversation(scope.id);
      if (current()) received(null);
    });
  const setAccess = (access: "link" | "invited") =>
    run(true, async () => {
      const result = await bridge!.setShareAccess(scope.id, access);
      if (current()) received(result);
    });
  const invite = (email: string) =>
    run(true, async () => {
      const result = await bridge!.inviteToShare(scope.id, email);
      if (!current()) return;
      received(result.share);
      patch({
        notice: !result.added
          ? `${email} is already invited.`
          : result.mailed
            ? `Invitation sent to ${email}.`
            : `${email} is invited. This service can't send mail yet: send them the link yourself.`,
      });
    });
  const uninvite = (email: string) =>
    run(false, async () => {
      if (!scope.value.share) return;
      const result = await bridge!.removeShareInvite(scope.id, email);
      if (current()) {
        received(result);
        patch({ notice: t("Invite removed.") });
      }
    });
  const openPolicy = (url: string) => {
    if (!current() || !bridge) return;
    void bridge.openExternal(url).catch((error) => {
      if (current()) patch({ error: message(error) });
    });
  };
  return {
    state,
    patch,
    reload: read,
    copy,
    copyNew,
    share,
    stop,
    setAccess,
    invite,
    uninvite,
    openPolicy,
  };
}

import { api } from "../desktop-api";
import { showToast } from "../ui/toast-store";
import { useEffect, useRef, useLayoutEffect, useMemo } from "react";
import { useGeneratedArtifactSync } from "./ArtifactHost";
import { unavailableCloseMs } from "./App";
import { surface as buildSurface } from "../../shared/host";
import { parseDeepLink } from "../../shared/deep-links";
import type { Conversation, Attachment, Snapshot } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import type { WindowRole } from "../conversation-window/window-role";
import type { DeepLink } from "../../shared/deep-links";

/** What useAppEffects needs from App.tsx. */
export interface UseAppEffectsKit {
  active: Conversation | undefined;
  activeId: string | undefined;
  artifact: Artifact | undefined;
  conversationWindow: boolean;
  incognitoShown: boolean;
  openConversation: (
    c: Conversation,
    options?: { artifactId?: string | null | undefined } | undefined,
  ) => undefined;
  openSettingsTab: (tab: string) => void;
  report: (e: unknown) => void;
  role: WindowRole;
  runDeepLink: React.RefObject<(link: DeepLink) => void>;
  setArtifact: React.Dispatch<React.SetStateAction<Artifact | undefined>>;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setCwd: React.Dispatch<React.SetStateAction<string | undefined>>;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  setProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setProviderId: React.Dispatch<React.SetStateAction<string>>;
  setSnapshot: React.Dispatch<React.SetStateAction<Snapshot | undefined>>;
  setText: (value: React.SetStateAction<string>) => void;
  snapshot: Snapshot | undefined;
  upsert: (c: Conversation) => void;
}

export function useAppEffects(kit: UseAppEffectsKit) {
  const {
    active,
    activeId,
    artifact,
    conversationWindow,
    incognitoShown,
    openConversation,
    openSettingsTab,
    report,
    role,
    runDeepLink,
    setArtifact,
    setAttachments,
    setCwd,
    setModel,
    setProjectId,
    setProviderId,
    setSnapshot,
    setText,
    snapshot,
    upsert,
  } = kit;
  /** Moves the open conversation (and the composer's context) between projects. */
  async function moveToProject(id: string | null) {
    if (id) return addConversationToProject(id);
    if (active)
      upsert(await api.updateConversation(active.id, { projectId: null }));
    setProjectId(undefined);
  }
  async function addConversationToProject(id: string) {
    const selected = snapshot?.projects.find((value) => value.id === id);
    if (!selected) throw Error("Project no longer exists.");
    // An incognito chat is never kept, so it joins no project.
    if (active && !active.incognito) {
      upsert(await api.updateConversation(active.id, { projectId: id }));
      // The move notice's wording loads with it (kept off the first load).
      void import("../collections/projects/project-move").then(
        ({ projectMoveMessage }) =>
          showToast(projectMoveMessage([active], 1, selected.name)),
      );
    }
    setProjectId(id);
    // Incognito selects project instructions/knowledge, never its local
    // working folder (the composer deliberately offers projects only).
    if (selected.cwd && !incognitoShown) setCwd(selected.cwd);
  }
  useEffect(() => {
    const navigate = (event: Event) => {
      const tab = (event as CustomEvent<string>).detail;
      if (tab === "connectors" || tab === "capabilities") openSettingsTab(tab);
    };
    window.addEventListener("claudex:settings-navigation", navigate);
    if (
      ["connector", "connectorUrl"].some((key) =>
        new URLSearchParams(window.location.search).has(key),
      )
    )
      openSettingsTab("connectors");
    return () =>
      window.removeEventListener("claudex:settings-navigation", navigate);
  }, []);
  useGeneratedArtifactSync(snapshot?.conversations, artifact, setArtifact);
  // The web snapshot sends commands' long texts cut (a `slim` conversation,
  // shared/conversation-slim.ts): the shown one loads its full turns. A full
  // "conversation" event arriving first replaces it whole, and wins.
  const shownSlim = snapshot?.conversations.find(
    (c) => c.id === activeId && c.slim,
  )?.id;
  useEffect(() => {
    if (!shownSlim) return;
    let live = true;
    void api
      .conversationTurns(shownSlim)
      .then((full) => {
        if (!live) return;
        setSnapshot((s) =>
          s
            ? {
                ...s,
                conversations: s.conversations.map((c) =>
                  c.id === shownSlim && c.slim
                    ? { ...c, ...full, slim: false }
                    : c,
                ),
              }
            : s,
        );
      })
      .catch(() => {
        /* The cut texts stay; the next full event brings the rest. */
      });
    return () => {
      live = false;
    };
  }, [shownSlim]);
  // A separate window opens its conversation once the snapshot arrives, takes
  // the draft the main window handed over, and closes when the conversation
  // is gone (deleted, or never available to it).
  const lockedId = role.kind === "conversation" ? role.conversationId : "";
  const locked = lockedId
    ? snapshot?.conversations.find((c) => c.id === lockedId && !c.incognito)
    : undefined;
  const lockedUnavailable = Boolean(lockedId && snapshot && !locked);
  const lockedOpened = useRef(false);
  useLayoutEffect(() => {
    if (!locked || lockedOpened.current) return;
    lockedOpened.current = true;
    openConversation(locked);
    void api
      .takeWindowHandoff()
      .then((handoff) => {
        if (!handoff) return;
        setText(handoff.text);
        if (handoff.attachments) setAttachments(handoff.attachments);
        if (handoff.providerId) setProviderId(handoff.providerId);
        if (handoff.model) setModel(handoff.model);
      })
      .catch(report);
  }, [locked]);
  useEffect(() => {
    if (!lockedUnavailable) return;
    const timer = setTimeout(
      () => void api.windowAction("close").catch(() => {}),
      unavailableCloseMs,
    );
    return () => clearTimeout(timer);
  }, [lockedUnavailable]);
  // A claudex:// link that started the app arrives in the address
  // (electron/main.ts); it opens once the first snapshot is in.
  const bootLinkDone = useRef(false);
  useLayoutEffect(() => {
    if (!snapshot || bootLinkDone.current || buildSurface === "web") return;
    bootLinkDone.current = true;
    const params = new URLSearchParams(window.location.search);
    const link = parseDeepLink(params.get("deeplink") ?? "");
    if (!link) return;
    params.delete("deeplink");
    const search = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
    );
    runDeepLink.current(link);
  }, [snapshot]);
  // The Window menu and the task switcher name a separate window after its conversation.
  useEffect(() => {
    if (conversationWindow && locked) document.title = locked.title;
  }, [conversationWindow, locked?.title]);
  // Incognito chats stay out of every list, search and history.
  const listed = useMemo(
    () => (snapshot?.conversations ?? []).filter((c) => !c.incognito),
    [snapshot?.conversations],
  );
  const approvalIds = useMemo(
    () => new Set((snapshot?.approvals ?? []).map((a) => a.conversationId)),
    [snapshot?.approvals],
  );
  return {
    lockedUnavailable,
    listed,
    approvalIds,
    moveToProject,
    addConversationToProject,
  } as const;
}

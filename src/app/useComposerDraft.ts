import { useCallback, useEffect, useRef, useState } from "react";
import type { SetStateAction } from "react";
import type { ClientPolicy } from "../../shared/client-policy";
import type { Project } from "../../shared/types";
import { projectConnectorOverrides } from "../../shared/project-tools";
import type { LinearIssue } from "../../shared/linear-api";
import type { ArtifactOutputKind } from "../../shared/artifact-output";

/** Whether a new conversation starts with web search on: the administrator's default, where allowed. */
export function draftWebSearchDefault(
  policy: Pick<ClientPolicy, "webSearch" | "webSearchDefault">,
) {
  return policy.webSearch && policy.webSearchDefault;
}

/**
 * The new conversation's composer options before the first send. App.tsx keeps
 * the state here so the defaults can change without editing App.tsx.
 *
 * The window starts before the service's policy arrives (the pending policy has
 * web search off by default), so a draft the user has not touched follows the
 * policy's default when it arrives or changes; once they switch web search
 * themselves, their choice stands until the next new chat.
 */
export function useComposerDraft(policy: ClientPolicy) {
  const fallback = draftWebSearchDefault(policy);
  const [draftWebSearch, setWebSearch] = useState(fallback);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setWebSearch(fallback);
  }, [fallback]);
  const setDraftWebSearch = useCallback((value: SetStateAction<boolean>) => {
    touched.current = true;
    setWebSearch(value);
  }, []);
  const [draftLinearIssue, setDraftLinearIssue] = useState<LinearIssue>();
  const [draftArtifactOutput, setDraftArtifactOutput] =
    useState<ArtifactOutputKind>();
  type Permission =
    import("../../shared/code-session-permissions").CodePermissionMode;
  const [draftCodePermissionMode, applyDraftCodePermissionMode] =
    useState<Permission>();
  const draftCodePermissionRef = useRef<Permission>(undefined);
  const setDraftCodePermissionMode = useCallback(
    (next: SetStateAction<Permission | undefined>) => {
      const value =
        typeof next === "function"
          ? next(draftCodePermissionRef.current)
          : next;
      draftCodePermissionRef.current = value;
      applyDraftCodePermissionMode(value);
    },
    [],
  );
  const [draftAdditionalFolders, setDraftAdditionalFolders] = useState<
    string[]
  >([]);
  const [draftConnectorTools, setDraftConnectorTools] = useState<
    import("../../shared/conversation-tools").ConversationToolOverrides
  >({});
  // Connectors → Tool access for the new conversation (unset: Capabilities').
  const [draftToolSearchMode, setDraftToolSearchMode] = useState<
    import("../../shared/tool-search-mode").ToolSearchMode | undefined
  >();
  const [draftConnectors, setDraftConnectors] = useState<
    Record<string, boolean>
  >({});
  return {
    draftWebSearch,
    setDraftWebSearch,
    draftLinearIssue,
    draftArtifactOutput,
    draftCodePermissionMode,
    setDraftCodePermissionMode,
    getDraftCodePermissionMode: () => draftCodePermissionRef.current,
    setDraftArtifactOutput,
    setDraftLinearIssue,
    draftAdditionalFolders,
    setDraftAdditionalFolders,
    draftConnectorTools,
    setDraftConnectorTools,
    draftToolSearchMode,
    setDraftToolSearchMode,
    draftConnectors,
    setDraftConnectors,
    /** A new chat starts from the defaults again. */
    resetDraft: (project?: Project) => {
      touched.current = false;
      setWebSearch(
        project?.tools?.webSearch && policy.webSearch ? true : fallback,
      );
      setDraftConnectorTools({});
      setDraftToolSearchMode(undefined);
      setDraftLinearIssue(undefined);
      setDraftArtifactOutput(undefined);
      setDraftCodePermissionMode(undefined);
      setDraftAdditionalFolders([]);
      setDraftConnectors(projectConnectorOverrides(project));
    },
  };
}

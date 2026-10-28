import { useContext } from "react";
import { AppContext } from "../app/AppContext";
import type { Conversation } from "../../shared/types";
import type { SidePanel } from "../conversation/ToolSidePanel";
import type { Artifact } from "../ui/ArtifactTypes";
import { api } from "../desktop-api";
import { filesPaneAvailable } from "../files/files-model";
import { requestFileOpen } from "../files/file-open-request";

/**
 * A file the transcript asks the Changes panel to open. The panel may not be
 * mounted yet, so the request waits here until it has the file in its list.
 */
const event = "claudex:diff-file";
let pending: { conversationId: string; path: string; at: number } | undefined;

export function requestDiffFile(conversationId: string, path: string) {
  pending = { conversationId, path, at: Date.now() };
  window.dispatchEvent(new Event(event));
}

export const diffFileEvent = event;

/** The waiting request's path for this conversation, if any (a request nobody took in 10 s is stale). */
export function pendingDiffFile(conversationId: string) {
  return pending?.conversationId === conversationId &&
    Date.now() - pending.at < 10_000
    ? pending.path
    : undefined;
}

export function clearDiffFile() {
  pending = undefined;
}

/** Whether a changed file's path from a row is the panel's file (one may be relative to the folder). */
export function sameDiffFile(rowPath: string, panelPath: string) {
  const a = rowPath.replaceAll("\\", "/");
  const b = panelPath.replaceAll("\\", "/");
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** A path as the session folder names it (relative inside it). */
function inFolder(conversation: Conversation, path: string) {
  const cwd = conversation.cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = path.replace(/\\/g, "/");
  return cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : path;
}

/**
 * A changed file a transcript row or card names, opened where the original
 * opens it. Without a file pane it is the Changes panel either way.
 */
export function openChangedFile(
  conversation: Conversation,
  path: string,
  panes: {
    setPanel: (panel: SidePanel) => void;
    setArtifact: (artifact: Artifact | undefined) => void;
  },
) {
  const diff = () => {
    panes.setPanel("changes");
    panes.setArtifact(undefined);
    requestDiffFile(conversation.id, path);
  };
  if (!filesPaneAvailable(conversation)) return diff();
  const file = () => {
    requestFileOpen(conversation.id, inFolder(conversation, path));
    panes.setArtifact(undefined);
    panes.setPanel("files");
  };
  void Promise.resolve()
    .then(() => api.codeGitStatus(conversation.id))
    .then((status) => (status?.state === "ready" ? diff() : file()), file);
}

/** Opens one changed file (openChangedFile); undefined where there is no open Code session. */
export function useOpenDiffFile() {
  const app = useContext(AppContext);
  const active = app?.active;
  return app && active
    ? (path: string) => openChangedFile(active, path, app)
    : undefined;
}

import { useRef, useState } from "react";
import {
  MessageSquare,
  Maximize2,
  Minimize2,
  X,
  ChevronDown,
} from "../ui/glyphs";
import type { Artifact } from "../ui/ArtifactTypes";
import { useApp } from "../app/AppContext";
import { useBlankArtifact } from "./useBlankArtifact";
import { BlankArtifactEditor } from "./BlankArtifactEditor";
import { BlankArtifactWorkspace } from "./BlankArtifactWorkspace";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { usePaneExpandToggle } from "../app/pane-expand";
import { t, tc } from "../i18n";
import { ArtifactCurrentUser } from "./ArtifactCurrentUser";
import { Anthropicon } from "../ui/anthropicons";
import {
  artifactChatLabel,
  guardArtifactNavigation,
  relatedArtifactSessions,
} from "./related-sessions";
import "./blank-artifact.css";
/** Real workspace-backed blank editors. Sharing and comments are conditional
 * capabilities; an empty idle Chat does not manufacture a published target. */
export function BlankArtifactPanel({
  artifact,
  fullPage = false,
  onChat,
  onClose,
  width = 50,
  onResize,
  onError,
}: {
  artifact: Artifact;
  fullPage?: boolean;
  onChat?: () => void;
  onClose: () => void;
  width?: number;
  onResize?: (width: number) => void;
  onError: (error: unknown) => void;
}) {
  const app = useApp(),
    source = useBlankArtifact(artifact),
    root = useRef<HTMLElement>(null),
    [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded(!expanded);
  const openChat = onChat && guardArtifactNavigation(app, artifact, onChat);
  usePaneExpandToggle("artifact", toggle);
  const close = () => source.beforeLeave(onClose);
  return (
    <aside
      ref={root}
      className={`${fullPage ? "" : "work-panel "}artifact-panel artifact-collaboration blank-artifact-panel${expanded && !fullPage ? " expanded" : ""}`}
      data-expanded={fullPage || expanded}
      data-standalone={fullPage || undefined}
      data-blank-kind={artifact.blankArtifact!.kind}
      aria-label={`${t("Artifact panel")}: ${artifact.name}`}
    >
      {!fullPage && !expanded && (
        <PanelResizeHandle width={width} panel={root} onResize={onResize} />
      )}
      <header className="blank-artifact-header">
        {fullPage && typeof app.newChat === "function" && (
          <a
            className="blank-artifact-home"
            href="/new"
            aria-label={tc("link", "Home")}
            onClick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              source.beforeLeave(() => app.newChat("chat"));
            }}
          >
            <Anthropicon name="Home" size={16} />
          </a>
        )}
        <span className="blank-artifact-title">{artifact.name}</span>
        <div className="blank-artifact-header-actions">
          {fullPage && (
            <ArtifactCurrentUser
              name={app.snapshot.settings?.name ?? t("You")}
            />
          )}
          {fullPage && openChat && (
            <button
              type="button"
              aria-label={artifactChatLabel(
                relatedArtifactSessions(app.snapshot, artifact).length,
              )}
              onClick={() => source.beforeLeave(openChat)}
            >
              <MessageSquare size={13} />
              {t("Chat")}
            </button>
          )}
          {!fullPage && (
            <button
              type="button"
              aria-label={t(expanded ? "Collapse" : "Expand")}
              onClick={toggle}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          <button type="button" aria-label={t("Close")} onClick={close}>
            <X size={14} />
          </button>
        </div>
      </header>
      <BlankArtifactWorkspace
        source={source}
        renderEditor={(props) => (
          <BlankArtifactEditor
            {...props}
            artifact={artifact}
            kind={artifact.blankArtifact!.kind}
            onError={onError}
          />
        )}
      />
    </aside>
  );
}

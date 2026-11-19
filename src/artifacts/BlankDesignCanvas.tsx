import type { BlankArtifact } from "../../shared/blank-artifacts";
import type { Conversation, Turn } from "../../shared/types";
import { t } from "../i18n";
import { ArrowLeft } from "../ui/glyphs";
import { BlankArtifactWorkspace } from "./BlankArtifactWorkspace";
import { DesignEditor } from "./DesignEditor";
import type { BlankArtifactBridge } from "./blank-artifact-flush";
import { useBlankArtifactDocument } from "./useBlankArtifact";

export type BlankDesignConversation = Pick<Conversation, "id" | "updatedAt"> & {
  blankArtifact: BlankArtifact;
  lastTurn?: Pick<Turn, "id" | "status">;
};

export function BlankDesignCanvas({
  accountId,
  owner,
  bridge,
  conversation,
  title = conversation.blankArtifact.name,
  isCurrent,
  onBack,
}: {
  accountId: string;
  owner?: object;
  bridge: BlankArtifactBridge;
  conversation: BlankDesignConversation;
  title?: string;
  isCurrent?: () => boolean;
  onBack?: () => void;
}) {
  const source = useBlankArtifactDocument({
    accountId,
    owner,
    bridge,
    conversationId: conversation.id,
    artifactId: conversation.blankArtifact.id,
    updatedAt: conversation.updatedAt,
    lastTurn: conversation.lastTurn,
    isCurrent,
  });
  return (
    <main
      className="blank-artifact-panel"
      data-standalone
      data-blank-kind="design"
      aria-label={title}
    >
      <header className="blank-artifact-header">
        <span className="blank-artifact-title">{title}</span>
        {onBack && (
          <div className="blank-artifact-header-actions">
            <button type="button" onClick={() => source.beforeLeave(onBack)}>
              <ArrowLeft size={16} />
              {t("Back to artifacts")}
            </button>
          </div>
        )}
      </header>
      <BlankArtifactWorkspace
        source={source}
        renderEditor={(props) => <DesignEditor {...props} />}
      />
    </main>
  );
}

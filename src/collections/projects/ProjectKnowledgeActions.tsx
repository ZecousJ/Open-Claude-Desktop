import { Search, Plus, X } from "../../ui/glyphs";
import { knowledgeFull, capacityReason } from "./knowledge-drop";
import { WithTooltip } from "../../ui/Tooltip";
import { t } from "../../i18n";
import { Spinner } from "../../ui/Spinner";
import type { KnowledgeSnapshot } from "./KnowledgeList";

/** What ProjectKnowledgeActions needs from ProjectKnowledgeView.tsx. */
export interface PrjKnowledgeActionsProps {
  addButton: React.RefObject<HTMLButtonElement | null>;
  busy: boolean;
  canEdit: boolean;
  cancelSelection: () => void;
  contextDialog: boolean;
  knowledge: KnowledgeSnapshot | undefined;
  menu: boolean;
  onCloseContext: (() => void) | undefined;
  previewOpen: boolean;
  query: string | null;
  scope: string[];
  selectButton: React.RefObject<HTMLButtonElement | null>;
  selecting: boolean;
  setMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setSelecting: React.Dispatch<React.SetStateAction<boolean>>;
  twoPane: boolean;
}

export function ProjectKnowledgeActions({
  addButton,
  busy,
  canEdit,
  cancelSelection,
  contextDialog,
  knowledge,
  menu,
  onCloseContext,
  previewOpen,
  query,
  scope,
  selectButton,
  selecting,
  setMenu,
  setQuery,
  setSelecting,
  twoPane,
}: PrjKnowledgeActionsProps) {
  return (
    <span className="prj-knowledge-actions">
      {knowledge && knowledge.files.length > 0 && (
        <button
          type="button"
          aria-label="Search files"
          className="prj-context-search-toggle"
          aria-pressed={query !== null}
          onClick={() => setQuery(query === null ? "" : null)}
        >
          <Search size={contextDialog ? 20 : 15} strokeWidth={1.6} />
        </button>
      )}
      {canEdit && knowledge && (scope.length > 0 || selecting) && (
        <button
          ref={selectButton}
          type="button"
          className="prj-context-select"
          aria-pressed={selecting}
          onClick={() => (selecting ? cancelSelection() : setSelecting(true))}
        >
          Select
        </button>
      )}
      {canEdit &&
        (knowledgeFull(knowledge) && !busy ? (
          // Full: the + stays, disabled, and says why.
          <WithTooltip label={t(capacityReason)}>
            {(props) => (
              <button
                {...props}
                type="button"
                className="unavailable"
                aria-label="Add to context"
                aria-disabled="true"
              >
                <Plus size={16} strokeWidth={1.6} />
              </button>
            )}
          </WithTooltip>
        ) : (
          <button
            ref={addButton}
            type="button"
            aria-label="Add to context"
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            disabled={!knowledge || busy}
            onClick={() => setMenu(!menu)}
          >
            {busy ? (
              <Spinner inheritColor size={15} className="spin" />
            ) : contextDialog ? (
              t("Add")
            ) : (
              <Plus size={16} strokeWidth={1.6} />
            )}
          </button>
        ))}
      {contextDialog && onCloseContext && (
        <button
          type="button"
          className="prj-context-close"
          aria-label={t("Close")}
          hidden={previewOpen && twoPane}
          onClick={onCloseContext}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

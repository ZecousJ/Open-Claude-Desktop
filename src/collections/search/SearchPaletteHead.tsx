import { t } from "../../i18n";
import { paletteFilterLabels } from "./search-filters";
import type {
  PaletteFilters,
  PaletteFilterOption,
  PaletteFilterKey,
} from "./search-filters";
import { X } from "../../ui/glyphs";
import { surface } from "../../../shared/host";
import { AppIcon } from "../../ui/app-icon";
import { Spinner } from "../../ui/Spinner";
import type { SearchEntrypoint } from "./palette-events";
import type { SearchRow } from "./search-model";

/** What SearchPaletteHead needs from SearchPaletteView.tsx. */
export interface SearchPaletteHeadProps {
  activeIndex: number;
  deeper: {
    hits:
      | {
          conversationId: string;
          title: string;
          mode: "chat" | "cowork" | "code";
          archived: boolean;
          updatedAt: number;
          projectId?: string | undefined;
          turnId?: string | undefined;
          snippet?: string | undefined;
        }[]
      | undefined;
    titlesOnly: boolean;
    pending: boolean;
  };
  entrypoint: SearchEntrypoint;
  filterLabelId: string;
  filterOptions: PaletteFilterOption[];
  filters: Partial<Record<PaletteFilterKey, { value: string; label: string }>>;
  input: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onEntrypointChange: ((entrypoint: SearchEntrypoint) => void) | undefined;
  onQueryChange: (query: string) => void;
  picker: { key?: PaletteFilterKey | undefined; query: string } | undefined;
  placeholder:
    | "Search"
    | "Search sessions and projects"
    | "Search chats and projects"
    | "Search actions"
    | "Search or start a session"
    | "Search or start a chat";
  query: string;
  rows: SearchRow[];
  searchKeys: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  setActive: (index: number) => void;
  setFilters: React.Dispatch<
    React.SetStateAction<
      Partial<Record<PaletteFilterKey, { value: string; label: string }>>
    >
  >;
}

export function SearchPaletteHead({
  activeIndex,
  deeper,
  entrypoint,
  filterLabelId,
  filterOptions,
  filters,
  input,
  onClose,
  onEntrypointChange,
  onQueryChange,
  picker,
  placeholder,
  query,
  rows,
  searchKeys,
  setActive,
  setFilters,
}: SearchPaletteHeadProps) {
  return (
    <div className="search-palette-head" data-entrypoint={entrypoint}>
      {/* Search mode: the Search glyph alone; Actions mode: a bordered chip with
         the Keyboard glyph and the clear cross. */}
      {entrypoint === "search" && (
        <span
          className="search-mode-glyph"
          aria-label={t("Search mode")}
          role="img"
        >
          <AppIcon name="Search" size={20} />
        </span>
      )}
      {entrypoint === "actions" && (
        <div className="search-mode-chip">
          <span aria-label={t("Actions mode")} role="img">
            <AppIcon name="Keyboard" size={20} />
          </span>
          <button
            type="button"
            aria-label={t("Clear filter")}
            onClick={() => onEntrypointChange?.("default")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {Object.entries(filters).map(([key, selected]) => (
        <div
          key={key}
          className="search-filter-chip"
          role="group"
          aria-labelledby={`${filterLabelId}-${key}`}
        >
          <span id={`${filterLabelId}-${key}`} hidden>
            {t(paletteFilterLabels[key as keyof PaletteFilters])}{" "}
            <span
              data-no-translate={
                key === "repo" || key === "project" || undefined
              }
            >
              {key === "repo" || key === "project"
                ? selected.label
                : t(selected.label)}
            </span>
          </span>
          <span
            data-no-translate={key === "repo" || key === "project" || undefined}
          >
            {key === "repo" || key === "project"
              ? selected.label
              : t(selected.label)}
          </span>
          <button
            type="button"
            aria-label={t("Clear filter")}
            onClick={() => {
              setFilters((current) => {
                const next = { ...current };
                delete next[key as keyof PaletteFilters];
                return next;
              });
              setActive(0);
              input.current?.focus();
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <input
        ref={input}
        role="combobox"
        aria-expanded="true"
        aria-controls="search-palette-results"
        aria-activedescendant={
          picker
            ? filterOptions.length
              ? `search-filter-${activeIndex}`
              : undefined
            : rows.length
              ? `search-row-${activeIndex}`
              : undefined
        }
        aria-label={t("Search")}
        placeholder={t(placeholder)}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={searchKeys}
      />
      {deeper.pending && (
        <span
          className="search-palette-loading"
          role="status"
          aria-label={t("Searching deeper...")}
        >
          <Spinner inheritColor size={16} aria-hidden="true" />
        </span>
      )}
      <button type="button" aria-label="Close" onClick={onClose}>
        {/* The web's 20px X. */}
        <X size={surface === "web" ? 20 : 18} strokeWidth={1.5} />
      </button>
    </div>
  );
}

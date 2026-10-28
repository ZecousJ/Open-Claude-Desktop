import { PageHeader, Segmented } from "../controls";
import {
  connectorFilterTitle,
  ConnectorFilterButton,
} from "./ConnectorDirectory";
import { Search, Plus, ChevronDown } from "../../ui/glyphs";
import type { MenuPosition } from "../../ui/Menu";
import type {
  CatalogueConnector,
  ConnectorType,
  ConnectorFilter,
} from "../../../shared/connectors-catalogue";

/** What ConnectorsHeader needs from ConnectorsView.tsx. */
export interface ConnectorsPart1Props {
  addButton: React.RefObject<HTMLButtonElement | null>;
  addMenu: MenuPosition | undefined;
  allListed: boolean;
  directoryEntries: CatalogueConnector[];
  directoryFilter: {
    query: string;
    topic?: string | undefined;
    type:
      | "all"
      | "new"
      | "trending"
      | "inChatUi"
      | "desktopExtension"
      | ConnectorType;
  };
  query: string;
  setAddMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setAllListed: React.Dispatch<React.SetStateAction<boolean>>;
  setFilter: React.Dispatch<
    React.SetStateAction<Omit<ConnectorFilter, "query">>
  >;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  setView: React.Dispatch<React.SetStateAction<"yours" | "discover">>;
  view: "yours" | "discover";
}

export function ConnectorsHeader({
  addButton,
  addMenu,
  allListed,
  directoryEntries,
  directoryFilter,
  query,
  setAddMenu,
  setAllListed,
  setFilter,
  setQuery,
  setView,
  view,
}: ConnectorsPart1Props) {
  return (
    <PageHeader
      title={
        allListed && view === "discover"
          ? connectorFilterTitle(directoryFilter.type)
          : "Connectors"
      }
    >
      <div className="directory-view-switch">
        {!allListed && (
          <Segmented<"yours" | "discover">
            label="Connectors view"
            value={view}
            options={[
              { value: "yours", label: "Yours" },
              { value: "discover", label: "Discover" },
            ]}
            onChange={(value) => {
              setView(value);
              setAllListed(false);
            }}
          />
        )}
      </div>
      <label className="settings-page-search">
        <Search size={16} />
        <input
          placeholder="Search connectors"
          aria-label="Search connectors"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <ConnectorFilterButton
        filter={directoryFilter}
        onChange={({ query: _query, ...next }) => setFilter(next)}
        entries={directoryEntries}
      />
      <button
        ref={addButton}
        type="button"
        className="desktop-add-button"
        aria-haspopup="menu"
        aria-expanded={Boolean(addMenu)}
        onClick={() => {
          const rect = addButton.current!.getBoundingClientRect();
          setAddMenu(
            addMenu
              ? undefined
              : {
                  right: innerWidth - rect.right,
                  top: rect.bottom + 4,
                },
          );
        }}
      >
        <Plus size={16} strokeWidth={1.75} />
        Add connector
        <ChevronDown size={14} strokeWidth={1.75} />
      </button>
    </PageHeader>
  );
}

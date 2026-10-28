import { Plus, X } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { BrowserTabState } from "../../shared/browser";
import { tabTitle } from "./browser-model";

/**
 * The card's first row, left side. One tab shows as its title; with several,
 * each is a button, the open one brighter, with a × to close it. A right click
 * offers Close tab / Close other tabs.
 */
export function BrowserTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNewTab,
  onContextMenu,
}: {
  tabs: BrowserTabState[];
  activeTabId?: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  onContextMenu: (tabId: string, x: number, y: number) => void;
}) {
  const several = tabs.length > 1;
  const active = activeTabId ?? tabs[0]?.id;
  return (
    <div
      className="browser-tabs u-scroll-fade-x"
      role="tablist"
      aria-label="Tabs"
    >
      {tabs.map((tab) => {
        const title = tabTitle(tab);
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            className={`browser-tab${selected ? " selected" : ""}${several ? " several" : ""}`}
          >
            <button
              role="tab"
              aria-selected={selected}
              className="browser-tab-title"
              title={tab.url || title}
              onClick={() => onSelect(tab.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(tab.id, event.clientX, event.clientY);
              }}
            >
              {tab.loading && (
                <Spinner
                  inheritColor
                  size={12}
                  className="spin"
                  label="Loading"
                />
              )}
              <span>{title}</span>
            </button>
            {several && (
              <button
                className="browser-tab-close"
                aria-label={`Close ${title}`}
                title="Close tab"
                onClick={() => onClose(tab.id)}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      <button
        className="browser-icon-button browser-new-tab"
        aria-label="New tab"
        title="New tab"
        onClick={onNewTab}
      >
        <Plus size={15} strokeWidth={1.6} />
      </button>
    </div>
  );
}

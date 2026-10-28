import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  useContext,
  useLayoutEffect,
  useMemo,
} from "react";
import { Search, X, ArrowUpRight } from "../ui/glyphs";
import { KeyIcon } from "../ui/icons";
import { AppContext } from "../app/AppContext";
import type { Settings as SettingsType, Snapshot } from "../../shared/types";
import type { TabProps } from "./context";
import { useHost } from "../host/HostContext";
import { formatText, tf } from "../i18n";
import {
  availableNavGroups,
  openableTab,
  tabAvailable,
  type TabId,
} from "./nav";
import { NoResultsIcon } from "../ui/SettingsIcons";
import { useDialogOverlay } from "../ui/dialog-stack";
import { settingsSearchIndexForHost } from "./search/pages";
import {
  matchingRow,
  searchSettings,
  searchText,
  settingsSearchKey,
  type SearchHit,
} from "./search/registry";
import { AccountTab } from "./tabs/Account";
import { GeneralTab } from "./tabs/General";
import { MemoryTab } from "./tabs/Memory";
import { ReflectTab } from "./tabs/Reflect";
import { TimeAndFocusTab } from "./tabs/TimeAndFocus";
import { lazyPiece } from "../ui/lazy-piece";
import { useMediaQuery } from "../ui/useMediaQuery";
import { SettingsTabArrows } from "./SettingsTabArrows";
import { settingsPatchQueue } from "./settings-patch-queue";
import type { SettingsSkillsView } from "./skills-navigation";

// The directory pages carry their own catalogue and styles; loading them on
// first open keeps them out of the web build's first load.
// The pages drawing the original's disabled rows load their styles with
// them (original-rows.css), off the web build's first load.
const DeveloperTab = lazyPiece(
  () => import("./tabs/Developer"),
  "DeveloperTab",
);
const CapabilitiesTab = lazyPiece(
  () => import("./tabs/Capabilities"),
  "CapabilitiesTab",
);
const ChromeTab = lazyPiece(() => import("./tabs/Chrome"), "ChromeTab");
const ClaudeCodeTab = lazyPiece(
  () => import("./tabs/ClaudeCode"),
  "ClaudeCodeTab",
);
const CoworkTab = lazyPiece(() => import("./tabs/Cowork"), "CoworkTab");
const SystemTab = lazyPiece(() => import("./tabs/System"), "SystemTab");
const NetworkTab = lazyPiece(() => import("./tabs/Network"), "NetworkTab");
// Skills and Connectors browse the directory Customize shares (and its
// styles), loaded with the page.
// Its placeholders and styles load with the page, not with Settings.
const UsageTab = lazyPiece(() => import("./tabs/Usage"), "UsageTab");
const SkillsTab = lazyPiece(() => import("./tabs/Skills"), "SkillsTab");
const ConnectorsTab = lazyPiece(
  () => import("./tabs/Connectors"),
  "ConnectorsTab",
);
const DesignSystemsTab = lazyPiece(
  () => import("./tabs/DesignSystems"),
  "DesignSystemsTab",
);
const ImportTab = lazyPiece(() => import("./tabs/Import"), "ImportTab");
const ExtensionsTab = lazyPiece(
  () => import("./tabs/Extensions"),
  "ExtensionsTab",
);
// Billing brings the checkout dialog, Privacy its reporting controls: both
// load on first open, off the web build's first load.
const BillingTab = lazyPiece(() => import("./tabs/Billing"), "BillingTab");
const PrivacyTab = lazyPiece(() => import("./tabs/Privacy"), "PrivacyTab");
const PluginsTab = lazyPiece(() => import("./tabs/Plugins"), "PluginsTab");

const pages: Record<TabId, ComponentType<TabProps>> = {
  general: GeneralTab,
  account: AccountTab,
  privacy: PrivacyTab,
  billing: BillingTab,
  usage: UsageTab,
  capabilities: CapabilitiesTab,
  memory: MemoryTab,
  design: DesignSystemsTab,
  reflect: ReflectTab,
  time: TimeAndFocusTab,
  code: ClaudeCodeTab,
  cowork: CoworkTab,
  chrome: ChromeTab,
  system: SystemTab,
  network: NetworkTab,
  extensions: ExtensionsTab,
  import: ImportTab,
  developer: DeveloperTab,
  skills: SkillsTab,
  connectors: ConnectorsTab,
  plugins: PluginsTab,
};

const focusable =
  "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)";

/** The Settings modal: a searchable page list and the selected page. */
export function Settings({
  settings,
  platform,
  engine,
  email,
  planUsage = false,
  initialTab = "general",
  onSave,
  onSignOut,
  onSignOutEverywhere,
  onClose,
  onError,
  onTabChange,
  skillsView,
  skillsViewKey,
  skillsViewRequestId,
  onSkillsViewChange,
}: {
  settings: SettingsType;
  platform: NodeJS.Platform;
  engine: Snapshot["engine"];
  email?: string;
  /** The account has a Sub2API plan, so the Usage page exists. */
  planUsage?: boolean;
  initialTab?: string;
  onSave: (settings: SettingsType) => void;
  onSignOut?: () => Promise<void>;
  onSignOutEverywhere?: () => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => void;
  /** The page shown changed (the web app keeps /settings/<tab> in step). */
  onTabChange?: (tab: TabId) => void;
  skillsView?: SettingsSkillsView;
  skillsViewKey?: string;
  skillsViewRequestId?: number;
  onSkillsViewChange?: (view: SettingsSkillsView) => void;
}) {
  const host = useHost();
  const narrow = useMediaQuery("(max-width: 767.98px)");
  const app = useContext(AppContext);
  // Pages this host has no use for do not open (nav.tsx tabAvailable).
  const [tab, setTab] = useState<TabId>(() =>
    openableTab(initialTab, host, planUsage),
  );
  const [navFocus, setNavFocus] = useState<TabId>(tab);
  useEffect(() => setNavFocus(tab), [tab]);
  const [current, setCurrent] = useState(settings);
  const [search, setSearch] = useState("");
  // The result list under the field shows while the field has focus.
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeHit, setActiveHit] = useState(0);
  // The row a search result points at, scrolled to once its page shows.
  const [found, setFound] = useState<{ row: string; query: string }>();
  useLayoutEffect(() => {
    if (skillsViewRequestId === undefined) return;
    setFound(undefined);
    setTab(openableTab("skills", host, planUsage));
  }, [skillsViewRequestId, skillsViewKey]);
  const dialog = useRef<HTMLDivElement>(null);
  const overlay = useDialogOverlay();
  const page = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    dialog.current
      ?.querySelector<HTMLElement>(
        '.settings-search-pop [aria-selected="true"]',
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [activeHit, searchOpen]);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const writes = useMemo(
    () =>
      bridge ? settingsPatchQueue(bridge, settings, app?.accountId) : undefined,
    [bridge, app?.accountId],
  );
  useLayoutEffect(() => writes?.subscribe(setCurrent), [writes]);
  useLayoutEffect(() => writes?.rebase(settings), [writes, settings]);
  // The caller names another page while Settings is open (on the web, back
  // and forward between /settings/<tab> addresses). The echo of a page this
  // dialog opened itself (onTabChange) names the page already shown: it
  // keeps the search result's row marked.
  const named = useRef(initialTab);
  useEffect(() => {
    if (named.current === initialTab) return;
    named.current = initialTab;
    const next = openableTab(initialTab, host, planUsage);
    if (next === shown.current) return;
    setFound(undefined);
    setTab(next);
  }, [initialTab]);
  // Starts at the name asked for, so a name that opened another page
  // (an alias, or a page this host lacks) is reported too.
  const shown = useRef<string>(initialTab);
  useEffect(() => {
    if (shown.current === tab) return;
    shown.current = tab;
    onTabChange?.(tab);
  }, [tab]);
  // The open page stays in view in the narrow window's tab row and in a short
  // page list.
  useEffect(() => {
    nav.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  // Scroll to the row a search result named and mark it for a moment.
  useEffect(() => {
    if (!found) return;
    const locate = () => {
      const rows = [
        ...(page.current?.querySelectorAll<HTMLElement>("[data-setting]") ??
          []),
      ];
      const index = matchingRow(
        rows.map((row) => row.dataset.setting ?? ""),
        found.row,
        found.query,
      );
      return index >= 0 ? rows[index] : undefined;
    };
    let row = locate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Pages that load their rows show them a moment later.
    const reveal = (attempt: number) => {
      row = row ?? locate();
      if (!row) {
        if (attempt < 10) timer = setTimeout(() => reveal(attempt + 1), 50);
        return;
      }
      row.scrollIntoView({ block: "center" });
      row.classList.add("settings-row-found");
      const shown = row;
      timer = setTimeout(
        () => shown.classList.remove("settings-row-found"),
        1600,
      );
    };
    reveal(0);
    return () => {
      clearTimeout(timer);
      row?.classList.remove("settings-row-found");
    };
  }, [found, tab]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // The dialog itself takes focus, with no ring and no caret in the search
    // field; Tab then starts at the Close button.
    dialog.current?.focus();
    // On window, so an open menu inside can stop Escape at the document first.
    const key = (event: KeyboardEvent) => {
      // The checkout page over Billing closes alone: it listens for Escape too.
      if (event.key === "Escape" && !document.querySelector(".checkout-page"))
        onClose();
      if (event.key !== "Tab") return;
      const nodes = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(focusable) ?? []),
      ];
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0].focus();
      }
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);

  const save = (
    patch: Partial<SettingsType>,
    failure?: string,
    onFailure?: (error: unknown) => void,
  ) => {
    if (!writes) return Promise.resolve(false);
    return writes.update(patch, onSave, (error) => {
      if (onFailure) onFailure(error);
      else onError(failure ? new Error(failure) : error);
    });
  };

  const available = availableNavGroups(host, planUsage);
  const allTabs = available.flatMap((group) => group.tabs);
  // The search lists its results in a popover under the field; the page list
  // itself stays whole.
  const results = search.trim()
    ? searchSettings(
        search,
        allTabs,
        settingsSearchIndexForHost(host.capabilities.cloudCode),
      )
    : [];
  // Opening a page from the page list while searching goes to the row the
  // search found on it, if any.
  const open = (id: TabId, row?: string) => {
    setTab(id);
    row ??= search.trim()
      ? results.find((hit) => hit.tab === id && hit.row)?.row
      : undefined;
    setFound(row ? { row, query: search } : undefined);
    setSearchOpen(false);
  };
  const openHit = (hit: SearchHit) => {
    open(hit.tab, hit.row);
    setSearch("");
    setActiveHit(0);
    nav.current?.querySelector("input")?.blur();
  };
  const Page = pages[tab];

  return (
    <div
      {...overlay}
      className="settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        ref={dialog}
      >
        {/* First in the tab order: Tab from the last control wraps to it. Narrow
           windows show it beside the title. */}
        <button className="settings-close" aria-label="Close" onClick={onClose}>
          <X size={20} strokeWidth={1.5} />
        </button>
        <h1 className="settings-narrow-title">Settings</h1>
        <div className="settings-nav-wrap">
          <nav
            className="settings-nav u-scroll-fade-x"
            aria-label={narrow ? "Settings" : "Settings pages"}
            role={narrow ? "tablist" : undefined}
            ref={nav}
            onKeyDown={(event) => {
              // Arrow keys move focus between pages without opening them;
              // Enter or Space opens the focused one.
              const keys = narrow
                ? ["ArrowRight", "ArrowLeft"]
                : ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"];
              const edge = narrow && ["Home", "End"].includes(event.key);
              if (!edge && !keys.includes(event.key)) return;
              const buttons = [
                ...(nav.current?.querySelectorAll<HTMLButtonElement>(
                  ".settings-nav-group > button",
                ) ?? []),
              ];
              const at = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (at < 0) return;
              event.preventDefault();
              const step = keys.indexOf(event.key) < (narrow ? 1 : 2) ? 1 : -1;
              const next = edge
                ? event.key === "Home"
                  ? 0
                  : buttons.length - 1
                : (at + step + buttons.length) % buttons.length;
              buttons[next].focus();
            }}
          >
            <label className="settings-search">
              <Search size={20} strokeWidth={1.5} />
              <input
                placeholder="Search"
                aria-label="Search settings"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setActiveHit(0);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => {
                  setSearchOpen(false);
                  setSearch("");
                  setActiveHit(0);
                }}
                onKeyDown={(event) => {
                  const action = settingsSearchKey(
                    event.key,
                    search,
                    event.nativeEvent.isComposing,
                  );
                  if (!action) return;
                  if (action === "leave") {
                    setSearch("");
                    setActiveHit(0);
                    setSearchOpen(false);
                    return;
                  }
                  event.preventDefault();
                  if (action === "select") {
                    const hit =
                      results[Math.min(activeHit, results.length - 1)];
                    if (hit) openHit(hit);
                  }
                  if (action === "next" || action === "previous") {
                    const step = action === "next" ? 1 : -1;
                    setActiveHit(
                      results.length
                        ? (activeHit + step + results.length) % results.length
                        : 0,
                    );
                  }
                  if (action === "dismiss") {
                    event.stopPropagation();
                    setSearch("");
                    setActiveHit(0);
                    setSearchOpen(false);
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
            {available.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <span className="settings-nav-label">{group.label}</span>
                {group.tabs.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    role={narrow ? "tab" : undefined}
                    aria-selected={narrow ? tab === id : undefined}
                    tabIndex={narrow ? (navFocus === id ? 0 : -1) : undefined}
                    aria-current={tab === id ? "page" : undefined}
                    onFocus={() => narrow && setNavFocus(id)}
                    onClick={() => open(id)}
                  >
                    <Icon size={20} strokeWidth={1.5} />
                    {label}
                  </button>
                ))}
              </div>
            ))}
            <div className="settings-nav-group">
              <span className="settings-nav-label">Platform</span>
              <a
                className="settings-platform-link"
                href="/api"
                onClick={(event) => {
                  if (
                    !app ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onClose();
                  app.setPage("api");
                }}
              >
                <KeyIcon size={20} />
                API keys
                <ArrowUpRight size={20} />
              </a>
            </div>
          </nav>
          {narrow && <SettingsTabArrows nav={nav} />}
        </div>
        {searchOpen && search.trim() && (
          <div
            className="settings-search-pop"
            role={results.length ? "listbox" : "status"}
            aria-label="Search results"
            // Keeps the field focused while a result is clicked.
            onMouseDown={(event) => event.preventDefault()}
          >
            {results.length ? (
              results.map((hit, index) => {
                const { label, Icon } = allTabs.find((t) => t.id === hit.tab)!;
                const key = `${hit.kind}:${hit.tab}:${hit.row ?? ""}`;
                // A row listed under its page, or the count of the rest.
                if (hit.kind !== "page") {
                  const count = hit.count ?? 0;
                  return (
                    <button
                      key={key}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === activeHit}
                      aria-label={
                        hit.kind === "child"
                          ? tf("{row} in {section}", {
                              row: hit.row ?? "",
                              section: label,
                            })
                          : tf(
                              count === 1
                                ? "1 more match in {section}"
                                : "{count} more matches in {section}",
                              { count, section: label },
                            )
                      }
                      className={`${hit.kind}${index === activeHit ? " active" : ""}`}
                      onMouseEnter={() => setActiveHit(index)}
                      onClick={() => openHit(hit)}
                    >
                      {hit.kind === "child" ? (
                        <span className="match">{hit.row}</span>
                      ) : (
                        <span>{formatText("+{count} more", { count })}</span>
                      )}
                    </button>
                  );
                }
                // A row named like its page is the page's own match.
                const row =
                  hit.row && searchText(hit.row) !== searchText(label)
                    ? hit.row
                    : undefined;
                return (
                  <button
                    key={key}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === activeHit}
                    className={index === activeHit ? "active" : undefined}
                    onMouseEnter={() => setActiveHit(index)}
                    onClick={() => openHit(hit)}
                  >
                    <Icon size={20} strokeWidth={1.5} />
                    <span className={row ? undefined : "match"}>{label}</span>
                    {row && <small className="match">{row}</small>}
                  </button>
                );
              })
            ) : (
              <>
                <NoResultsIcon size={24} strokeWidth={1.5} />
                <p>No matching settings</p>
              </>
            )}
          </div>
        )}
        <main className="settings-page" key={tab} ref={page}>
          <Suspense fallback={null}>
            <Page
              key={tab === "skills" ? skillsViewKey : undefined}
              skillsView={tab === "skills" ? skillsView : undefined}
              onSkillsViewChange={onSkillsViewChange}
              settings={current}
              save={save}
              platform={platform}
              engine={engine}
              email={email}
              onSignOut={onSignOut}
              onSignOutEverywhere={onSignOutEverywhere}
              onError={onError}
              goTo={(id) => {
                if (!tabAvailable(id, host, planUsage)) return;
                setFound(undefined);
                setTab(id);
              }}
            />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

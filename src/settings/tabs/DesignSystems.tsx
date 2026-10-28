import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info, MoreVertical, ChevronDown, Plus, X } from "../../ui/glyphs";
import type {
  DesignSource,
  DesignSystem,
} from "../../../shared/collections-api";
import { preference } from "../../../shared/settings-extras";
import { formatText, t, useLocale } from "../../i18n";
import { ConfirmationDialog } from "../../dialogs/ConfirmationDialog";
import { Menu, type MenuPosition } from "../../ui/Menu";
import {
  findDesignSystems,
  formatPublished,
} from "../directory/directory-helpers";
import type { TabProps } from "../context";
import "../desktop.css";
import "../directory/directory.css";
import { DesignSystemEditor } from "./DesignSystemEditor";
import { DesignSystemSetup } from "./DesignSystemSetup";

/** Rows Settings search finds on this page. */
export { designLabels as searchLabels } from "./desktop-labels";

type View = { kind: "list" } | { kind: "setup" } | { kind: "edit"; id: string };

export const dateOf = (at: number) =>
  formatPublished(new Date(at).toISOString().slice(0, 10));
/**
 * Design systems: the account's design systems in a searchable table, the setup
 * form New design system opens, and a page to edit one. A design system is a
 * description, notes and example files (styles, tokens, code) from which the
 * account's model writes guidelines: colours, type, spacing and components in
 * Markdown, which the person may edit. The one chosen for use (here or in the
 * composer's + menu) is told to every new Chat and Cowork turn. Sharing with an
 * organization, .fig files, GitHub links and font or image assets have no
 * Claudex service behind them and stay disabled. A 28px "+ New design system"
 * button, a 448×32 search, and a table that is always drawn.
 */
export function DesignSystemsTab({
  settings,
  save,
  onError = () => {},
  systems: initial,
}: Partial<TabProps> & {
  /** The records to list instead of asking the bridge (tests). */
  systems?: DesignSystem[];
}) {
  useLocale();
  const [systems, setSystems] = useState<DesignSystem[]>(initial ?? []);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuPosition>();
  const [view, setView] = useState<View>({ kind: "list" });
  const newButton = useRef<HTMLButtonElement>(null);
  const inUse = settings ? preference(settings, "designSystem") : "";
  const load = () =>
    window.desktop.listDesignSystems().then(setSystems).catch(onError);
  useEffect(() => {
    if (!initial) void load();
  }, []);
  const use = (id: string) => save?.({ designSystem: inUse === id ? "" : id });
  if (view.kind === "setup")
    return (
      <DesignSystemSetup
        onBack={() => setView({ kind: "list" })}
        onSaved={(system) => {
          void load();
          setView({ kind: "edit", id: system.id });
        }}
        onError={onError}
      />
    );
  if (view.kind === "edit") {
    const system = systems.find((item) => item.id === view.id);
    if (system)
      return (
        <DesignSystemEditor
          system={system}
          inUse={inUse === system.id}
          onUse={() => use(system.id)}
          onBack={() => {
            void load();
            setView({ kind: "list" });
          }}
          onChanged={(next) =>
            setSystems((list) =>
              list.map((item) => (item.id === next.id ? next : item)),
            )
          }
          onError={onError}
        />
      );
  }
  const shown = findDesignSystems(systems, query);
  return (
    <div className="directory-page design-systems-page">
      <header className="directory-header" data-setting="Design systems">
        <div>
          <h2>Design systems</h2>
          <p>
            Design systems give Claudex your colors, type and components to use
            when making designs, decks and prototypes.
          </p>
        </div>
        <button
          ref={newButton}
          type="button"
          className="design-systems-new"
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          data-setting="New design system"
          onClick={() => {
            const rect = newButton.current!.getBoundingClientRect();
            setMenu(
              menu
                ? undefined
                : { right: innerWidth - rect.right, top: rect.bottom + 4 },
            );
          }}
        >
          <Plus size={20} strokeWidth={1.75} />
          New design system
          <ChevronDown size={12} strokeWidth={1.75} />
        </button>
      </header>
      {menu && (
        <Menu
          label="New design system"
          size="regular"
          width={236}
          position={menu}
          anchors={[newButton]}
          onClose={() => setMenu(undefined)}
          entries={[
            {
              label: "Set up with Claudex",
              onSelect: () => setView({ kind: "setup" }),
            },
            {
              label: "Import from a file",
              onSelect: () =>
                void importFromFile()
                  .then((system) => {
                    if (!system) return;
                    void load();
                    setView({ kind: "edit", id: system.id });
                  })
                  .catch(onError),
            },
          ]}
        />
      )}
      {/* The search and the count share one row, the count at the right. */}
      <div className="design-systems-toolbar">
        <input
          className="design-systems-search"
          placeholder="Search by name"
          aria-label="Search design systems"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="design-systems-count" role="status">
          {formatText("Showing {start}–{end} of {total}", {
            start: shown.length ? 1 : 0,
            end: shown.length,
            total: systems.length,
          })}
        </p>
      </div>
      <table className="settings-table directory-table design-systems-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>
              <div className="directory-th-info">
                Usable by
                <details className="design-systems-availability-info">
                  <summary aria-label={t("About who can use a design system")}>
                    <Info size={16} aria-hidden="true" />
                  </summary>
                  <p>Available only in your account.</p>
                </details>
              </div>
            </th>
            <th>Content written</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {shown.map((system) => (
            <DesignSystemRow
              key={system.id}
              system={system}
              inUse={inUse === system.id}
              onOpen={() => setView({ kind: "edit", id: system.id })}
              onUse={() => use(system.id)}
              onDeleted={() => {
                if (inUse === system.id) save?.({ designSystem: "" });
                void load();
              }}
              onError={onError}
            />
          ))}
          {!shown.length && (
            <tr>
              <td colSpan={4} className="design-systems-empty">
                {systems.length
                  ? "No design systems match your search."
                  : "No design systems yet. Make one and it shows up here."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Asks for a Markdown or text file and keeps it as a design system's guidelines. */
async function importFromFile(): Promise<DesignSystem | undefined> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.markdown,.txt,text/markdown,text/plain";
  const file = await new Promise<File | undefined>((done) => {
    input.addEventListener("change", () => done(input.files?.[0]), {
      once: true,
    });
    input.addEventListener("cancel", () => done(undefined), { once: true });
    input.click();
  });
  if (!file) return undefined;
  const text = (await file.text()).trim();
  if (!text) throw new Error("That file is empty.");
  return window.desktop.saveDesignSystem({
    name: file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Design system",
    guidelines: text.slice(0, 60_000),
  });
}

function DesignSystemRow({
  system,
  inUse,
  onOpen,
  onUse,
  onDeleted,
  onError,
}: {
  system: DesignSystem;
  inUse: boolean;
  onOpen: () => void;
  onUse: () => void;
  onDeleted: () => void;
  onError: (error: unknown) => void;
}) {
  const [menu, setMenu] = useState<MenuPosition>();
  const [deleting, setDeleting] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  return (
    <tr>
      <td>
        <button type="button" className="design-system-name" onClick={onOpen}>
          <span data-no-translate>{system.name}</span>
          <span className="settings-badge design-system-kind">Standalone</span>
        </button>
        {inUse && <span className="settings-badge">In use</span>}
      </td>
      <td title={t("Available only in your account.")}>—</td>
      <td>
        {system.guidelines && system.generatedAt
          ? dateOf(system.generatedAt)
          : "Draft"}
      </td>
      <td className="directory-table-more">
        <button
          ref={more}
          type="button"
          className="desktop-row-more directory-square-more"
          aria-label={formatText("Actions for {name}", { name: system.name })}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={() => {
            const rect = more.current!.getBoundingClientRect();
            setMenu(
              menu
                ? undefined
                : { right: innerWidth - rect.right, top: rect.bottom + 4 },
            );
          }}
        >
          <MoreVertical size={16} />
        </button>
        {menu && (
          <Menu
            label={`${system.name} options`}
            size="regular"
            width={200}
            position={menu}
            anchors={[more]}
            onClose={() => setMenu(undefined)}
            entries={[
              { label: "Edit", onSelect: onOpen },
              system.guidelines
                ? {
                    label: inUse ? "Stop using" : "Use in chats",
                    onSelect: onUse,
                  }
                : {
                    label: "Use in chats",
                    disabled: true,
                    title: "Write its guidelines first",
                  },
              { separator: true },
              {
                label: "Delete",
                danger: true,
                onSelect: () => setDeleting(true),
              },
            ]}
          />
        )}
        {deleting &&
          createPortal(
            <ConfirmationDialog
              confirmation={{
                title: `Delete ${system.name}?`,
                body: "The design system is removed. Designs made with it are not changed.",
                action: async () => {
                  await window.desktop.deleteDesignSystem(system.id);
                  onDeleted();
                },
              }}
              onClose={() => setDeleting(false)}
              onError={onError}
            />,
            document.body,
          )}
      </td>
    </tr>
  );
}

export function SourceList({
  sources,
  onRemove,
}: {
  sources: DesignSource[];
  onRemove: (name: string) => void;
}) {
  return (
    <ul className="design-source-list" aria-label="Example files">
      {sources.map((source) => (
        <li key={source.name}>
          <span>{source.name}</span>
          <small>{Math.max(1, Math.round(source.text.length / 1000))} KB</small>
          <button
            type="button"
            aria-label={`Remove ${source.name}`}
            onClick={() => onRemove(source.name)}
          >
            <X size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SourceRow({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="directory-source">
      <div>
        <strong>{title}</strong>
        {note && <p>{note}</p>}
      </div>
      {children}
    </div>
  );
}

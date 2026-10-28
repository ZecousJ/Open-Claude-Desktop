import { formatText, useLocale } from "../../i18n";
import { Check, Plus } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { notAvailable } from "../../settings/unavailable";
import type { DirectoryIcon } from "../../../shared/directory-icon";
import { directoryGlyph } from "../../settings/directory/icons";
import "./customize-directory.css";
import "./customize-skill-actions.css";
import "./customize.css";

/** Discover lists skills or plugins (the same marketplace entries). */
export type Noun = "skills" | "plugins";
/** Discover's orders; marketplaces give names only, so Name is the one used. */
export type PluginSort = "installs" | "added" | "name";

/** One Discover card: a marketplace plugin as the page shows it. */
export interface CatalogueCard {
  /** The plugin's id (`name@marketplace`). */
  id: string;
  name: string;
  description: string;
  byline: string;
  icon: DirectoryIcon;
}

/** Discover's empty search. */
export function NoSkillsMatch({ noun = "skills" }: { noun?: Noun }) {
  return (
    <div className="customize-nothing" role="status">
      <svg
        width="84"
        height="84"
        viewBox="0 0 84 84"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="24.5" cy="24" r="21.5" className="lens" />
        <path d="M41 44.5 44.5 47.5" />
        <path d="M40.5 48 49.5 40 80.5 73 71.5 81Z" strokeLinejoin="round" />
      </svg>
      <p>
        {noun === "skills"
          ? "No skills match your search"
          : "No plugins match your search"}
        <span>Try a different term.</span>
      </p>
    </div>
  );
}

export const discoverSortLabels: Record<PluginSort, string> = {
  installs: "Most installed",
  added: "Recently added",
  name: "Name",
};

/** Page callbacks resolve genuine catalogue entries to their installable source. */
export interface CatalogueActions {
  onAdd?: (entry: CatalogueCard) => void;
  onAddAndTry?: (entry: CatalogueCard) => void;
  /** Installed catalogue IDs, rather than display names. */
  installed?: ReadonlySet<string>;
  busy?: string;
  canAdd?: (entry: CatalogueCard) => boolean;
  canAddAndTry?: (entry: CatalogueCard) => boolean;
  /** Why Add is off for an entry the host has but cannot install. */
  blockedReason?: string;
}

/** Two-column Discover rows with independent Add and Add-and-try actions. */
export function CatalogueCards({
  entries,
  onOpen,
  onAdd,
  onAddAndTry,
  installed,
  busy,
  canAdd,
  canAddAndTry,
  blockedReason,
}: {
  entries: CatalogueCard[];
  onOpen: (entry: CatalogueCard) => void;
} & CatalogueActions) {
  useLocale();
  return (
    <ul className="customize-cards customize-directory-cards customize-catalogue-cards">
      {entries.map((entry) => {
        const Glyph = directoryGlyph(entry.icon);
        return (
          <li key={entry.id}>
            <button
              type="button"
              className="customize-card u-press-card"
              aria-label={formatText("View {name}", { name: entry.name })}
              onClick={() => onOpen(entry)}
            >
              <span className="customize-card-tile" aria-hidden="true">
                <Glyph size={26} strokeWidth={1.4} />
              </span>
              <span className="customize-card-text">
                <strong data-no-translate>{entry.name}</strong>
                <span className="customize-card-description" data-no-translate>
                  {entry.description}
                </span>
                <small data-no-translate>{entry.byline}</small>
              </span>
            </button>
            <CatalogueRowActions
              entry={entry}
              onAdd={onAdd}
              onAddAndTry={onAddAndTry}
              installed={installed}
              busy={busy}
              canAdd={canAdd}
              canAddAndTry={canAddAndTry}
              blockedReason={blockedReason}
            />
          </li>
        );
      })}
    </ul>
  );
}

function CatalogueRowActions({
  entry,
  onAdd,
  onAddAndTry,
  installed,
  busy,
  canAdd,
  canAddAndTry,
  blockedReason,
}: { entry: CatalogueCard } & CatalogueActions) {
  const added = installed?.has(entry.id) === true;
  const allowed = canAdd?.(entry) !== false;
  const addDisabled = added || busy !== undefined || !onAdd || !allowed;
  const tryDisabled =
    busy !== undefined ||
    !onAddAndTry ||
    !allowed ||
    canAddAndTry?.(entry) === false;
  return (
    <span className="customize-catalogue-actions">
      {!added && (
        <button
          type="button"
          className="customize-catalogue-try"
          aria-label={formatText("Add {name} and try it in chat", {
            name: entry.name,
          })}
          aria-busy={busy === entry.id || undefined}
          disabled={tryDisabled}
          title={
            !onAddAndTry || !allowed
              ? (blockedReason ?? notAvailable)
              : undefined
          }
          onClick={() => onAddAndTry?.(entry)}
        >
          <AppIcon name="Chat" size={20} aria-hidden="true" />
          <span className="customize-catalogue-try-label">Try</span>
        </button>
      )}
      <button
        type="button"
        className="customize-catalogue-add"
        aria-label={formatText(added ? "Added: {name}" : "Add {name}", {
          name: entry.name,
        })}
        aria-busy={busy === entry.id || undefined}
        disabled={addDisabled}
        title={!onAdd || !allowed ? (blockedReason ?? notAvailable) : undefined}
        onClick={() => onAdd?.(entry)}
      >
        {added ? (
          <Check size={20} aria-hidden="true" />
        ) : (
          <Plus size={20} strokeWidth={1.4} aria-hidden="true" />
        )}
      </button>
    </span>
  );
}

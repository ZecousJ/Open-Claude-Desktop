import { useEffect, useRef, useState, useMemo, type RefObject } from "react";
import { ChevronRight, X } from "../ui/glyphs";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { starterIntegrations } from "../../shared/starter-integrations";
import {
  researchConnectorEnabled,
  researchUnavailable,
} from "../../shared/research";
import { useApp } from "../app/AppContext";
import { useModelCatalog } from "../composer/useComposerServices";
import { StarterCategoryIcon } from "./StarterCategoryIcon";
import { formatText, t, useLocale } from "../i18n";
import { setPromptPreview } from "../composer/prompt-preview";
import {
  homeStarterCategories,
  availableStarterCategories,
  visibleStarterCategories,
  starterPromptTemplate,
  moveChipFocus,
  moveStarterFocus,
  type StarterCategory,
  type StarterPrompt,
} from "./starter-prompts";
import "./starter-prompts.css";

function promptText(prompt: StarterPrompt, category: StarterCategory) {
  const label = t(prompt.label);
  return formatText(starterPromptTemplate(category), {
    prompt: label[0].toLowerCase() + label.slice(1),
  });
}

/**
 * The prompt ideas under the Chat home's composer (loaded with its styles when
 * the home first shows them). A row of category chips; a chip opens that
 * category's list in their place. A line previews its prompt in the composer
 * while the pointer or the keyboard is on it, and a click writes the prompt
 * there for the person to finish and send. Escape, the X and a press outside
 * close the list. Structure and measures follow the original's prompt list;
 * category selection, seeded prompt order and connector priority follow the
 * reference design -IdU-cvhU.js and.
 */
export default function StarterPrompts({
  onPick,
}: {
  /** Writes the prompt into the composer and focuses it. */
  onPick: (prompt: string) => void;
}) {
  useLocale();
  const app = useApp();
  const catalog = useModelCatalog();
  const [servers, setServers] = useState<McpServerState[]>([]);
  const [seed] = useState(() => Math.random() * 4294967296);
  const [hour] = useState(() => new Date().getHours());
  useEffect(() => {
    let live = true;
    let request = 0;
    const load = () => {
      const current = ++request;
      void window.desktop
        .mcpServers()
        .then((next) => {
          if (live && current === request) setServers(next.servers);
        })
        .catch(() => {
          if (live && current === request) setServers([]);
        });
    };
    load();
    const timer = setInterval(load, 5000);
    const off = window.desktop.onEvent((event) => {
      if (
        ["settings", "engine", "policy", "service-changed"].includes(event.type)
      )
        load();
    });
    return () => {
      live = false;
      clearInterval(timer);
      off();
    };
  }, []);
  const chips = useMemo(() => {
    const integrations = starterIntegrations(servers);
    const provider = app.snapshot.settings.providers.find(
      (item) => item.id === app.providerId,
    );
    if (
      !researchUnavailable({
        policy: app.policy,
        mode: "chat",
        incognito: app.incognitoShown,
        provider,
        model: app.model,
        catalogItem: catalog?.items.find((item) => item.id === app.model),
        searchIntegrationEnabled: researchConnectorEnabled(
          app.snapshot.settings,
          app.policy,
          app.composerDraft.draftConnectors,
        ),
      })
    )
      integrations.push("compass");
    const options = {
      integrations,
      hour,
      seed,
      workType: app.snapshot.settings.workType,
    };
    const categories =
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).has("debug_show_all_prompt_chips")
        ? availableStarterCategories(undefined, options)
        : homeStarterCategories(undefined, options);
    return visibleStarterCategories(categories);
  }, [
    servers,
    app.snapshot.settings,
    app.policy,
    app.providerId,
    app.model,
    app.incognitoShown,
    app.composerDraft.draftConnectors,
    catalog,
    hour,
    seed,
  ]);
  const [open, setOpen] = useState<StarterCategory>();
  /** Opened from the keyboard: the list takes focus, as the chip is hidden now. */
  const [byKeyboard, setByKeyboard] = useState(false);
  const row = useRef<HTMLUListElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const category = chips.find((item) => item.id === open?.id);
  const close = (refocus: boolean) => {
    setPromptPreview(null);
    setOpen(undefined);
    // The chip that opened the list takes focus back once it is shown again.
    if (refocus) requestAnimationFrame(() => opener.current?.focus());
  };
  // A press outside closes it and leaves focus where the press put it;
  // Escape closes it and gives focus back to the chip.
  const closing = useRef(close);
  closing.current = close;
  useEffect(() => {
    if (open && !category) closing.current(false);
  }, [open, category]);
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!list.current?.contains(event.target as Node)) closing.current(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closing.current(true);
    };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", key);
    };
  }, [Boolean(open)]);
  // A preview never outlives the list.
  useEffect(() => () => setPromptPreview(null), []);
  return (
    <div className="starter-prompts">
      {/* While a list is open the row keeps its place under it, unseen. */}
      <ul
        ref={row}
        className={open ? "starter-chips is-covered" : "starter-chips"}
        aria-label="Prompt categories"
        onKeyDown={(event) => {
          const buttons = [...(row.current?.querySelectorAll("button") ?? [])];
          const next = moveChipFocus(
            event.key,
            buttons.indexOf(document.activeElement as HTMLButtonElement),
            buttons.length,
          );
          if (next === undefined) return;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {chips.map((category, index) => {
          return (
            <li key={category.id} style={{ animationDelay: `${index * 50}ms` }}>
              <button
                type="button"
                className="starter-chip"
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setByKeyboard(event.detail === 0);
                  setOpen(category);
                }}
              >
                <StarterCategoryIcon icon={category.icon} />
                <span>{t(category.title)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {category && (
        <StarterList
          key={category.id}
          category={category}
          panel={list}
          autoFocus={byKeyboard}
          onClose={close}
          onPick={(prompt) => {
            close(false);
            onPick(prompt);
          }}
        />
      )}
    </div>
  );
}

function StarterList({
  category,
  panel,
  autoFocus,
  onClose,
  onPick,
}: {
  category: StarterCategory;
  panel: RefObject<HTMLDivElement | null>;
  autoFocus: boolean;
  onClose: (refocus: boolean) => void;
  onPick: (prompt: string) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // Opened from the keyboard, the first line takes focus (the chip it came
  // From is hidden now) so the arrow keys can go straight down the list.
  useEffect(() => {
    if (autoFocus) buttons.current[0]?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={panel} className="starter-list">
      <div className="starter-list-head">
        <StarterCategoryIcon icon={category.icon} />
        <h2>{t(category.title)}</h2>
        <button
          type="button"
          className="starter-list-close"
          aria-label="Close suggestions"
          onClick={() => onClose(true)}
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
      <ul
        role="listbox"
        aria-orientation="vertical"
        aria-label={formatText("{category} suggestions", {
          category: t(category.title),
        })}
      >
        {category.prompts.slice(0, 5).map((item, index) => (
          <li key={item.id} role="option" aria-selected="false">
            <button
              type="button"
              ref={(element) => {
                buttons.current[index] = element;
              }}
              onPointerEnter={() =>
                setPromptPreview(promptText(item, category))
              }
              onPointerLeave={() => setPromptPreview(null)}
              onFocus={() => setPromptPreview(promptText(item, category))}
              onBlur={() => setPromptPreview(null)}
              onKeyDown={(event) => {
                const next = moveStarterFocus(
                  event.key,
                  index,
                  Math.min(category.prompts.length, 5),
                );
                if (next === undefined) return;
                event.preventDefault();
                buttons.current[next]?.focus();
              }}
              onClick={() => onPick(promptText(item, category))}
            >
              <span>{t(item.label)}</span>
              <ChevronRight size={16} strokeWidth={1.6} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

import { t } from "../../i18n";
import { VendorSwitch } from "./VendorSwitch";
import { ReasonTooltip } from "../../ui/Tooltip";
import { ModelDescription } from "./ModelDescription";
import { Check, ChevronRight } from "../../ui/glyphs";
import { modelLabel } from "./code-model-choices";
import { chatEffortLabels } from "../../../shared/chat-effort";
import { ComposerSheetBack } from "../menu-sheet";
import type { CodeModelChoice, ModelVendor } from "./code-model-choices";
import type { Provider, ChatEffort } from "../../../shared/types";
import type { ModelCatalog } from "../../../shared/model-catalog-api";

/** What modelMenuView needs from ModelMenu.tsx. */
export interface ModelMenuViewKit {
  body: (children: React.ReactNode) => React.ReactNode;
  branch: "effort" | "models" | null;
  catalog: ModelCatalog | null | undefined;
  catalogRead: {
    retry: () => void;
    status: "pending" | "ready" | "error";
    value: ModelCatalog | null | undefined;
  };
  catalogued: boolean;
  clearTimers: () => void;
  /** Drops an open still waiting on its delay: the pointer moved on. */
  cancelOpen: () => void;
  closeTimer: React.RefObject<NodeJS.Timeout | undefined>;
  defaultEffort: ChatEffort;
  effort: ChatEffort;
  effortHeading: string;
  efforts: readonly ChatEffort[];
  focusBranch: (name: "effort" | "models") => void;
  hasCatalogResult: boolean;
  inline: boolean;
  keydown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  left: boolean;
  model: string;
  modelService: React.JSX.Element;
  modelsHeading: string;
  more: CodeModelChoice[];
  notice: string | undefined;
  onClose: () => void;
  onEffort: (effort: ChatEffort) => void;
  onSelect: (providerId: string, model: string) => void;
  onThinking: (() => void) | undefined;
  pointerLeave: () => void;
  pointerOpen: (name: "effort" | "models") => void;
  provider: Provider | undefined;
  providerId: string;
  providers: Provider[];
  quick: CodeModelChoice[];
  root: React.RefObject<HTMLDivElement | null>;
  setBranch: React.Dispatch<React.SetStateAction<"effort" | "models" | null>>;
  setVendor: React.Dispatch<React.SetStateAction<string>>;
  sheet: boolean;
  sheetMotion: { back: () => void; dismiss: (done: () => void) => void };
  shownVendor: string;
  thinking: boolean | undefined;
  up: boolean;
  usageHint: string | undefined;
  vendors: ModelVendor[];
}

export function modelMenuView(kit: ModelMenuViewKit) {
  const {
    body,
    branch,
    catalog,
    catalogRead,
    catalogued,
    cancelOpen,
    clearTimers,
    closeTimer,
    defaultEffort,
    effort,
    effortHeading,
    efforts,
    focusBranch,
    hasCatalogResult,
    inline,
    keydown,
    left,
    model,
    modelService,
    modelsHeading,
    more,
    notice,
    onClose,
    onEffort,
    onSelect,
    onThinking,
    pointerLeave,
    pointerOpen,
    provider,
    providerId,
    providers,
    quick,
    root,
    setBranch,
    setVendor,
    sheet,
    sheetMotion,
    shownVendor,
    thinking,
    up,
    usageHint,
    vendors,
  } = kit;
  const modelMenuViewView = (
    <div
      ref={root}
      className={`model-menu ${catalogued ? "catalogued" : ""} ${left ? "opens-left" : ""} ${up ? "opens-up" : ""}${inline ? " model-menu-inline" : ""}`}
      role="menu"
      tabIndex={-1}
      aria-label="Select model"
      onKeyDown={keydown}
      onMouseEnter={() => clearTimeout(closeTimer.current)}
      onMouseLeave={pointerLeave}
      aria-busy={catalogRead.status === "pending" || undefined}
    >
      {catalogRead.status === "pending" && !hasCatalogResult && (
        <div
          className="model-menu-current single-line"
          role="status"
          aria-label={t("Select model")}
        />
      )}
      {catalogRead.status === "error" && (
        <div className="chunk-error">
          <span role="status">{t("Couldn’t load this.")}</span>
          <button
            type="button"
            className="secondary"
            onClick={catalogRead.retry}
          >
            {t("Retry")}
          </button>
        </div>
      )}
      {hasCatalogResult &&
        body(
          <>
            {notice && <p className="model-menu-notice">{notice}</p>}
            {usageHint && (
              <p className="model-menu-notice" data-model-usage={model}>
                {usageHint}
              </p>
            )}
            {vendors.length >= 2 && (
              <VendorSwitch
                vendors={vendors}
                selected={shownVendor!}
                onSelect={(id) => {
                  setVendor(id);
                  setBranch(null);
                }}
                onHover={() => {
                  clearTimers();
                  setBranch(null);
                }}
              />
            )}
            {catalogued ? (
              quick.map((choice) => {
                const current =
                  choice.providerId === providerId && choice.name === model;
                return (
                  <ReasonTooltip
                    key={`${choice.providerId}:${choice.name}`}
                    reason={
                      choice.updateRequired
                        ? t(
                            "Update Claudex to use this model on this computer.",
                          )
                        : undefined
                    }
                  >
                    {(tooltipProps) => (
                      <button
                        {...tooltipProps}
                        key={`${choice.providerId}:${choice.name}`}
                        className={`model-menu-current ${choice.description ? "" : "single-line"}`}
                        role="menuitemradio"
                        aria-checked={current}
                        aria-disabled={choice.updateRequired || undefined}
                        onMouseEnter={() => {
                          clearTimers();
                          setBranch(null);
                        }}
                        onClick={() => {
                          if (choice.updateRequired) return;
                          if (!current)
                            onSelect(choice.providerId, choice.name);
                          onClose();
                        }}
                      >
                        <span>
                          <strong>{choice.label ?? choice.name}</strong>
                          {choice.description && (
                            <ModelDescription text={choice.description} />
                          )}
                        </span>
                        {current && <Check size={16} />}
                      </button>
                    )}
                  </ReasonTooltip>
                );
              })
            ) : (
              <button
                className="model-menu-current"
                role="menuitemradio"
                aria-checked="true"
                onMouseEnter={() => {
                  clearTimers();
                  setBranch(null);
                }}
                onClick={onClose}
              >
                <span>
                  <strong>
                    {model ? modelLabel(catalog, model) : "Select model"}
                  </strong>
                  <small>{provider?.name || "No model available"}</small>
                </span>
                <Check size={16} />
              </button>
            )}
            <div
              className="model-menu-separator"
              role="separator"
              onMouseEnter={() => {
                clearTimers();
                setBranch(null);
              }}
            />
            {onThinking && efforts.includes("low") && efforts.length > 1 && (
              <button
                role="menuitemcheckbox"
                aria-checked={thinking}
                onMouseEnter={() => {
                  clearTimers();
                  setBranch(null);
                }}
                onClick={() => {
                  onClose();
                  onThinking();
                }}
              >
                <span>Extended thinking</span>
                {thinking && <Check size={16} />}
              </button>
            )}
            <div
              className="model-menu-branch"
              onMouseEnter={() => {
                if (!inline) pointerOpen("effort");
              }}
              onMouseLeave={cancelOpen}
            >
              {!inline && (
                <button
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={branch === "effort"}
                  data-branch="effort"
                  onClick={() =>
                    branch === "effort"
                      ? setBranch(null)
                      : focusBranch("effort")
                  }
                >
                  <span>Effort</span>
                  <small>{chatEffortLabels[effort]}</small>
                  <ChevronRight size={16} />
                </button>
              )}
              {(inline || branch === "effort") && (
                <div
                  className={
                    inline
                      ? "model-inline-group effort-inline"
                      : "model-submenu effort-submenu"
                  }
                  role={inline ? "group" : "menu"}
                  aria-label={inline ? undefined : "Reasoning effort"}
                  aria-labelledby={inline ? effortHeading : undefined}
                  data-panel={inline ? undefined : "effort"}
                >
                  <ComposerSheetBack
                    sheet={sheet}
                    title={t("Effort")}
                    onBack={sheetMotion.back}
                  />
                  {inline ? (
                    <div id={effortHeading} className="model-menu-group-label">
                      Effort
                    </div>
                  ) : (
                    <p>
                      Higher effort means more thorough responses, but takes
                      longer and uses your limits faster.
                    </p>
                  )}
                  {efforts.map((value) => (
                    <button
                      key={value}
                      role="menuitemradio"
                      aria-checked={effort === value}
                      onClick={() => {
                        onEffort(value);
                        onClose();
                      }}
                    >
                      <span>
                        {chatEffortLabels[value]}
                        {value === defaultEffort && (
                          <small className="model-effort-badge default">
                            Default
                          </small>
                        )}
                      </span>
                      {effort === value && <Check size={16} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div
              className="model-menu-separator"
              role="separator"
              onMouseEnter={() => {
                clearTimers();
                setBranch(null);
              }}
            />
            <div
              className="model-menu-branch"
              onMouseEnter={() => {
                if (!inline) pointerOpen("models");
              }}
              onMouseLeave={cancelOpen}
            >
              {!inline && (
                <button
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={branch === "models"}
                  data-branch="models"
                  onClick={() =>
                    branch === "models"
                      ? setBranch(null)
                      : focusBranch("models")
                  }
                >
                  <span>More models</span>
                  <ChevronRight size={16} />
                </button>
              )}
              {(inline || branch === "models") && (
                <div
                  className={
                    inline
                      ? "model-inline-group models-inline"
                      : "model-submenu models-submenu"
                  }
                  role={inline ? "group" : "menu"}
                  aria-label={inline ? undefined : "More models"}
                  aria-labelledby={inline ? modelsHeading : undefined}
                  data-panel={inline ? undefined : "models"}
                >
                  <ComposerSheetBack
                    sheet={sheet}
                    title={t("More models")}
                    onBack={sheetMotion.back}
                  />
                  {inline && (
                    <div id={modelsHeading} className="model-menu-group-label">
                      More models
                    </div>
                  )}
                  {catalogued &&
                    more.map((choice) => (
                      <ReasonTooltip
                        key={`${choice.providerId}:${choice.name}`}
                        reason={
                          choice.updateRequired
                            ? t(
                                "Update Claudex to use this model on this computer.",
                              )
                            : undefined
                        }
                      >
                        {(tooltipProps) => (
                          <button
                            {...tooltipProps}
                            key={`${choice.providerId}:${choice.name}`}
                            role="menuitemradio"
                            aria-checked={
                              choice.providerId === providerId &&
                              choice.name === model
                            }
                            aria-disabled={choice.updateRequired || undefined}
                            title={
                              choice.updateRequired
                                ? undefined
                                : choice.description
                            }
                            onClick={() => {
                              if (choice.updateRequired) return;
                              onSelect(choice.providerId, choice.name);
                              onClose();
                            }}
                          >
                            <span>{choice.label ?? choice.name}</span>
                          </button>
                        )}
                      </ReasonTooltip>
                    ))}
                  {!catalogued &&
                    providers.map((p) => (
                      <div key={p.id}>
                        <div className="model-provider-label">{p.name}</div>
                        {[...new Set([p.model, ...p.models])]
                          .filter(
                            (name) =>
                              Boolean(name) &&
                              (p.id !== providerId || name !== model),
                          )
                          .map((m) => (
                            <button
                              key={m}
                              role="menuitemradio"
                              aria-checked={providerId === p.id && model === m}
                              onClick={() => {
                                onSelect(p.id, m);
                                onClose();
                              }}
                            >
                              <span>{m}</span>
                              {providerId === p.id && model === m && (
                                <Check size={16} />
                              )}
                            </button>
                          ))}
                      </div>
                    ))}
                  {!inline && modelService}
                </div>
              )}
            </div>
            {inline && modelService}
          </>,
        )}
    </div>
  );
  return modelMenuViewView;
}

import { useEffect, useRef } from "react";
import { Check, X } from "../ui/glyphs";
import { locales } from "../../shared/locales";
import { useT } from "./index";
import { useDialogOverlay } from "../ui/dialog-stack";
import "./language.css";

/**
 * "Choose your language", as claude.ai draws it: a dialog with its title and
 * a close button over a hairline, and the languages in three columns, each
 * with its own name and its English name under it; the chosen one is
 * highlighted with a tick. Choosing applies at once and closes the dialog.
 */
export default function LanguageDialog({
  value,
  onChoose,
  onClose,
}: {
  value: string;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const chosen = useRef<HTMLButtonElement>(null);
  const overlay = useDialogOverlay();
  useEffect(() => {
    chosen.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  return (
    <div
      {...overlay}
      className="language-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="language-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("Choose your language")}
      >
        <header>
          <h2>{t("Choose your language")}</h2>
          <button type="button" aria-label={t("Close")} onClick={onClose}>
            <X size={20} strokeWidth={1.5} />
          </button>
        </header>
        <div className="language-grid" role="listbox" data-no-translate>
          {locales.map((locale) => {
            const selected = locale.id === value;
            return (
              <button
                key={locale.id}
                ref={selected ? chosen : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                lang={locale.id}
                className={selected ? "selected" : ""}
                onClick={() => onChoose(locale.id)}
              >
                <span>
                  <b>{locale.native}</b>
                  <small>{locale.english}</small>
                </span>
                {selected && <Check size={20} strokeWidth={1.5} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

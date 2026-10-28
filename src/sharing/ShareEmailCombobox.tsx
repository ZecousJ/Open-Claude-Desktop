import { useEffect, useId, useRef, useState } from "react";
import { formatText, t } from "../i18n";
import { Plus, X } from "../ui/glyphs";

export function shareEmail(value: string) {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : undefined;
}

/** The source's typed external-email option and pending recipient chips.
 * This service has email invitations, not a searchable organization roster. */
export function ShareEmailCombobox({
  disabled,
  busy,
  existing = [],
  onInvite,
}: {
  disabled: boolean;
  busy: boolean;
  existing?: string[];
  onInvite(email: string): Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const operation = useRef(false),
    live = useRef(true),
    composing = useRef(false);
  const id = useId(),
    listId = `${id}-options`,
    optionId = `${id}-email`;
  const email = shareEmail(text);
  const duplicate = Boolean(
    email &&
    (recipients.includes(email) ||
      existing.some((value) => value.toLowerCase() === email)),
  );
  const eligible = Boolean(email && !duplicate);
  const locked = disabled || busy || sending;
  const expanded = open && Boolean(email) && !locked;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const commit = () => {
    if (!eligible || locked) return false;
    setRecipients((values) => [...values, email!]);
    setText("");
    setOpen(false);
    setError(false);
    return true;
  };
  // The source's Invite gate uses committed recipient count. A typed query is
  // only a proposed option until Enter, Tab or selection commits its chip.
  const targets = recipients;
  const invite = async () => {
    if (locked || operation.current) return;
    if (!targets.length) return;
    operation.current = true;
    setSending(true);
    setOpen(false);
    setError(false);
    try {
      for (const value of targets) {
        if (!live.current) break;
        const done = await onInvite(value);
        if (!live.current || !done) break;
        setRecipients((values) =>
          values.filter((recipient) => recipient !== value),
        );
      }
    } finally {
      operation.current = false;
      if (live.current) setSending(false);
    }
  };
  return (
    <form
      className="chat-share-invite"
      data-off={disabled || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void invite();
      }}
    >
      <div className="share-recipient-field">
        <div className="share-recipient-input-row">
          {recipients.map((value) => (
            <span className="share-recipient-chip" key={value}>
              <span data-no-translate>{value}</span>
              <button
                type="button"
                disabled={locked}
                aria-label={formatText("Remove {name}", { name: value })}
                onClick={() => {
                  if (!locked)
                    setRecipients((values) =>
                      values.filter((recipient) => recipient !== value),
                    );
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <input
            ref={field}
            type="text"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            disabled={locked}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            aria-activedescendant={expanded && eligible ? optionId : undefined}
            aria-label={t("Add people by email")}
            placeholder={recipients.length ? "" : t("Add people by email")}
            aria-invalid={error || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setError(false);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onPaste={(event) => {
              if (locked) return;
              const values = event.clipboardData
                .getData("text/plain")
                .split(/[\s,;]+/)
                .filter(Boolean);
              if (!values.length || values.some((value) => !shareEmail(value)))
                return;
              event.preventDefault();
              const next = values.map((value) => shareEmail(value)!);
              setRecipients((prior) =>
                [...new Set([...prior, ...next])].filter(
                  (value) =>
                    !existing.some((email) => email.toLowerCase() === value),
                ),
              );
              setText("");
              setOpen(false);
              setError(false);
            }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing || locked)
                return;
              if (event.key === "Escape" && expanded) {
                event.stopPropagation();
                event.preventDefault();
                setOpen(false);
              } else if (
                (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                email
              ) {
                event.preventDefault();
                setOpen(true);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (!commit() && text.trim() && !email) setError(true);
              } else if (event.key === "Tab" && !event.shiftKey && expanded) {
                if (commit()) event.preventDefault();
                setOpen(false);
              } else if (
                event.key === "Backspace" &&
                !text &&
                recipients.length
              )
                setRecipients((values) => values.slice(0, -1));
            }}
          />
        </div>
        {expanded && (
          <ul
            id={listId}
            role="listbox"
            aria-label={t("Add people by email")}
            className="share-recipient-options"
          >
            <li
              id={optionId}
              role="option"
              aria-selected={eligible}
              aria-disabled={duplicate || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (commit()) field.current?.focus();
              }}
            >
              <span className="share-recipient-option-icon" aria-hidden="true">
                <Plus size={16} />
              </span>
              <span className="share-recipient-option-text">
                {duplicate
                  ? email
                  : formatText("Invite {email}", { email: email! })}
              </span>{" "}
              <span className="share-recipient-option-hint">
                {duplicate ? t("Already invited") : t("tab to add")}
              </span>
            </li>
          </ul>
        )}
        {error && (
          <span
            id={`${id}-error`}
            className="share-recipient-error"
            role="alert"
          >
            {t("Enter a valid email address.")}
          </span>
        )}
      </div>
      <button
        type="submit"
        disabled={locked || !targets.length}
        aria-busy={sending || undefined}
      >
        Invite
      </button>
    </form>
  );
}

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, Search } from "../../ui/glyphs";
import type { Provider } from "../../../shared/types";
import { useDismiss } from "../../ui/useDismiss";
import "./scheduled.css";

export type ModelChoice =
  { default: true } | { default?: false; providerId: string; model: string };

interface Row {
  key: string;
  label: string;
  detail?: string;
  choice: ModelChoice;
}

/** Every model the connections offer, the connection's default first. */
export function modelRows(providers: Provider[]): Row[] {
  const several = providers.length > 1;
  return [
    { key: "default", label: "Default", choice: { default: true } },
    ...providers.flatMap((provider) =>
      [...new Set([provider.model, ...provider.models])]
        .filter(Boolean)
        .map((model) => ({
          key: `${provider.id}\n${model}`,
          label: model,
          detail: several ? provider.name : undefined,
          choice: { providerId: provider.id, model },
        })),
    ),
  ];
}

export const sameChoice = (a: ModelChoice, b: ModelChoice) =>
  a.default
    ? Boolean(b.default)
    : !b.default && a.providerId === b.providerId && a.model === b.model;

/**
 * The routine editor's model menu: a search field on top and one 24px row per
 * model, "Default" first.
 */
export function ModelPicker({
  providers,
  value,
  anchor,
  onChoose,
  onClose,
}: {
  providers: Provider[];
  value: ModelChoice;
  anchor: RefObject<HTMLElement | null>;
  onChoose: (choice: ModelChoice) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useDismiss([box, anchor], true, onClose);
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase();
    return modelRows(providers).filter(
      (row) =>
        !words ||
        `${row.label} ${row.detail ?? ""}`.toLowerCase().includes(words),
    );
  }, [providers, query]);
  useLayoutEffect(() => {
    const trigger = anchor.current?.getBoundingClientRect();
    const own = box.current?.getBoundingClientRect();
    if (!trigger || !own) return;
    const left = Math.max(
      8,
      Math.min(trigger.right - own.width, innerWidth - own.width - 8),
    );
    const below = trigger.bottom + 4;
    const top =
      below + own.height > innerHeight - 8
        ? Math.max(8, trigger.top - own.height - 4)
        : below;
    setPlace({ left, top });
  }, []);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActive(0), [query]);
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) {
        onChoose(row.choice);
        onClose();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return createPortal(
    <div
      ref={box}
      className="menu routine-model-menu"
      role="dialog"
      aria-label="Model"
      style={place ?? { left: -9999, top: 0 }}
      onKeyDown={keyDown}
    >
      <label className="routine-model-search">
        <Search size={12} strokeWidth={1.8} />
        <input
          ref={input}
          aria-label="Search models"
          placeholder="Model"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="routine-model-rows" role="listbox" aria-label="Models">
        {rows.map((row, index) => {
          const selected = sameChoice(row.choice, value);
          return (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={selected}
              className={index === active ? "active" : ""}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                onChoose(row.choice);
                onClose();
              }}
            >
              <span>{row.label}</span>
              {row.detail && <small>{row.detail}</small>}
              {selected && <Check size={14} className="menu-check" />}
            </button>
          );
        })}
        {!rows.length && <p className="routine-model-none">No models</p>}
      </div>
    </div>,
    document.body,
  );
}

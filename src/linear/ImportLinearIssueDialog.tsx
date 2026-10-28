import { useEffect, useId, useRef, useState } from "react";
import { Circle, Search } from "../ui/glyphs";
import type { LinearIssue } from "../../shared/linear-api";
import { api } from "../desktop-api";
import { t } from "../i18n";
import { Modal } from "../ui/Controls";
import { LinearMark } from "./LinearMark";
import "../github/import-issue.css";
import "./linear.css";

// Shared issue picker.
export default function ImportLinearIssueDialog({
  onSelect,
  onClose,
}: {
  onSelect: (issue: LinearIssue) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<LinearIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const settled = text.trim() === query && !refreshing;
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    let live = true;
    setRefreshing(true);
    setFailed(false);
    void api
      .linearIssues(query)
      .then(
        (issues) => {
          if (live) {
            setItems(issues);
            setSelected(-1);
          }
        },
        () => {
          if (live) setFailed(true);
        },
      )
      .finally(() => {
        if (live) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      live = false;
    };
  }, [query]);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const choose = (issue: LinearIssue) => {
    onSelect(issue);
    onClose();
  };
  const message = loading
    ? "Loading..."
    : failed
      ? "Something went wrong. You can try again."
      : !items.length
        ? query
          ? "No issues match your search."
          : "No issues assigned to you. Search to find any issue."
        : undefined;
  return (
    <Modal
      title={t("Import Linear issue")}
      titleIcon={<LinearMark size={20} />}
      onClose={onClose}
      className="import-issue import-linear-issue"
    >
      <div
        className="import-issue-body"
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            !settled ||
            message ||
            !items.length
          )
            return;
          if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            !event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            setSelected((value) =>
              event.key === "ArrowDown"
                ? Math.min(value + 1, items.length - 1)
                : Math.max(value - 1, 0),
            );
            input.current?.focus({ preventScroll: true });
          } else if (
            event.key === "Enter" &&
            !event.repeat &&
            selected >= 0 &&
            event.target === input.current
          ) {
            event.preventDefault();
            choose(items[selected]);
          }
        }}
      >
        <label className="import-issue-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={input}
            type="text"
            autoFocus
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={!message}
            aria-controls={message ? undefined : `${id}-list`}
            aria-activedescendant={
              settled && selected >= 0 ? `${id}-option-${selected}` : undefined
            }
            aria-label={t("Search Linear issues")}
            placeholder={t("Search Linear issues")}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setSelected(-1);
            }}
          />
        </label>
        {message ? (
          <p className="import-issue-note">{t(message)}</p>
        ) : (
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={t("Import Linear issue")}
            aria-busy={!settled}
            onMouseDown={(event) => {
              if (event.target !== event.currentTarget) {
                event.preventDefault();
                input.current?.focus({ preventScroll: true });
              }
            }}
          >
            {items.map((issue, index) => (
              <li key={issue.identifier} role="presentation">
                <button
                  type="button"
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={settled && selected === index}
                  onFocus={() => setSelected(index)}
                  onClick={() => choose(issue)}
                >
                  <span
                    className="import-issue-state"
                    style={
                      issue.stateColor ? { color: issue.stateColor } : undefined
                    }
                  >
                    <Circle size={16} />
                  </span>
                  <span className="import-issue-text" data-no-translate>
                    <span className="import-issue-title">
                      <span className="import-issue-number">
                        {issue.identifier}
                      </span>
                      {issue.title === issue.identifier
                        ? null
                        : ` ${issue.title}`}
                    </span>
                    <span className="import-issue-meta">
                      {issue.team}
                      {issue.team && issue.state ? " · " : ""}
                      {issue.state}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

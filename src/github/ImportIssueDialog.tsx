import { useEffect, useId, useRef, useState } from "react";
import { CircleCheck, CircleDot, Search } from "../ui/glyphs";
import type { Attachment } from "../../shared/types";
import type { GitHubIssue, GitHubProblem } from "../../shared/github-api";
import { issueFileName } from "../../shared/github-issue";
import { api } from "../desktop-api";
import { Modal } from "../ui/Controls";
import { attachIssue } from "./attach-issue";
import "./import-issue.css";

/** The search waits this long after typing. */
const searchDelay = 300;

/**
 * Why the list can't be shown. The original shows an empty list when the
 * GitHub CLI is missing or signed out; this says which, since nothing else
 * would tell the person what to do.
 */
const problems: Record<GitHubProblem, string> = {
  "cli-missing":
    "Install the GitHub CLI (gh) and sign in with gh auth login to see issues.",
  "cli-signed-out":
    "Sign in to the GitHub CLI with gh auth login to see issues.",
  "not-connected": "Connect GitHub on the Code page to see issues.",
  "rate-limited": "Something went wrong. You can try again.",
  network: "Something went wrong. You can try again.",
  unavailable: "Something went wrong. You can try again.",
};

/**
 * Import GitHub issue: a dialog with a search box and the repository's open
 * issues, the ones the person is involved with until they type. Choosing one
 * hands it to the composer, which attaches it to the next message.
 */
export default function ImportIssueDialog({
  repository,
  folder,
  onAttach,
  onClose,
}: {
  /** "owner/name": the web's chosen repository; empty before one is chosen. */
  repository?: string;
  /** The new task's folder, whose GitHub remote names the repository. */
  folder?: string;
  /** Attaches the chosen issue to the next message (the composer's pending-file machinery). */
  onAttach: (job: {
    key: string;
    name: string;
    run: () => Promise<Attachment>;
  }) => void;
  onClose: () => void;
}) {
  const ready = Boolean(repository || folder);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "list"; items: GitHubIssue[]; problem?: GitHubProblem }
    | { kind: "error" }
  >({ kind: "loading" });
  const [selected, setSelected] = useState(-1);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const title = "Import GitHub issue";

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), searchDelay);
    return () => window.clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    // The rows stay while a new search is out; the first load shows Loading.
    api.githubIssues({ repository, folder, query: query || undefined }).then(
      (result) => {
        if (!live) return;
        setState({
          kind: "list",
          items: result.items,
          ...(result.problem ? { problem: result.problem } : {}),
        });
        setSelected(-1);
      },
      () => live && setState({ kind: "error" }),
    );
    return () => {
      live = false;
    };
  }, [ready, repository, folder, query]);

  useEffect(() => {
    if (selected < 0) return;
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const items = state.kind === "list" ? state.items : [];
  const settled = text.trim() === query;
  const choose = (issue: GitHubIssue) => {
    onAttach({
      key: `issue-${issue.repository}-${issue.number}-${Date.now()}`,
      name: issueFileName(issue),
      run: () => attachIssue(issue),
    });
    onClose();
  };
  const message = !ready
    ? "Select a repository to see issues."
    : state.kind === "loading"
      ? "Loading..."
      : state.kind === "error"
        ? problems.unavailable
        : state.problem
          ? problems[state.problem]
          : items.length === 0
            ? query
              ? "No issues match your search."
              : "No issues you’re involved with here. Search to find any issue."
            : undefined;

  return (
    <Modal title={title} onClose={onClose} className="import-issue">
      <div
        className="import-issue-body"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || !settled || !items.length)
            return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((value) =>
              event.key === "ArrowDown"
                ? Math.min(value + 1, items.length - 1)
                : Math.max(value - 1, 0),
            );
          } else if (
            event.key === "Enter" &&
            !event.repeat &&
            selected >= 0 &&
            event.target instanceof HTMLInputElement
          ) {
            event.preventDefault();
            choose(items[selected]);
          }
        }}
      >
        <label className="import-issue-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="text"
            autoComplete="off"
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={!message}
            aria-controls={message ? undefined : `${id}-list`}
            aria-activedescendant={
              selected >= 0 ? `${id}-option-${selected}` : undefined
            }
            aria-label="Search by issue number or title"
            placeholder="Search by issue number or title"
            value={text}
            disabled={!ready}
            onChange={(event) => {
              setText(event.target.value);
              setSelected(-1);
            }}
          />
        </label>
        {message ? (
          <p className="import-issue-note">{message}</p>
        ) : (
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={title}
            aria-busy={!settled || undefined}
            onMouseDown={(event) => {
              // Clicking a row keeps the focus in the search box.
              if (event.target !== event.currentTarget) event.preventDefault();
            }}
          >
            {items.map((issue, index) => (
              <li key={issue.number} role="presentation">
                <button
                  type="button"
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={index === selected}
                  tabIndex={-1}
                  onClick={() => choose(issue)}
                  onFocus={() => setSelected(index)}
                >
                  <span className="import-issue-state">
                    {issue.state === "closed" ? (
                      <CircleCheck size={14} />
                    ) : (
                      <CircleDot size={14} />
                    )}
                  </span>
                  <span className="import-issue-text" data-no-translate>
                    <span className="import-issue-title">
                      <span className="import-issue-number">
                        #{issue.number}
                      </span>{" "}
                      {issue.title}
                    </span>
                    <span className="import-issue-meta">
                      {issue.repository}
                      {issue.labels.length
                        ? ` · ${issue.labels.join(", ")}`
                        : ""}
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

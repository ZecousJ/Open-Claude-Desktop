import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "../ui/glyphs";
import type { Question } from "./QuestionsBody";
import { Keycap } from "./ApprovalActions";
import { useKeyGuard } from "./key-guard";
import { AppIcon } from "../ui/app-icon";
import { ReasonTooltip } from "../ui/Tooltip";
import { formatText, t } from "../i18n";

/**
 * Agent questions (request_user_input) as the original's question card: one
 * question per page with an "n/N" badge, collapse ⌄ and close ✕ in the header;
 * each option is a full-width row with its description and a keycap (1…n);
 * Other is the last row with its own field. Clicking an option selects it; Next
 * advances and Submit sends every answered or skipped page. The keys only
 * choose: 1…n pick an option, n+1 the Other row, ↑ ↓ move between them, and
 * Enter or ⌘↩ moves on. Back, Skip, and Next/Submit sit under the rows. Codex
 * questions take one answer each, so there are no checkboxes.
 */
export function QuestionsCard({
  questions,
  busy,
  frontmost,
  mac,
  onSubmit,
}: {
  questions: Question[];
  busy: boolean;
  /** Only the first pending request answers number keys. */
  frontmost: boolean;
  mac: boolean;
  onSubmit: (answers: Record<string, { answers: string[] }>) => void;
}) {
  const [page, setPage] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const otherInput = useRef<HTMLInputElement>(null);
  const q = questions[page];
  const last = page >= questions.length - 1;
  const options = q?.options ?? [];
  const allowOther = !options.length || q?.isOther !== false;
  const progress = questionCardProgress(
    questions,
    page,
    answers,
    other,
    skipped,
  );

  function finish(next: Record<string, string>, nextOther = other) {
    onSubmit(
      Object.fromEntries(
        questions.map((question) => {
          const value =
            next[question.id] === otherMark
              ? nextOther[question.id]?.trim()
              : next[question.id];
          return [question.id, { answers: value ? [value] : [] }];
        }),
      ),
    );
  }
  function advance(next: Record<string, string>) {
    if (busy || !progress.canAdvance) return;
    if (last) finish(next);
    else setPage(page + 1);
  }
  function skip() {
    if (!q || busy) return;
    const next = { ...answers };
    delete next[q.id];
    setAnswers(next);
    const nextSkipped = { ...skipped, [q.id]: true };
    setSkipped(nextSkipped);
    if (!last) setPage(page + 1);
    else {
      const remaining = questionCardProgress(
        questions,
        page,
        next,
        other,
        nextSkipped,
      );
      if (remaining.unanswered < 0) finish(next);
      else setPage(remaining.unanswered);
    }
  }

  /** Picks an option (or, for -1, the Other row and its field) without moving on. */
  function select(index: number) {
    if (!q || busy) return;
    setSkipped({ ...skipped, [q.id]: false });
    if (index === -1) {
      setAnswers({ ...answers, [q.id]: otherMark });
      otherInput.current?.focus();
      return;
    }
    if (document.activeElement === otherInput.current)
      otherInput.current?.blur();
    setAnswers({ ...answers, [q.id]: options[index].label });
  }
  /** ↓ goes down the rows and ends on Other, which hands back to the first; ↑ the other way. */
  function step(down: boolean) {
    const rows = [
      ...options.map((_, index) => index),
      ...(allowOther ? [-1] : []),
    ];
    if (!rows.length || !q) return;
    const index = options.findIndex((option) => option.label === answers[q.id]);
    // No row is chosen yet: ↓ starts at the first, ↑ at the last.
    const at = answers[q.id] === otherMark ? -1 : index < 0 ? undefined : index;
    const position = at === undefined ? -1 : rows.indexOf(at);
    select(
      position < 0
        ? rows[down ? 0 : rows.length - 1]
        : rows[(position + (down ? 1 : rows.length - 1)) % rows.length],
    );
  }

  // Keys choose; ⌘↩ and Enter send the choice on. A held key, a card that
  // has only just appeared and ⌘↩ right after typing do nothing (key-guard.ts).
  const guard = useKeyGuard(frontmost && !busy);
  const handler = useRef<(event: KeyboardEvent) => void>(undefined);
  handler.current = (event) => {
    if (!q || collapsed || busy || event.altKey || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    const inOther = target === otherInput.current;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      if (!progress.canAdvance) return;
      event.preventDefault();
      event.stopPropagation();
      if (guard(event) === "act") advance(answers);
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    if (
      !inOther &&
      target?.closest("input, textarea, [contenteditable='true']")
    )
      return;
    if (target?.closest("button, a")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.key === "ArrowDown");
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (!progress.canAdvance || (!inOther && target !== document.body))
        return;
      event.preventDefault();
      if (guard(event) === "act") advance(answers);
      return;
    }
    if (inOther) return;
    const index = Number(event.key) - 1;
    if (!Number.isInteger(index) || index < 0 || event.key.length !== 1) return;
    if (index < options.length || (index === options.length && allowOther)) {
      event.preventDefault();
      if (guard(event) === "act") select(index < options.length ? index : -1);
    }
  };
  useEffect(() => {
    if (!frontmost) return;
    const listener = (event: KeyboardEvent) => handler.current?.(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [frontmost]);

  if (!q) return null;
  return (
    <>
      <header className="question-card-header">
        <h3 className="approval-title">{q.question}</h3>
        {/* Several questions page with carets around "{position} of {count}". */}
        {questions.length > 1 && (
          <span className="question-card-pager">
            <button
              type="button"
              className="question-card-icon"
              aria-label={t("Show previous question")}
              disabled={busy || page === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPage(page - 1)}
            >
              <AppIcon name="CaretLeft16" />
            </button>
            <span>
              {formatText("{position} of {count}", {
                position: page + 1,
                count: questions.length,
              })}
            </span>
            <button
              type="button"
              className="question-card-icon"
              aria-label={t("Show next question")}
              disabled={busy || last}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPage(page + 1)}
            >
              <AppIcon name="CaretRight16" />
            </button>
          </span>
        )}
        <button
          type="button"
          className="question-card-icon"
          aria-label="View question options"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronDown size={15} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          className="question-card-icon"
          aria-label="Dismiss question"
          disabled={busy}
          onClick={() => finish({})}
        >
          <X size={15} strokeWidth={1.6} />
        </button>
      </header>
      {!collapsed && (
        <>
          <div
            className="question-card-options"
            role="radiogroup"
            aria-label={q.question}
          >
            {options.map((option, index) => (
              <button
                type="button"
                role="radio"
                aria-checked={answers[q.id] === option.label}
                className="question-card-option"
                key={option.label}
                disabled={busy}
                onClick={() => select(index)}
              >
                <span className="question-card-option-text">
                  <span className="question-card-label">{option.label}</span>
                  {option.description && (
                    <span className="question-card-description">
                      {option.description}
                    </span>
                  )}
                </span>
                <kbd className="approval-key">{index + 1}</kbd>
              </button>
            ))}
            {allowOther && (
              <div
                className="question-card-option question-card-other"
                data-checked={answers[q.id] === otherMark || undefined}
              >
                <span className="question-card-label">
                  {options.length ? "Other" : q.header || "Answer"}
                </span>
                {options.length > 0 && (
                  <kbd className="approval-key">{options.length + 1}</kbd>
                )}
                <input
                  ref={otherInput}
                  className="question-card-input"
                  type={q.isSecret ? "password" : "text"}
                  aria-label="Other option"
                  placeholder="Type your own answer here"
                  value={other[q.id] ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSkipped({ ...skipped, [q.id]: false });
                    setOther({ ...other, [q.id]: value });
                    setAnswers({
                      ...answers,
                      [q.id]: value.trim() ? otherMark : "",
                    });
                  }}
                />
              </div>
            )}
          </div>
          <div className="question-card-actions">
            {page > 0 && (
              <button
                type="button"
                className="approval-button question-card-button"
                disabled={busy}
                onClick={() => setPage(page - 1)}
              >
                Back
              </button>
            )}
            <span className="approval-actions-gap" />
            <button
              type="button"
              className="approval-button question-card-button"
              disabled={busy}
              onClick={skip}
            >
              Skip
            </button>
            <ReasonTooltip
              reason={
                !busy && !progress.canAdvance ? progress.reason : undefined
              }
              placement="above"
            >
              {(tip) => (
                <button
                  {...tip}
                  type="button"
                  className="approval-button question-card-button"
                  data-primary
                  disabled={busy || !progress.canAdvance}
                  onClick={() => advance(answers)}
                >
                  {last ? "Submit" : "Next"}
                  {frontmost && (
                    <span className="approval-keys">
                      <Keycap k="mod" mac={mac} />
                      <Keycap k="enter" mac={mac} />
                    </span>
                  )}
                </button>
              )}
            </ReasonTooltip>
          </div>
        </>
      )}
    </>
  );
}

/** The Other row's answer is kept apart from the option labels. */
const otherMark = "\u0000other";

// Submit requires every page to be answered or explicitly skipped.
export function questionCardProgress(
  questions: Question[],
  page: number,
  answers: Record<string, string>,
  other: Record<string, string>,
  skipped: Record<string, boolean>,
) {
  const answered = (question: Question) =>
    Boolean(
      skipped[question.id] ||
      (answers[question.id] === otherMark
        ? other[question.id]?.trim()
        : answers[question.id]),
    );
  const unanswered = questions.findIndex((question) => !answered(question));
  const current = questions[page];
  const currentAnswered = Boolean(current && answered(current));
  const canAdvance =
    currentAnswered && (page < questions.length - 1 || unanswered < 0);
  return {
    canAdvance,
    unanswered,
    reason: canAdvance
      ? undefined
      : currentAnswered
        ? formatText("Question {n} is unanswered", { n: unanswered + 1 })
        : t("Choose an option or skip this question"),
  };
}

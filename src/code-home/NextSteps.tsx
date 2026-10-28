import { useContext, useEffect, useMemo, useState } from "react";
import { approvalKind } from "../../shared/approval-response";
import { CodeHomeSuggestionsSlot } from "./CodeHomeSuggestionsSlot";
import { Check } from "../ui/glyphs";
import type {
  FolderBranches,
  FolderChanges,
} from "../../shared/code-usage-api";
import type { GitHubPullRequest } from "../../shared/github-api";
import { preference } from "../../shared/settings-extras";
import { AppContext } from "../app/AppContext";
import { formatText, t } from "../i18n";
import { NextStepIcon, type NextStepGlyph } from "./next-step-glyphs";
import {
  dismiss,
  nextSteps,
  shownSteps,
  type Dismissals,
  type NextStep,
} from "./next-steps";
import { StartCardRow, StartCardRows, startRowOrder } from "./StartCardRows";
import "./next-steps.css";

const storageKey = "startCardDismissals";
function readDismissals(): Dismissals {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function writeDismissals(value: Dismissals) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {}
}

type Words = {
  icon: NextStepGlyph;
  title: string;
  blocked?: boolean;
  detail?: string;
  tooltip?: string;
  dismissLabel: string;
  /** Acting here (no chevron): the row does its thing in place. */
  inPlace?: boolean;
};

/** Each row's words. */
function wordsOf(step: NextStep): Words {
  switch (step.id) {
    case "waiting-session":
      return {
        icon: "Hand16",
        title: step.title,
        blocked: true,
        detail: t(
          step.on === "question" ? "Asked a question" : "Needs permission",
        ),
        tooltip: step.title,
        dismissLabel: formatText("Dismiss “{title}”", { title: step.title }),
      };
    case "worktree-apart":
      return {
        icon: "GitBranch",
        title: t("Turn on Worktree"),
        detail: t("Session running here"),
        tooltip: t(
          "Another session is running in this folder. Worktree gives this session its own copy, so their changes stay apart.",
        ),
        dismissLabel: t("Dismiss the Worktree suggestion"),
        inPlace: true,
      };
    case "resume-session":
      return {
        icon: "Clock16",
        title: step.title,
        blocked: true,
        detail: t("Hit an error"),
        tooltip: step.title,
        dismissLabel: formatText("Dismiss “{title}”", { title: step.title }),
      };
    case "pr-ci-failed":
      return {
        icon: "WarningCircle",
        title: t("Fix the failing checks"),
        detail: step.check,
        tooltip: step.check
          ? formatText("{check} is failing on {branch}.", {
              check: step.check,
              branch: step.branch,
            })
          : formatText("Checks are failing on {branch}.", {
              branch: step.branch,
            }),
        dismissLabel: t("Dismiss the failing checks"),
        inPlace: true,
      };
    case "pr-review-comments":
      return {
        icon: "Comment",
        title:
          step.count === 1
            ? t("Answer 1 review comment")
            : formatText("Answer {count} review comments", {
                count: step.count,
              }),
        detail: step.title,
        tooltip: step.title,
        dismissLabel: t("Dismiss the review comments"),
        inPlace: true,
      };
    case "continue-branch":
      return {
        icon: "GitBranch",
        title: t("Continue uncommitted work"),
        detail:
          step.files === 1
            ? t("1 file")
            : formatText("{count} files", { count: step.files }),
        tooltip:
          step.files === 1
            ? formatText("1 uncommitted file on {branch}", {
                branch: step.branch,
              })
            : formatText("{count} uncommitted files on {branch}", {
                count: step.files,
                branch: step.branch,
              }),
        dismissLabel: t("Dismiss the uncommitted work"),
        inPlace: true,
      };
  }
}

/**
 * Next steps under the Code home's composer: a 320px card of up to three rows —
 * a session waiting on you, Turn on Worktree when another session runs in the
 * chosen folder, a session that stopped on an error, uncommitted work on a
 * branch. A row opens the session, turns Worktree on ("Worktree is on" with a
 * check) or writes the prompt into the composer; its × dismisses it until what
 * it is about changes.
 */
export default function NextSteps({
  cwd,
  onPrompt,
}: {
  cwd?: string;
  /** Puts a prompt in the composer (Continue uncommitted work). */
  onPrompt: (text: string) => void;
}) {
  const app = useContext(AppContext);
  const homeSlot = useContext(CodeHomeSuggestionsSlot);
  const [dismissals, setDismissals] = useState(readDismissals);
  const [branches, setBranches] = useState<FolderBranches | null>(null);
  const [changes, setChanges] = useState<FolderChanges | null>(null);
  const [pullRequest, setPullRequest] = useState<GitHubPullRequest | null>(
    null,
  );
  // The folder whose Worktree row was pressed here: it stays, as done.
  const [taken, setTaken] = useState<string>();
  useEffect(() => {
    setBranches(null);
    setChanges(null);
    setPullRequest(null);
    if (!cwd) return;
    let live = true;
    void Promise.resolve(window.desktop?.folderBranches?.(cwd))
      .then((value) => live && setBranches(value ?? null))
      .catch(() => undefined);
    void Promise.resolve(window.desktop?.folderChanges?.(cwd))
      .then((value) => live && setChanges(value ?? null))
      .catch(() => undefined);
    void Promise.resolve(window.desktop?.folderPullRequest?.(cwd))
      .then((value) => live && setPullRequest(value ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cwd]);
  const settings = app?.snapshot.settings;
  const worktreeOn = Boolean(settings && preference(settings, "codeWorktree"));
  const listed = app?.listed;
  const approvals = app?.snapshot.approvals;
  const rows = useMemo(() => {
    const steps = nextSteps({
      folder: cwd,
      repository: branches !== null,
      worktreeOn,
      conversations: listed ?? [],
      waiting: (approvals ?? []).map((a) => ({
        conversationId: a.conversationId,
        id: String(a.id),
        on: approvalKind(a) === "questions" ? "question" : "permission",
      })),
      branch: branches ?? undefined,
      uncommittedFiles: changes?.files,
      pullRequest,
      now: Date.now(),
    }).filter(
      (step) =>
        !(step.id === "worktree-apart" && step.taken && step.folder !== taken),
    );
    return shownSteps(steps, dismissals);
  }, [
    cwd,
    branches,
    changes,
    pullRequest,
    worktreeOn,
    listed,
    approvals,
    dismissals,
    taken,
  ]);
  if (!app || !rows.length) return null;

  const open = (sessionId: string) => {
    const conversation = app.listed.find((c) => c.id === sessionId);
    if (conversation) app.openConversation(conversation);
  };
  const press = (step: NextStep) => {
    switch (step.id) {
      case "waiting-session":
      case "resume-session":
        return open(step.sessionId);
      case "worktree-apart":
        setTaken(step.folder);
        return void app.updatePreference({ codeWorktree: true });
      case "pr-ci-failed":
        return onPrompt(
          formatText(
            "Fix the failing CI checks on {branch}: find out why they fail and fix them.",
            { branch: step.branch },
          ),
        );
      case "pr-review-comments":
        return onPrompt(
          formatText(
            "Read the unresolved review comments on {repo}#{number} and address each one: make the change, or reply with why not.",
            { repo: step.repository, number: step.number },
          ),
        );
      case "continue-branch":
        return onPrompt(
          formatText(
            "Continue the work in progress on {branch}: look at the uncommitted changes, tell me what state they’re in, and finish what’s started.",
            { branch: step.branch },
          ),
        );
    }
  };
  return (
    <StartCardRows slot={homeSlot}>
      {rows.map(({ first: step, more }) => {
        const words = wordsOf(step);
        const key =
          "sessionId" in step
            ? `${step.id}:${step.sessionId}`
            : "pr" in step
              ? `${step.id}:${step.pr}`
              : step.id;
        if (step.id === "worktree-apart" && step.taken)
          return (
            <li key={key} style={{ order: startRowOrder.nextSteps }}>
              <div className="next-step-row" data-taken>
                <NextStepIcon name={words.icon} />
                <span className="next-step-title">{t("Worktree is on")}</span>
                <Check
                  size={16}
                  className="next-step-check"
                  aria-hidden="true"
                />
              </div>
            </li>
          );
        const detail =
          more > 0
            ? more === 1
              ? t("and 1 more")
              : formatText("and {count} more", { count: more })
            : words.detail;
        return (
          <StartCardRow
            key={key}
            order={startRowOrder.nextSteps}
            icon={
              words.blocked ? undefined : <NextStepIcon name={words.icon} />
            }
            lead={
              words.blocked && (
                <>
                  <span className="next-step-blocked">{t("Blocked")}</span>{" "}
                </>
              )
            }
            title={words.title}
            detail={detail}
            holds={more > 0}
            tooltip={words.tooltip}
            end={
              words.blocked ? undefined : words.inPlace ? "spacer" : "chevron"
            }
            dismissLabel={words.dismissLabel}
            onPress={() => press(step)}
            onDismiss={() => {
              const next = dismiss(dismissals, step);
              writeDismissals(next);
              setDismissals(next);
            }}
          />
        );
      })}
    </StartCardRows>
  );
}

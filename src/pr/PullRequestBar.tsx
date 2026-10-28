import { useEffect, useRef, useState } from "react";
import { api } from "../desktop-api";
import type { Conversation } from "../../shared/types";
import type {
  GitHubPullRequest,
  PullRequestAction,
} from "../../shared/github-api";
import {
  commitPrompt,
  compareUrl,
  createPrPrompt,
} from "../../shared/pull-request";
import {
  actionAnnouncements,
  actionFailureMessage,
  ciStatus,
  displayStateLabels,
  mergeHold,
  mergeHoldMessage,
  offersMerge,
  pullRequestDisplayState,
} from "../../shared/pull-request-status";
import { useApp } from "../app/AppContext";
import { type MenuEntry, type MenuPosition } from "../ui/Menu";
import { WithTooltip } from "../ui/Tooltip";
import {
  createLabels,
  prAction,
  rowAccent,
  type CreateMode,
} from "./branch-row";
import { useBranchRow } from "./useBranchRow";
import {
  pullRequestEntry,
  pullRequestKey,
  readPullRequest,
} from "./pr-status-store";
import { PrStateGlyph } from "./PrStateGlyph";
import { useAutoArchive } from "./auto-archive";
import { openPullRequest } from "./open-pull-request";
import "./pull-request-bar.css";
import { pullRequestBarView } from "./PullRequestBarView";

const modeKey = "claudex.prCreateMode";

/** The split button's last choice; it survives restarts like the original's. */
function useCreateMode(): [CreateMode, (mode: CreateMode) => void] {
  const [mode, setMode] = useState<CreateMode>(() => {
    try {
      const saved = localStorage.getItem(modeKey);
      return saved === "draft" || saved === "compose" ? saved : "create";
    } catch {
      return "create";
    }
  });
  return [
    mode,
    (next) => {
      setMode(next);
      try {
        localStorage.setItem(modeKey, next);
      } catch {
        // The choice just isn't remembered.
      }
    },
  ];
}

/** "owner/name" → "name": the repository chip's text. */
export const repositoryName = (repository: string | undefined, cwd?: string) =>
  repository?.split("/").pop() ||
  cwd
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ||
  "";

/** Where Merge is: idle, reading the request, or confirming. */
export type MergeStep =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "confirm"; headSha?: string; writing: boolean };

export const running = "Claudex is working — wait for the turn to finish";

/**
 * The branch row above the Code composer: the session's repository and branch,
 * how much it changes (opens the Changes panel), and Create PR. Create PR does
 * not call GitHub itself: it asks Claude to commit, push and open the pull
 * request (`/create-pr`), as the original does for a session in a folder, and
 * the row then follows the pull request Claude names in its reply: its state
 * glyph (open, draft, approved, changes requested, conflicts, queued, merged,
 * closed), the CI chip and its panel (checks by state, auto-merge,
 * auto-archive), and the changes GitHub allows from here: Mark ready for a
 * draft, and Merge, with a confirmation, for an approved request whose checks
 * passed. (The original keeps those two in its session rail, which Claudex does
 * not have; the row is where this window shows the request.)
 */
export default function PullRequestBar({
  conversation,
  send: sendMessage,
  openLink,
}: {
  conversation: Conversation;
  /** Sends a message in the session (the window's own send, so queueing and errors are its). */
  send: (text: string) => Promise<void>;
  /** Opens a link the way the window does (the built-in browser or the default one). */
  openLink: (url: string) => void;
}) {
  const app = useApp();
  const { status, ref, pr, problem } = useBranchRow(conversation);
  const [mode, setMode] = useCreateMode();
  const [menu, setMenu] = useState<MenuPosition>();
  // The open request's menu (Convert to draft).
  const [prMenu, setPrMenu] = useState<MenuPosition>();
  const prMore = useRef<HTMLButtonElement>(null);
  const [merge, setMerge] = useState<MergeStep>({ phase: "idle" });
  const [busy, setBusy] = useState<PullRequestAction>();
  const [announcement, setAnnouncement] = useState("");
  const autoArchive = useAutoArchive(conversation.id, app.snapshot.settings);
  const more = useRef<HTMLButtonElement>(null);
  // ⌥⌘G (Ctrl+Alt+G elsewhere) opens the session's pull request. Matched by the
  // physical key, because Option+G types another character on macOS.
  const openKey = useRef<() => void>(() => {});
  const openPage = (url: string) => {
    if (ref && url === ref.url && !app.toolPanels.isOpen("pr"))
      app.setPanel("pr");
    else openLink(url);
  };
  openKey.current = () => {
    if (ref) openPullRequest(ref.url, app.snapshot.settings, openPage);
  };
  const mac = app.snapshot.platform === "darwin";
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.code !== "KeyG" ||
        !event.altKey ||
        event.shiftKey ||
        !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey) ||
        event.isComposing ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      if (!event.repeat) openKey.current();
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [mac]);
  if (!status || status.state !== "ready") return null;
  if (!status.branch && !ref) return null;

  const cloud = conversation.environment?.kind === "space";
  const ssh = conversation.environment?.kind === "ssh";
  const action = prAction({
    status,
    cloud,
    running: app.running,
    mode,
    lookingUp: false,
  });
  const repository = status.repository ?? ref?.repository;
  const accent = rowAccent(pr);
  const sending = app.sending && !action.disabled;
  const display = pr ? pullRequestDisplayState(pr) : undefined;
  const settled = pr?.state === "merged" || pr?.state === "closed";
  const ci = accent ? undefined : ciStatus(pr);
  const open = (url: string) =>
    openPullRequest(url, app.snapshot.settings, openPage);

  const send = () => {
    const prompt =
      action.kind === "commit"
        ? commitPrompt
        : createPrPrompt({
            repository: status.repository,
            branch: status.branch ?? "",
            baseBranch: status.baseBranch,
            cwd: cloud ? undefined : conversation.cwd,
            draft: mode === "draft",
            cloud,
          });
    void sendMessage(prompt).catch(app.report);
  };
  const compose = () => {
    const url =
      status.repository && status.branch
        ? compareUrl({
            repository: status.repository,
            branch: status.branch,
            baseBranch: status.baseBranch,
          })
        : undefined;
    if (!url) return app.notify("Couldn’t create the pull request. Try again.");
    // Fresh clones know what is on the remote; a branch it lacks has no page yet.
    if (!status.pushed)
      return app.notify(
        "This branch hasn’t been pushed to GitHub. Push it and try again.",
      );
    openLink(url);
  };
  const run = () => {
    if (action.disabled || sending) return;
    if (action.kind === "create" && mode === "compose") compose();
    else send();
  };
  const choice = (value: CreateMode): MenuEntry => ({
    label: createLabels[value],
    checked: mode === value,
    onSelect: () => setMode(value),
  });
  // The original sets "Manually create PR" apart with a rule above it.
  const entries: MenuEntry[] = [
    choice("create"),
    choice("draft"),
    { separator: true },
    choice("compose"),
  ];
  const openMenu = () => {
    const box = more.current?.getBoundingClientRect();
    if (!box) return;
    setMenu(
      menu
        ? undefined
        : { right: innerWidth - box.right, bottom: innerHeight - box.top + 6 },
    );
  };

  /** One change on GitHub; the row reads the request again afterwards. */
  const change = async (
    target: GitHubPullRequest,
    kind: PullRequestAction,
    headSha?: string,
  ) => {
    const result = await api
      .githubPullRequestAction({
        repository: target.repository,
        number: target.number,
        action: kind,
        ...(headSha ? { headSha } : {}),
        ...(target.mergeMethod ? { mergeMethod: target.mergeMethod } : {}),
      })
      .catch(() => ({ ok: false as const, reason: "unknown" as const }));
    if (ref) void readPullRequest(ref);
    return result;
  };
  const toggleAutoMerge = async (target: GitHubPullRequest, on: boolean) => {
    const kind = on ? "autoMergeOn" : "autoMergeOff";
    setBusy(kind);
    const result = await change(target, kind);
    setBusy(undefined);
    if (result.ok) setAnnouncement(actionAnnouncements[kind]);
    else
      app.notify(
        actionFailureMessage(
          kind,
          result.reason,
          "detail" in result ? result.detail : undefined,
        ),
      );
  };
  // Convert to draft.
  const convertToDraft = async (target: GitHubPullRequest) => {
    setBusy("draft");
    const result = await change(target, "draft");
    setBusy(undefined);
    if (result.ok || result.reason === "already_in_state")
      setAnnouncement(actionAnnouncements.draft);
    else app.notify(actionFailureMessage("draft", result.reason));
  };
  const markReady = async (target: GitHubPullRequest) => {
    setBusy("ready");
    const result = await change(target, "ready");
    setBusy(undefined);
    if (result.ok) setAnnouncement(actionAnnouncements.ready);
    else if (result.reason === "already_in_state")
      setAnnouncement(actionAnnouncements.ready);
    else app.notify(actionFailureMessage("ready", result.reason));
  };
  // Merge reads the request again first, so what is merged is what the person
  // saw; then it asks to confirm.
  const startMerge = async () => {
    if (!ref || merge.phase !== "idle") return;
    setMerge({ phase: "checking" });
    await readPullRequest(ref);
    const fresh = pullRequestEntry(pullRequestKey(ref));
    if (!fresh.pr || fresh.problem) {
      setMerge({ phase: "idle" });
      return app.notify("Couldn’t load the pull request, so it wasn’t merged.");
    }
    const hold = mergeHold(fresh.pr);
    if (hold || !offersMerge(fresh.pr)) {
      setMerge({ phase: "idle" });
      const message = mergeHoldMessage(
        hold ?? "conflicting",
        fresh.pr.baseRef || undefined,
      );
      return hold === "armed" ? setAnnouncement(message) : app.notify(message);
    }
    setMerge({ phase: "confirm", headSha: fresh.pr.headSha, writing: false });
  };
  const confirmMerge = async (target: GitHubPullRequest) => {
    if (merge.phase !== "confirm" || merge.writing) return;
    setMerge({ ...merge, writing: true });
    const result = await change(target, "merge", merge.headSha);
    setMerge({ phase: "idle" });
    if (result.ok)
      setAnnouncement(
        "queued" in result && result.queued
          ? actionAnnouncements.queued
          : actionAnnouncements.merged,
      );
    else
      app.notify(
        result.reason === "head_moved"
          ? mergeHoldMessage("conflicting")
          : actionFailureMessage("merge", result.reason),
      );
  };

  const state = display && display !== "none" ? display : undefined;
  const stateLabel = state ? displayStateLabels[state] : "Pull request";
  const glyph = (
    <WithTooltip label={stateLabel}>
      {(props) => (
        <span
          {...props}
          role="img"
          aria-label={stateLabel}
          className="pr-glyph"
          data-state={state ?? "unknown"}
        >
          <PrStateGlyph state={state ?? "open"} />
        </span>
      )}
    </WithTooltip>
  );
  const diff =
    status.additions > 0 || status.deletions > 0
      ? { added: status.additions, removed: status.deletions }
      : undefined;
  const actionsShown = !accent && !settled && pr;
  const pullRequestBarViewView = pullRequestBarView({
    accent,
    action,
    actionsShown,
    announcement,
    app,
    autoArchive,
    busy,
    ci,
    cloud,
    confirmMerge,
    conversation,
    convertToDraft,
    diff,
    entries,
    glyph,
    markReady,
    menu,
    merge,
    more,
    open,
    openLink,
    openMenu,
    pr,
    prMenu,
    prMore,
    problem,
    ref,
    repository,
    run,
    sendMessage,
    sending,
    setMenu,
    setMerge,
    setPrMenu,
    settled,
    ssh,
    startMerge,
    state,
    stateLabel,
    status,
    toggleAutoMerge,
  });
  return pullRequestBarViewView;
}

import { ConflictFix, CiChip } from "./PrPopovers";
import { running, repositoryName } from "./PullRequestBar";
import {
  conflictFixPrompt,
  problemWarning,
  autoMergeBlock,
  checksUrl,
  offersMerge,
} from "../../shared/pull-request-status";
import { WithTooltip, ReasonTooltip } from "../ui/Tooltip";
import { GitBranch, ChevronDown } from "../ui/glyphs";
import { BranchChip, branchUrl, BehindCount } from "./BranchChip";
import { AppIcon } from "../ui/app-icon";
import { reviewTurn, ReviewTurnChip, ReviewCommentsChip } from "./ReviewChips";
import { setSessionAutoArchive } from "./auto-archive";
import { surface } from "../../shared/host";
import { api } from "../desktop-api";
import { Menu } from "../ui/Menu";
import type {
  GitHubPullRequest,
  PullRequestAction,
  GitHubProblem,
  PullRequestState,
} from "../../shared/github-api";
import type { Conversation } from "../../shared/types";
import type { MenuEntry, MenuPosition } from "../ui/Menu";
import type { MergeStep } from "./PullRequestBar";
import type { PrAction } from "./branch-row";
import type { AppController } from "../app/AppContext";
import type { PullRequestRef } from "../../shared/pull-request";
import type { CodeGitStatus } from "../../shared/panels-api";
import type { CiStatus } from "../../shared/pull-request-status";

/** What pullRequestBarView needs from PullRequestBar.tsx. */
export interface PullRequestBarViewKit {
  accent: "merged" | "queued" | undefined;
  action: PrAction;
  actionsShown: false | GitHubPullRequest | undefined;
  announcement: string;
  app: AppController;
  autoArchive: boolean;
  busy: PullRequestAction | undefined;
  ci: CiStatus | undefined;
  cloud: boolean;
  confirmMerge: (target: GitHubPullRequest) => Promise<void>;
  conversation: Conversation;
  convertToDraft: (target: GitHubPullRequest) => Promise<void>;
  diff: { added: number; removed: number } | undefined;
  entries: MenuEntry[];
  glyph: React.JSX.Element;
  markReady: (target: GitHubPullRequest) => Promise<void>;
  menu: MenuPosition | undefined;
  merge: MergeStep;
  more: React.RefObject<HTMLButtonElement | null>;
  open: (url: string) => void;
  openLink: (url: string) => void;
  openMenu: () => void;
  pr: GitHubPullRequest | undefined;
  prMenu: MenuPosition | undefined;
  prMore: React.RefObject<HTMLButtonElement | null>;
  problem: GitHubProblem | undefined;
  ref: PullRequestRef | undefined;
  repository: string | undefined;
  run: () => void;
  sendMessage: (text: string) => Promise<void>;
  sending: boolean;
  setMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setMerge: React.Dispatch<React.SetStateAction<MergeStep>>;
  setPrMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  settled: boolean;
  ssh: boolean;
  startMerge: () => Promise<void>;
  state:
    | PullRequestState
    | "approved"
    | "changesRequested"
    | "conflicting"
    | undefined;
  stateLabel: string;
  status: CodeGitStatus;
  toggleAutoMerge: (target: GitHubPullRequest, on: boolean) => Promise<void>;
}

export function pullRequestBarView(kit: PullRequestBarViewKit) {
  const {
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
  } = kit;
  const pullRequestBarViewView = (
    <div
      className="pr-bar"
      data-accent={accent}
      role="group"
      aria-label="Repository and pull request controls"
    >
      <div className="pr-lead">
        {ref ? (
          <>
            {state === "conflicting" && pr ? (
              <ConflictFix
                label={stateLabel}
                busyReason={app.running ? running : undefined}
                onFix={() =>
                  void sendMessage(conflictFixPrompt(pr.number, pr.url)).catch(
                    app.report,
                  )
                }
              />
            ) : (
              glyph
            )}
            <WithTooltip label="View pull request">
              {(props) => (
                <a
                  {...props}
                  className="pr-number"
                  data-no-translate
                  data-state={state ?? "unknown"}
                  data-accent={accent}
                  href={ref.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey)
                      return;
                    event.preventDefault();
                    open(ref.url);
                  }}
                >
                  <bdi>#{ref.number}</bdi>
                </a>
              )}
            </WithTooltip>
          </>
        ) : (
          <span role="img" aria-label="Branch" className="pr-glyph pr-plain">
            <GitBranch size={16} strokeWidth={1.75} />
          </span>
        )}
        {repository && (
          <WithTooltip
            label={
              status.baseBranch && !settled
                ? `${repository}:${status.baseBranch}`
                : repository
            }
          >
            {(props) => (
              <span {...props} className="pr-chip pr-repo" data-no-translate>
                <span>{repositoryName(repository)}</span>
              </span>
            )}
          </WithTooltip>
        )}
        {(status.branch || pr?.headRef) && (
          <BranchChip
            branch={status.branch ?? pr?.headRef ?? ""}
            tooltip={pr?.title || status.branch || ""}
            detail={status.branch}
            url={
              ref && pr && ref.host === "github.com" && pr.state !== "merged"
                ? branchUrl(ref.repository, status.branch ?? pr?.headRef ?? "")
                : undefined
            }
            openLink={openLink}
          />
        )}
      </div>
      <div className="pr-trail">
        {problem && ref && (
          <WithTooltip label={problemWarning(problem)} size="wrap">
            {(props) => (
              <span
                {...props}
                role="img"
                aria-label={problemWarning(problem)}
                className="pr-warning"
              >
                <AppIcon name="Warning" size={14} strokeWidth={1.75} />
              </span>
            )}
          </WithTooltip>
        )}
        {!settled &&
          Boolean(status.behind) &&
          status.baseBranch &&
          status.branch !== status.baseBranch && (
            <BehindCount count={status.behind ?? 0} base={status.baseBranch} />
          )}
        {!accent && !settled && diff && (
          <WithTooltip label="View changes">
            {(props) => (
              <button
                {...props}
                type="button"
                className="pr-diff"
                onClick={() => app.toolPanels.setPanel("changes")}
              >
                <span className="pr-add">+{diff.added}</span>
                <span className="pr-del">−{diff.removed}</span>
              </button>
            )}
          </WithTooltip>
        )}
        {pr && reviewTurn(pr) !== undefined && (
          <ReviewTurnChip yours={reviewTurn(pr)!} />
        )}
        {pr && (pr.openReviewThreads ?? 0) > 0 && (
          <ReviewCommentsChip
            count={pr.openReviewThreads!}
            onClick={() => open(`${pr.url}/files`)}
          />
        )}
        {pr && ci && (
          <CiChip
            pr={pr}
            status={ci}
            autoMergeReason={autoMergeBlock(pr, ssh)}
            autoMergeBusy={busy === "autoMergeOn" || busy === "autoMergeOff"}
            onAutoMerge={(on) => void toggleAutoMerge(pr, on)}
            autoArchive={autoArchive}
            onAutoArchive={(on) => {
              setSessionAutoArchive(conversation.id, on);
              void window.desktop
                ?.updateConversation(conversation.id, { prAutoArchive: on })
                .catch(() => undefined);
            }}
            onOpenChecks={() => open(checksUrl(pr))}
            // Auto-fix runs on this computer for its own sessions.
            {...(surface !== "web" && !cloud && !ssh
              ? {
                  autoFix: {
                    ci: conversation.prAutoFix?.ci ?? false,
                    comments: conversation.prAutoFix?.comments ?? false,
                  },
                  onAutoFix: (prAutoFix: { ci: boolean; comments: boolean }) =>
                    void api
                      .updateConversation(conversation.id, { prAutoFix })
                      .then(app.upsert, () =>
                        app.notify(
                          "Couldn’t update the PR auto-fix setting. Try again.",
                        ),
                      ),
                }
              : {})}
          />
        )}
        {actionsShown && pr!.state === "draft" && pr!.canMerge !== false && (
          <button
            type="button"
            className="pr-action pr-solo"
            aria-busy={busy === "ready" || undefined}
            disabled={busy === "ready"}
            onClick={() => void markReady(pr!)}
          >
            Mark ready
          </button>
        )}
        {actionsShown && pr!.state === "open" && (
          <button
            ref={prMore}
            type="button"
            className="pr-ghost pr-options"
            aria-label="More PR options"
            aria-haspopup="menu"
            aria-expanded={Boolean(prMenu)}
            aria-busy={busy === "draft" || undefined}
            disabled={busy === "draft"}
            onClick={() => {
              const box = prMore.current?.getBoundingClientRect();
              if (!box) return;
              setPrMenu(
                prMenu
                  ? undefined
                  : {
                      right: innerWidth - box.right,
                      bottom: innerHeight - box.top + 6,
                    },
              );
            }}
          >
            <ChevronDown size={14} strokeWidth={1.75} />
          </button>
        )}
        {actionsShown &&
          (offersMerge(pr) || merge.phase !== "idle") &&
          (merge.phase === "confirm" ? (
            <span
              role="group"
              className="pr-confirm"
              aria-label={`Merge pull request #${pr!.number}?`}
            >
              <button
                type="button"
                className="pr-ghost"
                disabled={merge.writing}
                onClick={() => setMerge({ phase: "idle" })}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pr-action pr-solo"
                aria-busy={merge.writing || undefined}
                disabled={merge.writing}
                onClick={() => void confirmMerge(pr!)}
              >
                Confirm merge
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="pr-action pr-solo"
              aria-busy={merge.phase === "checking" || undefined}
              disabled={merge.phase === "checking"}
              onClick={() => void startMerge()}
            >
              {merge.phase === "checking"
                ? "Checking the pull request…"
                : "Merge"}
            </button>
          ))}
        {!ref && (
          <ReasonTooltip reason={action.disabled} placement="above">
            {(tip) => (
              <span className="pr-split" data-menu={action.kind === "create"}>
                <button
                  {...tip}
                  type="button"
                  className="pr-action"
                  aria-disabled={Boolean(action.disabled) || undefined}
                  aria-busy={sending || undefined}
                  onClick={run}
                >
                  {sending && action.kind === "create"
                    ? "Creating PR…"
                    : action.label}
                </button>
                {action.kind === "create" && (
                  <button
                    ref={more}
                    type="button"
                    className="pr-more"
                    aria-label="More PR options"
                    aria-haspopup="menu"
                    aria-expanded={Boolean(menu)}
                    aria-disabled={sending || undefined}
                    onClick={() => !sending && openMenu()}
                  >
                    <ChevronDown size={14} strokeWidth={1.75} />
                  </button>
                )}
              </span>
            )}
          </ReasonTooltip>
        )}
      </div>
      {/* What a change did, for screen readers. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {prMenu && pr && (
        <Menu
          label="More PR options"
          position={prMenu}
          width={190}
          entries={[
            {
              label: "Convert to draft",
              onSelect: () => void convertToDraft(pr),
            },
          ]}
          anchors={[prMore]}
          onClose={() => setPrMenu(undefined)}
        />
      )}
      {menu && (
        <Menu
          label="More PR options"
          position={menu}
          width={190}
          entries={entries}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
  return pullRequestBarViewView;
}

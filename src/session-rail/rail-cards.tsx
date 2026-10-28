import {
  RailCard,
  RailRow,
  SessionFolders,
  RailSwitch,
  ContextMeter,
  tokens,
  severity,
} from "./RailParts";
import { formatText } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { BranchChip, branchUrl } from "../pr/BranchChip";
import { api } from "../desktop-api";
import { openComposerMenu } from "./SessionRail";
import type { CardChrome } from "./RailParts";
import type { Conversation, GeneratedFile } from "../../shared/types";
import type { AppController } from "../app/AppContext";
import type { McpServerState } from "../../shared/settings-desktop-api";
import type { DevServerState } from "../../shared/browser";
import type { PullRequestEntry } from "../pr/pr-status-store";
import type { PullRequestRef } from "../../shared/pull-request";
import type { GitHubPullRequest } from "../../shared/github-api";
import type { CodeGitStatus } from "../../shared/panels-api";
import type { ContextUsage } from "../composer/context-usage";
import type { WeeklyUsageStatus } from "../../shared/usage-api";
import { fillRailToolCards, type RailTaskRow } from "./rail-cards-tools";

/** What fillRailCards needs from SessionRail.tsx. */
export interface FillRailCardsKit {
  app: AppController;
  branch: string | undefined;
  cards: Partial<
    Record<
      | "goal"
      | "environment"
      | "settings"
      | "context"
      | "usage"
      | "connectors"
      | "progress"
      | "outputs"
      | "pullRequests"
      | "servers"
      | "backgroundTasks",
      React.ReactNode
    >
  >;
  chrome: CardChrome;
  cloud: boolean;
  connectors: McpServerState[];
  conversation: Conversation;
  devServers: DevServerState[];
  earlierEntries: PullRequestEntry[];
  earlierRefs: PullRequestRef[];
  environmentHint: "SSH" | undefined;
  environmentLabel: string;
  /** A cloud session's: edits the cloud environment it runs in. */
  editCloudEnvironment?: () => void;
  finished: number;
  folderName: string | undefined;
  hint: string | undefined;
  id: string;
  local: boolean;
  outputRows: { shown: GeneratedFile[]; toggle: React.JSX.Element | null };
  outputs: GeneratedFile[];
  pct: number | null;
  pr: GitHubPullRequest | undefined;
  reconnect: McpServerState[];
  ref: PullRequestRef | undefined;
  remoteAllowed: boolean;
  remoteOn: boolean;
  running: RailTaskRow[];
  setEditingGoal: React.Dispatch<React.SetStateAction<boolean>>;
  setStopping: React.Dispatch<React.SetStateAction<Set<string>>>;
  settingsRows: { model: string; effort: string; permissions: string };
  settled: boolean;
  sshHost: {
    label: string | undefined;
    connection:
      "connecting" | "reconnecting" | "disconnected" | "idle" | undefined;
  };
  status: CodeGitStatus | undefined;
  stopping: Set<string>;
  t: (text: string) => string;
  taskRows: {
    shown: RailTaskRow[];
    toggle: React.JSX.Element | null;
  };
  usage: ContextUsage;
  weekly: WeeklyUsageStatus | null;
}

export function fillRailCards(kit: FillRailCardsKit) {
  const {
    app,
    branch,
    cards,
    chrome,
    cloud,
    connectors,
    conversation,
    devServers,
    earlierEntries,
    earlierRefs,
    environmentHint,
    environmentLabel,
    editCloudEnvironment,
    finished,
    folderName,
    hint,
    id,
    local,
    outputRows,
    outputs,
    pct,
    pr,
    reconnect,
    ref,
    remoteAllowed,
    remoteOn,
    running,
    setEditingGoal,
    setStopping,
    settingsRows,
    settled,
    sshHost,
    status,
    stopping,
    t,
    taskRows,
    usage,
    weekly,
  } = kit;
  if (conversation.goal?.condition.trim()) {
    cards.goal = (
      <RailCard
        chrome={chrome}
        id="goal"
        defaultOpen
        summary={
          conversation.goal.iterations === 0
            ? t("Not checked yet")
            : conversation.goal.iterations === 1
              ? t("1 turn")
              : formatText("{count} turns", {
                  count: conversation.goal.iterations,
                })
        }
      >
        <div>{conversation.goal.condition}</div>
        <div className="rail-detail">
          {conversation.goal.lastReason
            ? formatText(
                conversation.goal.iterations === 1
                  ? "1 turn · last check: {reason}"
                  : "{count} turns · last check: {reason}",
                {
                  count: conversation.goal.iterations,
                  reason: conversation.goal.lastReason,
                },
              )
            : conversation.goal.iterations === 0
              ? t("Not checked yet")
              : conversation.goal.iterations === 1
                ? t("1 turn")
                : formatText("{count} turns", {
                    count: conversation.goal.iterations,
                  })}
        </div>
        <button
          type="button"
          className="rail-row interactive"
          onClick={() => {
            setEditingGoal(true);
          }}
        >
          {t("Edit goal")}
        </button>
      </RailCard>
    );
  }

  const repositoryName = conversation.repository?.fullName.split("/").at(-1);
  cards.environment = (
    <RailCard
      chrome={chrome}
      id="environment"
      defaultOpen
      summary={
        (cloud ? (branch ?? repositoryName) : (folderName ?? branch)) ??
        undefined
      }
    >
      <RailRow
        icon={cloud ? "Cloud" : "Computer"}
        trailing={
          editCloudEnvironment ? (
            <button
              type="button"
              className="rail-stop rail-folder-add"
              aria-label={t("Edit cloud environment")}
              onClick={editCloudEnvironment}
            >
              <AppIcon name="Settings" size={12} />
            </button>
          ) : sshHost.connection ? (
            <span
              className="rail-detail rail-trailing"
              data-state={
                sshHost.connection === "disconnected" ? "failed" : undefined
              }
            >
              {t(
                sshHost.connection === "connecting"
                  ? "Connecting"
                  : sshHost.connection === "reconnecting"
                    ? "Reconnecting"
                    : sshHost.connection === "disconnected"
                      ? "Disconnected"
                      : "Not connected",
              )}
            </span>
          ) : (
            environmentHint && (
              <span className="rail-detail rail-trailing">
                {environmentHint}
              </span>
            )
          )
        }
      >
        {environmentLabel}
      </RailRow>
      {/* A cloud session's folder is the runner's; it names its repository. */}
      {cloud ? (
        repositoryName && <RailRow icon="Folder">{repositoryName}</RailRow>
      ) : (
        <SessionFolders conversation={conversation} />
      )}
      {(branch !== undefined ||
        status?.state === "ready" ||
        conversation.worktree) && (
        <RailRow icon="GitBranch" title={t("Branch")}>
          {branch ? (
            <BranchChip
              branch={branch}
              tooltip={t("Branch")}
              detail={branch}
              url={
                conversation.repository?.fullName
                  ? branchUrl(conversation.repository.fullName, branch)
                  : undefined
              }
              openLink={(url) => void api.openExternal(url).catch(app.report)}
            />
          ) : (
            "—"
          )}
        </RailRow>
      )}
      {local && (
        <RailRow
          icon="Cursor"
          title={
            remoteAllowed
              ? undefined
              : t(
                  "Turn on Control from your phone in Settings to use Remote Control.",
                )
          }
          trailing={
            <RailSwitch
              label={t("Remote Control")}
              checked={remoteOn}
              disabled={!remoteAllowed}
              onChange={(on) =>
                void import("../remote-control/SessionRemoteControl")
                  .then(({ changeRemoteControl }) =>
                    changeRemoteControl(app, id, on),
                  )
                  .catch(app.report)
              }
            />
          }
        >
          {t("Remote Control")}
        </RailRow>
      )}
    </RailCard>
  );

  cards.settings = (
    <RailCard
      chrome={chrome}
      id="settings"
      defaultOpen
      summary={settingsRows.model}
    >
      <RailRow
        onClick={() => openComposerMenu("model")}
        trailing={
          <span className="rail-detail rail-trailing">
            {settingsRows.model}
          </span>
        }
      >
        {t("Model")}
      </RailRow>
      <RailRow
        onClick={() => openComposerMenu("effort")}
        trailing={
          <span className="rail-detail rail-trailing">
            {t(settingsRows.effort)}
          </span>
        }
      >
        {t("Effort")}
      </RailRow>
      <RailRow
        onClick={() => openComposerMenu("permissions")}
        trailing={
          <span className="rail-detail rail-trailing">
            {t(settingsRows.permissions)}
          </span>
        }
      >
        {t("Permissions")}
      </RailRow>
    </RailCard>
  );

  cards.context = (
    <RailCard
      chrome={chrome}
      id="context"
      defaultOpen={false}
      live
      summary={
        pct === null ? undefined : (
          <span className="rail-context-summary">
            <span className="rail-tabular">{pct}%</span>
            <ContextMeter pct={pct} />
          </span>
        )
      }
    >
      {pct === null || !usage.used ? (
        <div className="rail-context-empty">
          {t("Send a message to see context usage.")}
        </div>
      ) : (
        <div className="rail-context-body">
          <div className="rail-context-row">
            <span className="rail-tabular">
              {formatText("{percent} used", { percent: `${pct}%` })}
            </span>
            <span className="rail-detail rail-tabular">
              {formatText("{used} / {max} ({pct}%)", {
                used: tokens(usage.used),
                max: tokens(usage.window ?? 0),
                pct: String(pct),
              })}
            </span>
          </div>
          <div
            className="rail-context-bar"
            role="progressbar"
            aria-label={t("Context window")}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="rail-context-fill"
              data-severity={severity(pct)}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      {pct !== null && usage.used > 0 && (
        <div className="rail-compact">
          {hint && <span className="rail-compact-hint">{hint}</span>}
          <button
            type="button"
            className="rail-compact-button"
            disabled={!settled}
            title={
              settled
                ? undefined
                : t("Available when Claudex finishes this turn")
            }
            onClick={() =>
              void api.compactConversation(id).then(app.upsert, app.report)
            }
          >
            {t("Compact this session")}
          </button>
        </div>
      )}
    </RailCard>
  );
  fillRailToolCards({
    app,
    cards,
    chrome,
    connectors,
    conversation,
    devServers,
    earlierEntries,
    earlierRefs,
    finished,
    id,
    outputRows,
    outputs,
    pr,
    reconnect,
    ref,
    running,
    setStopping,
    stopping,
    t,
    taskRows,
    weekly,
  });
}

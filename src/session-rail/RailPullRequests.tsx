import { useState } from "react";
import type { Conversation } from "../../shared/types";
import { pullRequestDisplayState } from "../../shared/pull-request-status";
import { type PullRequestRef } from "../../shared/pull-request";
import type { GitHubPullRequest } from "../../shared/github-api";
import { formatText, useT } from "../i18n";
import { api } from "../desktop-api";
import { useApp } from "../app/AppContext";
import { PrStateGlyph } from "../pr/PrStateGlyph";
import { formatWorkflowTokens } from "../../shared/workflow-model";
import { sessionContributions } from "./usage-contributions";
import "./session-rail.css";
import { RailIcon, RailRow } from "./RailParts";

/** What's contributing (this session): subagents and MCP servers, with the original's tips. */
export function UsageContributions({
  conversation,
}: {
  conversation: Conversation;
}) {
  const t = useT();
  const rows = sessionContributions(conversation);
  const subagents = rows.some((row) => row.category === "Subagent");
  const mcp = rows.some((row) => row.category === "MCP");
  return (
    <div className="rail-contributions">
      <h4>{t("What’s contributing (this session)")}</h4>
      {rows.length === 0 ? (
        <p className="rail-detail">
          {t(
            "Nothing attributed in this session yet. Subagent, skill, and MCP activity shows up here as the session runs.",
          )}
        </p>
      ) : (
        <>
          <ul>
            {rows.slice(0, 6).map((row) => (
              <li key={`${row.category}:${row.name}`}>
                <span className="rail-contribution-category">
                  {t(row.category)}
                </span>
                <span className="rail-contribution-name" title={row.name}>
                  {row.name}
                </span>
                <span className="rail-detail rail-tabular">
                  {row.unit === "tokens"
                    ? formatText("{count} tokens", {
                        count: formatWorkflowTokens(row.amount),
                      })
                    : formatText(
                        row.amount === 1 ? "1 call" : "{count} calls",
                        { count: row.amount },
                      )}
                </span>
              </li>
            ))}
          </ul>
          {subagents && (
            <p className="rail-detail">
              <b>{t("Tip")}</b>{" "}
              {t(
                "Each subagent runs its own requests. Consider a cheaper model for simple subagents, or tighten their prompts.",
              )}
            </p>
          )}
          {mcp && (
            <p className="rail-detail">
              <b>{t("Tip")}</b>{" "}
              {t(
                "MCP tool results stay in context for the rest of the session. Compacting clears them, or you can turn off servers you don’t need.",
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}

type RailPullRequest = { ref: PullRequestRef; pr?: GitHubPullRequest };

export function PullRequestRailRow({ entry }: { entry: RailPullRequest }) {
  const app = useApp();
  const state = entry.pr ? pullRequestDisplayState(entry.pr) : "none";
  return (
    <RailRow
      glyph={state !== "none" ? <PrStateGlyph state={state} /> : undefined}
      title={entry.ref.url}
      onClick={() => void api.openExternal(entry.ref.url).catch(app.report)}
    >
      <span className="rail-tabular">#{entry.ref.number}</span>{" "}
      {entry.pr?.title}
    </RailRow>
  );
}

/** "{count} earlier pull requests" and "{count} merged", folded. */
export function EarlierPullRequests({
  entries,
}: {
  entries: RailPullRequest[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const merged = entries.filter((entry) => entry.pr?.state === "merged").length;
  return (
    <div className="rail-earlier">
      <button
        type="button"
        className="rail-row interactive rail-earlier-head"
        aria-expanded={open}
        data-panel-open={open || undefined}
        onClick={() => setOpen(!open)}
      >
        <RailIcon name="CaretRight" className="rail-earlier-caret" />
        <span className="rail-row-label rail-earlier-label">
          {entries.length === 1
            ? t("1 earlier pull request")
            : formatText("{count} earlier pull requests", {
                count: entries.length,
              })}
        </span>
        {merged > 0 && (
          <span className="rail-earlier-merged">
            {formatText("{count} merged", { count: merged })}
          </span>
        )}
      </button>
      {open &&
        entries.map((entry) => (
          <PullRequestRailRow key={entry.ref.url} entry={entry} />
        ))}
    </div>
  );
}

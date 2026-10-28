import { ChevronRight } from "../ui/glyphs";
import { useState } from "react";
import {
  researchFinished,
  turnSourceUrls,
  type ResearchState,
} from "../../shared/research";
import type { Turn } from "../../shared/types";
import { SiteIcon } from "../citations/SiteIcon";
import { sourceHost } from "../citations/citations";
import { formatText, t } from "../i18n";
import { useResearchPanel } from "./useResearchDraft";

/** How many site icons the card stacks. */
const stackedIcons = 3;

export const researchStartingMessages = [
  "Getting everything ready...",
  "Preparing your research assistant...",
  "Initializing research tools...",
  "Setting up my research space...",
  "Configuring research parameters...",
  "Loading research capabilities...",
  "Preparing to dive in...",
  "Setting the stage for discovery...",
  "Getting your assistant ready...",
  "Activating research mode...",
  "Warming up the engines...",
];

/** State copy. */
export function researchCardText(
  research: ResearchState,
  _now = Date.now(),
  startingIndex = 0,
) {
  const count = research.sourceCount;
  const sources =
    count === 1 ? t("1 source") : formatText("{count} sources", { count });
  // Model access is a failed Research subtitle.
  if (research.state === "failed" && research.error === "model_access")
    return {
      title: t("Something went wrong"),
      detail: research.errorModel
        ? formatText(
            "Research requires {model}, which you don’t have access to",
            { model: research.errorModel },
          )
        : t("Research requires a model you don’t have access to"),
    };
  switch (research.state) {
    case "starting":
      return {
        title: t(
          researchStartingMessages[
            startingIndex % researchStartingMessages.length
          ],
        ),
        detail: "",
      };
    case "planning":
      return {
        title: research.title || t("Researching..."),
        detail: t("Creating my research plan..."),
      };
    case "gathering":
      return {
        title: research.title || t("Researching..."),
        detail:
          count === 0
            ? t("Searching for sources...")
            : count === 1
              ? t("1 source and counting...")
              : formatText("{count} sources and counting...", { count }),
      };
    case "writing":
      return {
        title: research.title || t("Researching..."),
        detail: t("Writing and citing report..."),
      };
    case "done":
      return {
        title:
          research.report?.title || research.title || t("Research complete"),
        detail: sources,
      };
    case "interrupted":
      return {
        title: research.title || t("Researching..."),
        detail: t("Interrupted"),
      };
    default:
      return {
        title: t("Something went wrong"),
        detail: research.error ? t("Couldn’t complete research") : "",
      };
  }
}

/** The first distinct sites among a turn's sources, for the stacked icons. */
export function researchHosts(turn: Pick<Turn, "items">, limit = stackedIcons) {
  const hosts: string[] = [];
  for (const url of turnSourceUrls(turn)) {
    const host = sourceHost(url);
    if (host && !hosts.includes(host)) hosts.push(host);
    if (hosts.length >= limit) break;
  }
  return hosts;
}

/**
 * A Research turn in the transcript (design R45 §4.3): the research's title,
 * up to three site icons and the source count. The
 * whole card opens the Research panel.
 */
export function ResearchCard({
  turn,
  research,
  onOpen,
}: {
  turn: Pick<Turn, "items" | "reconnecting"> & Partial<Pick<Turn, "id">>;
  research: ResearchState;
  onOpen?: () => void;
}) {
  const [startingIndex] = useState(() =>
    Math.floor(Math.random() * researchStartingMessages.length),
  );
  const { title, detail: phaseDetail } = researchCardText(
    research,
    Date.now(),
    startingIndex,
  );
  const detail =
    turn.reconnecting && !researchFinished(research)
      ? t("Reconnecting...")
      : phaseDetail;
  const hosts = researchHosts(turn);
  const panel = useResearchPanel();
  const stopped =
    research.state === "failed" || research.state === "interrupted";
  return (
    <button
      type="button"
      className={`research-card research-${research.state}${stopped ? " stopped" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={
        detail
          ? formatText("{title}: {subtitle}. Open research panel.", {
              title,
              subtitle: detail,
            })
          : formatText("{title}. Open research panel.", { title })
      }
      aria-disabled={onOpen ? undefined : true}
      disabled={!onOpen}
      aria-expanded={!!panel && panel.turnId === turn.id}
      onClick={onOpen}
    >
      <span className="research-card-title">
        <span>{title}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </span>
      <span className="research-card-detail">
        {hosts.length > 0 && (
          <span className="research-card-icons" aria-hidden="true">
            {hosts.map((host) => (
              <SiteIcon key={host} host={host} size={18} />
            ))}
          </span>
        )}
        <span>{detail}</span>
      </span>
    </button>
  );
}

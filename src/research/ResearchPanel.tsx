import { ArrowLeft, ChevronDown, X } from "../ui/glyphs";
import { useEffect, useMemo, useRef, useState } from "react";
import { researchFinished, type ResearchState } from "../../shared/research";
import type { Conversation, Turn } from "../../shared/types";
import { SiteIcon } from "../citations/SiteIcon";
import { sourceHost } from "../citations/citations";
import { formatText, t } from "../i18n";
import { Markdown } from "../ui/Markdown";
import { ShimmerText } from "../ui/ShimmerText";
import { researchCardText } from "./ResearchCard";
import { ResearchSources, researchSources } from "./ResearchSources";
import {
  setResearchPanel,
  useTurnResearch,
  type ResearchTarget,
} from "./useResearchDraft";

export function ResearchPanel({
  conversation,
  turn,
  target,
}: {
  conversation: Conversation;
  turn: Turn;
  target: ResearchTarget;
  notify: (message: string) => void;
}) {
  const research = useTurnResearch(conversation, turn);
  const panel = useRef<HTMLElement>(null);
  useEffect(
    () => panel.current?.focus({ preventScroll: true }),
    [turn.id, target.view],
  );
  const sources = useMemo(() => researchSources(turn), [turn]);
  const showSources = target.view === "sources";
  const count = research?.sourceCount ?? sources.length;
  const countTitle =
    research && !researchFinished(research)
      ? count === 1
        ? t("1 source and counting...")
        : formatText("{count} sources and counting...", { count })
      : sourceCountText(count);
  const openSources = () => setResearchPanel({ ...target, view: "sources" });
  return (
    <aside
      className="work-panel research-panel"
      aria-label={t("Research panel")}
      ref={panel}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.stopPropagation();
        setResearchPanel(
          showSources ? { ...target, view: "report" } : undefined,
        );
      }}
    >
      <header>
        <div>
          {showSources && (
            <button
              aria-label={t("Back")}
              onClick={() => setResearchPanel({ ...target, view: "report" })}
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <h2>
            {showSources ? countTitle : research?.title || t("Researching...")}
          </h2>
        </div>
        <button
          aria-label={t("Close")}
          onClick={() => setResearchPanel(undefined)}
        >
          <X size={20} />
        </button>
      </header>
      <div className="research-panel-body">
        {showSources ? (
          <section
            className="research-panel-sources"
            aria-label={t("Research sources")}
          >
            <ResearchSources sources={sources} />
          </section>
        ) : research ? (
          <ResearchProgress
            research={research}
            sources={sources}
            onOpenSources={openSources}
          />
        ) : null}
      </div>
    </aside>
  );
}

export function sourceCountText(count: number) {
  return count === 1 ? t("1 source") : formatText("{count} sources", { count });
}

export function researchSteps(research: ResearchState) {
  const phase = research.state;
  const planning = phase === "starting" || phase === "planning";
  const gathering = phase === "gathering";
  const writing = phase === "writing" || phase === "done";
  const count = research.sourceCount;
  return [
    {
      title: planning
        ? t("Creating my research plan...")
        : t("Research plan created"),
      shown: true,
      expandable: !!research.plan || !!research.questions?.length,
    },
    {
      title: gathering
        ? count === 0
          ? t("Searching for sources...")
          : count === 1
            ? t("Gathering 1 source and counting...")
            : formatText("Gathering {count} sources and counting...", { count })
        : count === 1
          ? t("Gathered 1 source")
          : formatText("Gathered {count} sources", { count }),
      shown:
        !planning &&
        (gathering || writing || count > 0 || (research.searchCount ?? 0) > 0),
      expandable: count > 0,
    },
    {
      title:
        phase === "done"
          ? t("Boom! Research report is ready")
          : t("Writing and citing report..."),
      shown: writing,
      expandable: false,
    },
  ];
}

export function ResearchProgress({
  research,
  sources,
  onOpenSources,
}: {
  research: ResearchState;
  sources: ReturnType<typeof researchSources>;
  onOpenSources: () => void;
}) {
  const steps = researchSteps(research);
  const active = steps.reduce(
    (latest, step, index) => (step.shown ? index : latest),
    -1,
  );
  const latestExpandable = steps.reduce(
    (latest, step, index) => (step.shown && step.expandable ? index : latest),
    -1,
  );
  const [expanded, setExpanded] = useState(latestExpandable);
  useEffect(() => setExpanded(latestExpandable), [latestExpandable]);
  const stopped =
    research.state === "failed" || research.state === "interrupted";
  const collapsible = steps.filter((step) => step.expandable).length > 1;
  const hosts = [
    ...new Set(
      sources
        .map((source) => sourceHost(source.url))
        .filter((host): host is string => !!host),
    ),
  ].slice(0, 3);
  const error = researchCardText(research);
  return (
    <ol className="research-progress" role="list">
      {steps.map(
        (step, index) =>
          step.shown && (
            <li
              key={index}
              className={`research-step${researchFinished(research) || index < active ? " complete" : ""}${expanded === index && step.expandable ? " expanded" : ""}`}
            >
              <span className="research-step-track" aria-hidden="true">
                <span />
              </span>
              <div className="research-step-content">
                <h4>
                  <button
                    disabled={
                      !step.expandable || (expanded === index && !collapsible)
                    }
                    aria-expanded={
                      step.expandable ? expanded === index : undefined
                    }
                    onClick={() =>
                      setExpanded(
                        expanded === index ? Number(index === 0) : index,
                      )
                    }
                  >
                    {researchFinished(research) || index < active ? (
                      <span>{step.title}</span>
                    ) : (
                      <ShimmerText>{step.title}</ShimmerText>
                    )}
                    {step.expandable && collapsible && (
                      <ChevronDown
                        size={12}
                        className={expanded === index ? "" : "collapsed"}
                      />
                    )}
                  </button>
                  {index === 1 && expanded !== index && (
                    <span className="research-card-icons" aria-hidden="true">
                      {hosts.map((host) => (
                        <SiteIcon key={host} host={host} size={16} />
                      ))}
                    </span>
                  )}
                </h4>
                {expanded === index &&
                  step.expandable &&
                  (index === 0 ? (
                    <div className="research-step-detail markdown">
                      <Markdown
                        text={research.plan || research.questions!.join("\n\n")}
                      />
                    </div>
                  ) : (
                    <div className="research-step-detail">
                      <button
                        className="research-source-count"
                        onClick={onOpenSources}
                      >
                        {sourceCountText(research.sourceCount)}
                      </button>
                      <ResearchSources sources={sources} />
                    </div>
                  ))}
              </div>
            </li>
          ),
      )}
      {stopped && (
        <li className="research-step error">
          <span className="research-step-track" aria-hidden="true">
            <span />
          </span>
          <h4 role="status">
            {research.state === "interrupted"
              ? t("Interrupted")
              : error.detail || error.title}
          </h4>
        </li>
      )}
    </ol>
  );
}

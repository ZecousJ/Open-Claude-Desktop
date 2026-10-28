import { Suspense, useContext, type ReactNode } from "react";
import {
  FileText,
  Globe,
  Image as ImageIcon,
  Lightbulb,
  SquareTerminal,
} from "../../ui/glyphs";
import type { Item } from "../../../shared/types";
import { itemIsRunning, turnActivity } from "../../../shared/activity";
import type { StepsGroupProps } from "../../transcript/transcript-slots";
import { isChatStep } from "../../transcript/ChatSteps";
import { stepLine } from "../../transcript/chat-step-lines";
import { thoughtSeconds } from "../../transcript/CodeTurnStatus";
import { thoughtLabel } from "../../transcript/thought-label";
import { failed } from "../../code-tools/code-tool-model";
import { searchSources } from "../../transcript/tools/WebSearchView";
import { sourceHost } from "../../citations/citations";
import { SiteIcon } from "../../citations/SiteIcon";
import { FileChangeCards } from "../../transcript/tools/FileChangeView";
import { generatedArtifact } from "../../artifacts/generatedArtifact";
import { generatedImageArtifact } from "../../transcript/tools/SessionToolView";
import { useConversationServices } from "../../conversation/ConversationServices";
import { AppContext } from "../../app/AppContext";
import { Markdown } from "../../ui/components";
import { AppIcon } from "../../ui/app-icon";
import { lazyPiece } from "../../ui/lazy-piece";
import { t, tf, useT } from "../../i18n";
import { OfficialSheet, useSheetStack, type SheetPage } from "./OfficialSheet";
import { SourcesList } from "./SourcesList";
import { stepContent, toolTitle } from "./step-content";
import { ThinkingVerb } from "./ThinkingVerb";

const GeneratedImageCard = lazyPiece(
  () => import("../../artifacts/GeneratedImageCard"),
);

const TOOL_TYPES = ["mcpToolCall", "dynamicToolCall"];
const baseName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

type IconKind = "tool" | "command" | "file" | "image" | "thought" | string;

/** The kind of icon a step shows; a web step shows its site. */
function iconKind(item: Item): IconKind {
  if (TOOL_TYPES.includes(item.type)) return "tool";
  if (item.type === "commandExecution") return "command";
  if (item.type === "fileChange") return "file";
  if (item.type === "imageView" || item.type === "imageGeneration")
    return "image";
  if (item.type === "webSearch") {
    const action = item.action as { url?: string } | undefined;
    const url = action?.url ?? searchSources(item)[0]?.url;
    const host = url ? sourceHost(url) : undefined;
    return host ? `site:${host}` : "web";
  }
  return "thought";
}

function StepIcon({ kind }: { kind: IconKind }) {
  if (kind.startsWith("site:"))
    return <SiteIcon host={kind.slice(5)} size={20} />;
  switch (kind) {
    case "tool":
      return <AppIcon name="Tool" />;
    case "command":
      return <SquareTerminal size={20} strokeWidth={1.5} />;
    case "file":
      return <FileText size={20} strokeWidth={1.5} />;
    case "image":
      return <ImageIcon size={20} strokeWidth={1.5} />;
    case "web":
      return <Globe size={20} strokeWidth={1.5} />;
    default:
      return <Lightbulb size={20} strokeWidth={1.5} />;
  }
}

/**
 * The steps row's leading stack of the tools used: at most three distinct ones,
 * each a 20 dp circle overlapping the last by 8 dp with a 2 dp ring, as the
 * reply row's sources stack draws its favicons. Thoughts add no icon.
 */
function IconStack({ items }: { items: Item[] }) {
  const kinds = [
    ...new Set(items.map(iconKind).filter((kind) => kind !== "thought")),
  ].slice(0, 3);
  if (!kinds.length) return null;
  return (
    <span className="official-icon-stack" aria-hidden="true">
      {kinds.map((kind) => (
        <span className="official-icon-stack-item" key={kind}>
          <StepIcon kind={kind} />
        </span>
      ))}
    </span>
  );
}

/** A finished step's status mark in the sheet. */
function stepMark(item: Item, live: boolean) {
  if (live && itemIsRunning(item)) return "running";
  if (item.lifecycleStatus === "interrupted") return t("Step stopped");
  if (failed(item)) return t("Step failed");
  return undefined;
}

/** The Request / Response page of a step. */
function ToolContentPage({ item }: { item: Item }) {
  useT();
  const content = stepContent(item);
  const nothing =
    !content.request && !content.response.length && !content.error;
  return (
    <div className="official-tool-content">
      {content.request && (
        <section>
          <h3>{t("Request")}</h3>
          <pre>{content.request}</pre>
        </section>
      )}
      {(content.response.length > 0 || content.error) && (
        <section>
          <h3>{t("Response")}</h3>
          {content.error && <pre data-error>{content.error}</pre>}
          {content.response.map((entry, index) =>
            entry.type === "image" ? (
              <img key={index} src={entry.url} alt="" />
            ) : entry.type === "text" ? (
              <pre key={index}>{entry.text}</pre>
            ) : (
              <p key={index}>{entry.label}</p>
            ),
          )}
        </section>
      )}
      {nothing && content.failed && (
        <section>
          <h3>{t("Failed")}</h3>
          <p>{t("No details were returned.")}</p>
        </section>
      )}
      {nothing && !content.failed && (
        <p className="official-tool-empty">
          {content.running ? t("Waiting for tool output…") : t("No output")}
        </p>
      )}
    </div>
  );
}

/**
 * Chat's steps group as the official app draws it: one collapsed row, 20 dp in,
 * 8 × 12 dp padding, the stack of tools used, then "N steps" (or a lone step's
 * own words, or "Thought for 12s"), 15 sp tertiary, one line, and the 16 dp
 * caret. While the reply works the label is the thinking verb, changing every 8
 * s with the 1.5 s shimmer, or the running step's words. A tap opens the
 * Collapsed Tools sheet at its Summary page; a step opens its Thinking,
 * ToolContent or Sources page. Pages the steps wrote follow as their cards, as
 * on the web.
 */
export function OfficialStepsRow({
  items,
  turn,
  active,
  awaitingApproval,
  onArtifact,
}: StepsGroupProps) {
  useT();
  const app = useContext(AppContext);
  const services = useConversationServices();
  const sheet = useSheetStack();
  const phase = active ? turnActivity(turn, awaitingApproval) : "idle";
  const running = !["idle", "streaming"].includes(phase);
  const live = turn.status === "inProgress";
  const normalized = items.map((item) =>
    turn.status !== "inProgress" && itemIsRunning(item)
      ? { ...item, lifecycleStatus: turn.status }
      : item,
  );
  const steps = normalized.filter(isChatStep);
  const changes = normalized.filter((item) => item.type === "fileChange");
  const made = normalized.filter(
    (item) =>
      item.type === "imageGeneration" &&
      item.status !== "failed" &&
      typeof item.savedPath === "string" &&
      item.savedPath,
  );
  const seconds = thoughtSeconds(normalized);
  const current = normalized.filter(itemIsRunning).at(-1);
  if (!running && !steps.length && !seconds) return null;

  const openImage = (item: Item) => {
    const path =
      item.type === "imageView" ? item.path : (item.savedPath as unknown);
    if (typeof path !== "string") return false;
    const conversationId = app?.activeId ?? services.conversationId;
    const snapshot =
      item.type === "imageView"
        ? conversationId
          ? services.viewedImageSnapshot(conversationId, path)
          : Promise.resolve(null)
        : services.imageGenerationSnapshot(path);
    snapshot
      .then((value) => {
        if (value)
          onArtifact(generatedImageArtifact(value, path, baseName(path)));
      })
      .catch(app?.report ?? (() => {}));
    return true;
  };
  /** The page a step opens, or undefined when it acts directly or has none. */
  const stepPage = (item: Item): SheetPage | undefined => {
    const line = stepLine(item);
    if (item.type === "reasoning")
      return {
        key: item.id,
        title: t("Thought process"),
        body: () => (
          <div className="official-thought">
            <Markdown text={item.summary?.join("\n\n") ?? ""} />
          </div>
        ),
      };
    if (item.type === "webSearch") {
      const sources = searchSources(item);
      if (!sources.length) return undefined;
      return {
        key: item.id,
        title: t("Sources"),
        body: () => <SourcesList sources={sources} />,
      };
    }
    if (item.type === "imageView" || item.type === "imageGeneration")
      return undefined;
    return {
      key: item.id,
      title: toolTitle(item, t(line.text)),
      body: () => <ToolContentPage item={item} />,
    };
  };
  const pageArtifact = (item: Item) => {
    if (item.type !== "fileChange") return undefined;
    const document = (item.generatedFiles ?? []).find(
      (file) =>
        file.state === "ready" && ["html", "svg"].includes(file.language),
    );
    return document && generatedArtifact(document);
  };
  const summary: SheetPage = {
    key: "summary",
    title: t("Summary"),
    body: () => (
      <ul className="official-step-list">
        {steps.map((item) => {
          const line = stepLine(item);
          const mark = stepMark(item, live);
          const artifact = pageArtifact(item);
          const image =
            item.type === "imageView" || item.type === "imageGeneration";
          const page = artifact || image ? undefined : stepPage(item);
          const action = artifact
            ? () => {
                sheet.close();
                onArtifact(artifact);
              }
            : image
              ? () => {
                  sheet.close();
                  openImage(item);
                }
              : page
                ? () => sheet.push(item.id)
                : undefined;
          const content: ReactNode = (
            <>
              <span className="official-step-icon">
                <StepIcon kind={iconKind(item)} />
              </span>
              <span className="official-step-text">
                {t(line.text)}
                {line.name && (
                  <span className="official-step-name"> {line.name}</span>
                )}
              </span>
              {mark === "running" ? (
                <span className="official-step-mark" data-running>
                  <span className="quiet-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
              ) : mark ? (
                <span className="official-step-mark">{mark}</span>
              ) : action ? (
                <span className="official-step-caret" aria-hidden="true">
                  <AppIcon name="CaretRight" />
                </span>
              ) : null}
            </>
          );
          return (
            <li key={item.id}>
              {action ? (
                <button
                  type="button"
                  className="official-step"
                  onClick={action}
                >
                  {content}
                </button>
              ) : (
                <div className="official-step">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    ),
  };
  // One thought alone opens straight to its text.
  const lone = steps.length === 1 ? steps[0] : undefined;
  const onlyThought = lone?.type === "reasoning";
  const openable = steps.length > 0;
  const finished = !steps.length
    ? seconds
      ? thoughtLabel(seconds)
      : t("Thought process")
    : onlyThought
      ? seconds
        ? thoughtLabel(seconds)
        : t("Thought process")
      : lone
        ? [t(stepLine(lone).text), stepLine(lone).name]
            .filter(Boolean)
            .join(" ")
        : tf("{n} steps", { n: steps.length });
  const runningStep =
    running &&
    phase !== "approval" &&
    current &&
    current.type !== "reasoning" &&
    isChatStep(current)
      ? t(stepLine(current).text)
      : undefined;
  const label =
    phase === "approval" ? (
      <span className="official-steps-label">
        {t("Waiting for your response")}
      </span>
    ) : running ? (
      runningStep ? (
        <span className="official-steps-label official-shimmer">
          {runningStep}
        </span>
      ) : (
        <ThinkingVerb />
      )
    ) : (
      <span className="official-steps-label">{finished}</span>
    );
  return (
    <>
      <div className="official-steps" data-running={running || undefined}>
        <button
          type="button"
          className="official-steps-row"
          disabled={!openable}
          aria-haspopup={openable ? "dialog" : undefined}
          title={openable ? t("Show steps") : undefined}
          onClick={() => {
            if (!openable) return;
            sheet.open(onlyThought ? lone!.id : summary.key);
          }}
        >
          <IconStack items={steps} />
          {label}
          {openable && (
            <span className="official-steps-caret" aria-hidden="true">
              <AppIcon name="CaretRight" />
            </span>
          )}
        </button>
      </div>
      <OfficialSheet
        pages={sheet.pages.flatMap((key) => {
          if (key === summary.key) return [summary];
          const item = steps.find((step) => step.id === key);
          const page = item && stepPage(item);
          return page ? [page] : [];
        })}
        onBack={sheet.back}
        onClose={sheet.close}
      />
      {changes.length > 0 && !running && (
        <div className="chat-steps-files">
          <FileChangeCards items={changes} onArtifact={onArtifact} />
        </div>
      )}
      {made.length > 0 && !running && (
        <div className="chat-steps-files">
          <Suspense fallback={null}>
            {made.map((item) => (
              <GeneratedImageCard
                key={item.id}
                savedPath={item.savedPath as string}
                platform={app?.snapshot.platform}
                onArtifact={onArtifact}
                onError={app?.report}
                onNotify={app?.notify}
              />
            ))}
          </Suspense>
        </div>
      )}
    </>
  );
}

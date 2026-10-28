import { Suspense, useContext, useEffect, useState } from "react";
import { Laptop, Check, ChevronDown, ChevronRight } from "../ui/glyphs";
import type { Conversation } from "../../shared/types";
import { latestGeneratedFiles } from "../../shared/generated-files";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import { latestPlan } from "../plan/PlanPanel";
import type { Artifact } from "../ui/ArtifactTypes";
import { AppContext } from "../app/AppContext";
import { formatText } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { contextResources, type ContextResource } from "./context-resources";
import { useCoworkFolders } from "./task-folders";
import { useConversationServices } from "../conversation/ConversationServices";
import { preference } from "../../shared/settings-extras";
import { ComputerUseActivity } from "./ComputerUseActivity";
import { coworkComputerWaiting } from "../../shared/remote-devices";
import "./folder-instructions.css";
import { useProgressPanelState } from "./useProgressPanelState";
import { linkFailureMessage } from "./link-to-computer";

export { relativePath } from "../ui/relative-path";
import { Section, ContextPlaceholder } from "./ProgressSections";

const CoworkFileBrowser = lazyPiece(() => import("./CoworkFileBrowser"));
const CoworkResourceDetails = lazyPiece(
  () => import("./CoworkFileBrowser"),
  "CoworkResourceDetails",
);
const SuggestedConnectors = lazyPiece(() => import("./SuggestedConnectors"));
const FolderInstructions = lazyPiece(
  () => import("./FolderInstructions"),
  "FolderInstructions",
);

/**
 * An output's row name as the original writes it: the file name without its
 * extension, dashes and underscores as spaces, and the extension in capitals
 * after it.
 */
export function outputLabel(filename: string) {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return {
    name: stem.replace(/[-_]+/g, " ").trim() || filename,
    kind: dot > 0 ? filename.slice(dot + 1).toUpperCase() : "",
  };
}

/**
 * The collapsed Progress heading's count; nothing while the task is still
 * going.
 */
export function planDoneCount(plan: { status: string }[]) {
  return plan.length > 0 && plan.every((step) => step.status === "completed")
    ? plan.length
    : undefined;
}

/**
 * The empty Progress picture: two done rings and an open one, joined by dashes.
 */
function ProgressPlaceholder() {
  return (
    <div className="progress-placeholder" aria-hidden="true">
      <i data-status="completed">
        <Check size={14} strokeWidth={1.6} />
      </i>
      <i data-status="completed">
        <Check size={14} strokeWidth={1.6} />
      </i>
      <i />
    </div>
  );
}

/**
 * The empty Outputs picture: a sheet with three upright bars over a rule, shown
 * where the task has no folder yet.
 */
function ArtifactsPlaceholder() {
  return (
    <svg
      className="progress-artifacts-picture"
      width="63"
      height="43"
      viewBox="0 0 63 43"
      fill="none"
      aria-hidden="true"
    >
      <rect x="4.5" y="2.5" width="54" height="34" rx="5.5" className="sheet" />
      <rect x="21" y="13" width="5" height="13" rx="1" className="bar" />
      <rect x="29" y="11" width="5" height="15" rx="1" className="bar" />
      <rect x="37" y="9" width="5" height="17" rx="1" className="bar" />
      <rect x="18" y="28" width="27" height="1" rx="0.5" className="rule" />
    </svg>
  );
}

/** A folder path's last part, for its row. */
const folderLabel = (folder: string) =>
  folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/** The folder an output lives in: the deepest one holding it, else the first. */
export function folderOf(folders: string[], sourcePath: string | undefined) {
  let best = 0;
  let length = -1;
  folders.forEach((folder, index) => {
    const root = folder.replace(/[\\/]+$/, "");
    if (
      sourcePath !== undefined &&
      root.length > length &&
      (sourcePath.startsWith(`${root}/`) || sourcePath.startsWith(`${root}\\`))
    ) {
      best = index;
      length = root.length;
    }
  });
  return best;
}

/**
 * Cowork's Activity panel: a card in the window's top right corner, as tall as
 * its content, with Progress (the task's steps, Codex's turn/plan/updated), the
 * working folder with the files the task produced, and Context (the connectors
 * it used). Each part shows only what the conversation really has. One folder
 * is a section of its own named for it; several share one "Working folders"
 * section with a collapsible group each.
 */
export function ProgressPanel({
  conversation,
  onArtifact,
  embedded = false,
}: {
  conversation: Conversation;
  onArtifact: (artifact: Artifact) => void;
  embedded?: boolean;
}) {
  const plan = latestPlan(conversation) ?? [];
  const doneCount = planDoneCount(plan);
  const generated = [
    ...latestGeneratedFiles(conversation.turns).values(),
  ].filter((file) => file.state !== "deleted");
  const unavailable = new Set(
    generated.filter((file) => !generatedArtifact(file)).map((file) => file.id),
  );
  const outputs: Artifact[] = generated.map(
    (file) =>
      generatedArtifact(file) ?? {
        id: file.id,
        name: file.name,
        filename: file.name,
        sourcePath: file.path,
        language: file.language,
        content: "",
      },
  );
  const folder = conversation.cwd;
  // Outputs the running turn produced that were not opened yet: the folder
  // opens by itself once per turn and marks them.
  const app = useContext(AppContext);
  const services = useConversationServices();
  const [downloading, setDownloading] = useState(false);
  const [browserFolder, setBrowserFolder] = useState<number>();
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [selectedResource, setSelectedResource] = useState<ContextResource>();
  const [linking, setLinking] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string>();
  const [linkAfterStep, setLinkAfterStep] = useState(false);
  const computerAccess = preference(
    app?.snapshot?.settings ?? {},
    "computerAccess",
  );
  const cloudTask = conversation.environment?.kind === "space";
  const canLink =
    cloudTask &&
    !conversation.linkedToComputer &&
    app?.host?.kind !== "web" &&
    typeof window !== "undefined" &&
    Boolean(window.desktop?.linkCoworkTaskToComputer);
  const busy = conversation.turns.some((turn) => turn.status === "inProgress");
  const link = async () => {
    setLinking(true);
    try {
      await window.desktop.linkCoworkTaskToComputer(conversation.id);
      setLinkNotice("Linked to this computer.");
      app?.notify("Linked to this computer.");
    } catch (error) {
      setLinkNotice(linkFailureMessage(error));
    } finally {
      setLinking(false);
    }
  };
  useEffect(() => {
    if (!linkAfterStep || busy) return;
    setLinkAfterStep(false);
    void link();
  }, [linkAfterStep, busy]);
  const presentation = app?.artifactPresentation.current;
  // The task's working folder and the folders added to it (R11-D); loaded
  // on this device and the runner; revealing remains local-only.
  const taskFolders = useCoworkFolders(conversation, true);
  const folders = folder
    ? [...new Set([folder, ...(taskFolders?.extra ?? [])])]
    : [];
  const several = folders.length > 1;
  const { resources, scratchpad } = contextResources(conversation, folders);
  const local =
    app?.host?.kind !== "web" &&
    conversation.environment?.kind !== "ssh" &&
    (!cloudTask || Boolean(conversation.linkedToComputer));
  const fresh = presentation?.newOutputs(conversation);
  // The section holding the folder rows: the folder's own, or the shared one.
  const folderKey = several ? "folders" : `folder:${folder}`;
  const {
    Root,
    open,
    toggle,
    downloadAll,
    outputList,
    emptyOutputs,
    folderActions,
    instructionsRow,
    setOpen,
    byFolder,
    resourceList,
  } = useProgressPanelState({
    app,
    conversation,
    downloading,
    embedded,
    folder,
    folderKey,
    folders,
    fresh,
    local,
    onArtifact,
    outputs,
    presentation,
    services,
    setBrowserFolder,
    setDownloading,
    setInstructionsOpen,
    setSelectedResource,
    taskFolders,
    unavailable,
  });
  return (
    <Root
      className="work-panel progress-panel"
      aria-label="Session activity panel"
      role={embedded ? "region" : undefined}
    >
      <ComputerUseActivity key={conversation.id} conversation={conversation} />
      {(!cloudTask || conversation.linkedToComputer) && (
        <div className="cowork-computer-state">
          <button
            className="cowork-computer-chip"
            title="View your devices"
            onClick={() => app?.openSettingsTab("cowork")}
          >
            <Laptop size={12} />
            {cloudTask && coworkComputerWaiting(conversation)
              ? "Waiting for your computer"
              : cloudTask && conversation.linkedComputerName
                ? formatText("Requires {name}", {
                    name: conversation.linkedComputerName,
                  })
                : !computerAccess
                  ? "Waiting for your computer"
                  : "Requires your computer"}
          </button>
          {!(cloudTask
            ? conversation.linkedComputerAccess
            : computerAccess) && (
            <p>
              Computer access is off, so tasks that require a computer won’t
              run.
            </p>
          )}
          {!(cloudTask ? conversation.linkedComputerAccess : computerAccess) &&
            conversation.scheduledTaskId && (
              <p>This task will run on schedule once Computer access is on.</p>
            )}
        </div>
      )}
      {canLink && (
        <div className="cowork-computer-state">
          <button
            disabled={linking || linkAfterStep}
            onClick={() => {
              if (busy) {
                setLinkAfterStep(true);
                setLinkNotice(
                  "This task is in the middle of a step and will switch to this computer when the step finishes.",
                );
                return;
              }
              void link();
            }}
          >
            {linkAfterStep
              ? "Will link after this step"
              : "Link to this computer"}
          </button>
        </div>
      )}
      {linkNotice && (
        <p className="cowork-computer-state" role="status">
          {linkNotice}
        </p>
      )}
      <Section
        title="Progress"
        open={open.progress}
        onToggle={() => toggle("progress")}
        after={
          doneCount !== undefined && !open.progress
            ? formatText("{done} of {total}", {
                done: doneCount,
                total: plan.length,
              })
            : undefined
        }
      >
        {plan.length > 0 ? (
          <ol className="progress-steps" aria-label="Task steps">
            {plan.map((step, index) => (
              <li key={index} data-status={step.status}>
                <i aria-hidden="true">
                  {step.status === "completed" ? (
                    <Check size={13} strokeWidth={2} />
                  ) : (
                    index + 1
                  )}
                </i>
                <span>
                  {step.step}
                  <span className="sr-only">
                    {step.status === "completed"
                      ? " (done)"
                      : step.status === "inProgress"
                        ? " (in progress)"
                        : ""}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <>
            <ProgressPlaceholder />
            <p className="progress-muted">
              Progress on longer tasks appears here.
            </p>
          </>
        )}
      </Section>
      {folders.length === 0 && (
        <Section
          title="Outputs"
          action={downloadAll(outputs)}
          open={Boolean(open.outputs)}
          onToggle={() => toggle("outputs")}
        >
          {outputs.length > 0 ? (
            outputList(outputs)
          ) : (
            <>
              <ArtifactsPlaceholder />
              {emptyOutputs}
            </>
          )}
        </Section>
      )}
      {folders.length === 1 && (
        <Section
          title={<span data-no-translate>{folderLabel(folders[0])}</span>}
          open={Boolean(open[folderKey])}
          onToggle={() => toggle(folderKey)}
          action={folderActions(0, outputs)}
        >
          {instructionsRow}
          {outputs.length > 0 ? outputList(outputs) : emptyOutputs}
        </Section>
      )}
      {several && (
        <Section
          title="Working folders"
          open={Boolean(open.folders)}
          onToggle={() => toggle("folders")}
        >
          {folders.map((path, index) => {
            const key = `folder:${path}`;
            // A group is open unless it was closed.
            const shown = open[key] !== false;
            return (
              <div className="progress-folder" key={path}>
                <div className="progress-folder-header">
                  <button
                    className="progress-folder-toggle"
                    aria-expanded={shown}
                    onClick={() =>
                      setOpen((current) => ({ ...current, [key]: !shown }))
                    }
                  >
                    {shown ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                    <span data-no-translate>{folderLabel(path)}</span>
                  </button>
                  {folderActions(index, byFolder[index])}
                </div>
                {/* A group with no files is its heading alone. */}
                {shown && index === 0 && instructionsRow}
                {shown &&
                  byFolder[index].length > 0 &&
                  outputList(byFolder[index])}
              </div>
            );
          })}
        </Section>
      )}
      <Section
        title="Context"
        open={open.context}
        onToggle={() => toggle("context")}
      >
        {resources.length > 0 ? (
          resourceList(resources)
        ) : (
          <>
            <ContextPlaceholder />
            <p className="progress-muted">
              Track tools and referenced files used in this task.
            </p>
            {/* Under an empty Context, inside its padding. */}
            <Suspense fallback={null}>
              <SuggestedConnectors />
            </Suspense>
          </>
        )}
      </Section>
      {scratchpad.length > 0 && (
        <Section
          title="Scratchpad"
          open={open.scratchpad !== false}
          onToggle={() =>
            setOpen((previous) => ({
              ...previous,
              scratchpad: previous.scratchpad === false,
            }))
          }
        >
          {resourceList(scratchpad)}
        </Section>
      )}
      {browserFolder !== undefined && (
        <Suspense fallback={null}>
          <CoworkFileBrowser
            conversationId={conversation.id}
            folders={folders}
            initialFolder={browserFolder}
            local={local}
            onClose={() => setBrowserFolder(undefined)}
          />
        </Suspense>
      )}
      {selectedResource && (
        <Suspense fallback={null}>
          <CoworkResourceDetails
            key={selectedResource.id}
            conversationId={conversation.id}
            resource={selectedResource}
            onClose={() => setSelectedResource(undefined)}
          />
        </Suspense>
      )}
      {instructionsOpen && (
        <Suspense fallback={null}>
          <FolderInstructions
            conversationId={conversation.id}
            onClose={() => setInstructionsOpen(false)}
          />
        </Suspense>
      )}
    </Root>
  );
}

/** The connectors a task used: web search and each MCP server, in order. */
export function usedConnectors(conversation: Conversation) {
  const names: string[] = [];
  for (const turn of conversation.turns)
    for (const item of turn.items) {
      const name =
        item.type === "webSearch"
          ? "Web search"
          : item.type === "mcpToolCall" && item.server
            ? String(item.server)
            : undefined;
      if (name && !names.includes(name)) names.push(name);
    }
  return names;
}

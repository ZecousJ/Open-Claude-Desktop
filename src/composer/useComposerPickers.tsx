import { IconButton } from "../ui/Controls";
import { codeLiveLayout } from "./code-live-layout";
import { AppIcon } from "../ui/app-icon";
import { surface } from "../../shared/host";
import { Plus } from "../ui/glyphs";
import { MenuSheetScrim } from "./MenuSheetScrim";
import { Suspense, useEffect } from "react";
import { CodeAddMenu, bashRefusal, CodeModelMenu, ModelMenu } from "./Composer";
import { ChipPresence } from "./ChipPresence";
import { ResearchChip } from "../research/ResearchChip";
import { useTooltip } from "../ui/Tooltip";
import { CodeModelTrigger } from "./CodeModelTrigger";
import { t } from "../i18n";
import { modelTriggerLabel } from "./model-trigger-label";
import { ModelName } from "./model/ModelName";
import { chatEffortLabels } from "../../shared/chat-effort";
import { retiredModelNotice } from "./retired-model";
import { modelLabel } from "./model/code-model-choices";
import { CodeEffortSlider } from "./code/CodeEffortSlider";
import { codeEffortsFor } from "./code/code-effort-support";
import { useTurnStopping } from "../transcript/turn-stopping";
import { Spinner } from "../ui/Spinner";
import type {
  Conversation,
  Attachment,
  Mode,
  Project,
  Settings,
} from "../../shared/types";
import type { AppController } from "../app/AppContext";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { ComposerField } from "./composer-field";
import type { HostInfo } from "../../shared/host";
import type { PendingAttachment } from "./Attachments";
import type { RetiredModel } from "./retired-model";
import type { ReviewComment } from "../changes/review-comments";
import type { SkillToken } from "./skill-tokens";
import { ComposerAddPicker } from "./ComposerAddPicker";
import {
  chooseSessionFolders,
  sessionFoldersChoosable,
} from "../session-rail/session-folders";

/** What useComposerPickers needs from useComposerControls.tsx. */
export interface UseComposerPickersKit {
  active: Conversation | undefined;
  addMenu: boolean;
  appContext: AppController | undefined;
  attachments: Attachment[];
  bash: boolean;
  catalog: ModelCatalog | null;
  catalogRead: {
    retry: () => void;
    status: "pending" | "ready" | "error";
    value: ModelCatalog | null | undefined;
  };
  chooseFiles: () => void;
  codeHomeDraft: boolean;
  composer: React.RefObject<ComposerField | null>;
  dictation: {
    live: boolean;
    onLive(spoken: string): void;
    onTranscript(spoken: string): void;
    onCancel(): void;
  };
  effortOpenRequest: number;
  extendedThinking: boolean;
  host: HostInfo;
  inCloud: boolean;
  incognito: boolean;
  incognitoControls: boolean;
  interrupt: () => Promise<void>;
  mode: Mode;
  model: string;
  modelMenu: boolean;
  notify: (message: string) => void;
  onCreateProject: (name?: string | undefined) => void;
  onProject: (id: string | null) => void;
  onResearch: (() => void) | undefined;
  onWebSearch: () => void;
  openModelService: () => void;
  openSettingsTab: (tab: string) => void;
  openSkillsSettings: (view: "yours" | "discover") => void;
  pending: PendingAttachment[];
  pendingSlash: string | null;
  pickFolder: () => Promise<void>;
  platform: NodeJS.Platform;
  project: Project | undefined;
  projects: Project[];
  providerId: string;
  report: (error: unknown) => void;
  research: boolean;
  researchAvailable: boolean;
  researchUnavailableReason: string | undefined;
  retired: RetiredModel | undefined;
  reviewNotes: ReviewComment[];
  running: boolean;
  selectModel: (id: string, name: string) => void;
  sending: boolean;
  setAddMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setEffortOpenRequest: React.Dispatch<React.SetStateAction<number>>;
  setGithubOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIssuesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setLinearIssuesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setModelMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingSlash: React.Dispatch<React.SetStateAction<string | null>>;
  setSkillTokens: ((tokens: SkillToken[]) => void) | undefined;
  setSlashDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashSelected: React.Dispatch<React.SetStateAction<number>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  settings: Settings;
  skillRanges: SkillToken[];
  text: string;
  thinkingMode: "standard" | "extended";
  toggleThinking: (() => Promise<void>) | undefined;
  unifiedChat: boolean;
  updatePreference: (patch: Partial<Settings>) => Promise<void>;
  webChat: boolean;
  webSearch: boolean;
  webSearchAvailable: boolean;
}

export function useComposerPickers(kit: UseComposerPickersKit) {
  const {
    active,
    addMenu,
    appContext,
    attachments,
    bash,
    catalog,
    catalogRead,
    chooseFiles,
    codeHomeDraft,
    composer,
    dictation,
    effortOpenRequest,
    extendedThinking,
    host,
    inCloud,
    incognito,
    incognitoControls,
    interrupt,
    mode,
    model,
    modelMenu,
    notify,
    onCreateProject,
    onProject,
    onResearch,
    onWebSearch,
    openModelService,
    openSettingsTab,
    openSkillsSettings,
    pending,
    pendingSlash,
    pickFolder,
    platform,
    project,
    projects,
    providerId,
    report,
    research,
    researchAvailable,
    researchUnavailableReason,
    retired,
    reviewNotes,
    running,
    selectModel,
    sending,
    setAddMenu,
    setEffortOpenRequest,
    setGithubOpen,
    setIssuesOpen,
    setLinearIssuesOpen,
    setModelMenu,
    setPendingSlash,
    setSkillTokens,
    setSlashDismissed,
    setSlashSelected,
    setText,
    settings,
    skillRanges,
    text,
    thinkingMode,
    toggleThinking,
    unifiedChat,
    updatePreference,
    webChat,
    webSearch,
    webSearchAvailable,
  } = kit;
  const attachmentPicker = (
    <div className="popover-anchor">
      <IconButton
        label={mode === "code" ? "Add" : "Add files, connectors, and more"}
        className={mode === "code" ? undefined : "composer-add-trigger"}
        active={addMenu}
        menu
        expanded={addMenu}
        shortcut={mode === "code" ? undefined : ["/"]}
        placement={mode === "code" ? "above" : "below"}
        onClick={() => {
          setAddMenu(!addMenu);
          setModelMenu(false);
        }}
      >
        {mode !== "code" ? (
          <AppIcon name="ComposerAdd" />
        ) : surface === "web" ? (
          <AppIcon name="Plus" />
        ) : (
          <Plus size={17} />
        )}
      </IconButton>
      {addMenu && <MenuSheetScrim onClose={() => setAddMenu(false)} />}
      <Suspense fallback={null}>
        {addMenu &&
          (mode === "code" ? (
            <CodeAddMenu
              platform={platform}
              canAddFolder={!active || sessionFoldersChoosable(active)}
              connectors={settings.mcpServers}
              onClose={() => setAddMenu(false)}
              onFiles={chooseFiles}
              onFolder={() =>
                bash
                  ? notify(bashRefusal)
                  : active
                    ? chooseSessionFolders(
                        active,
                        t("Add folders to this session"),
                        report,
                      )
                    : void pickFolder()
              }
              onBrowseConnectors={() => openSettingsTab("plugins")}
              onConnectors={() => openSettingsTab("connectors")}
              onToggleConnector={(name, enabled) => {
                const server = settings.mcpServers[name] as Record<
                  string,
                  unknown
                >;
                void updatePreference({
                  mcpServers: {
                    ...settings.mcpServers,
                    [name]: { ...server, enabled },
                  },
                });
              }}
              onPlugins={() => openSettingsTab("plugins")}
              onSlashCommands={() => {
                setPendingSlash(null);
                setText("/");
                setSlashSelected(0);
                setSlashDismissed(false);
                requestAnimationFrame(() => composer.current?.focus());
              }}
              onUnavailable={notify}
              onImportIssue={() => setIssuesOpen(true)}
              onImportLinearIssue={() => setLinearIssuesOpen(true)}
              inCloud={inCloud}
            />
          ) : (
            <ComposerAddPicker
              active={active}
              appContext={appContext}
              attachments={attachments}
              bash={bash}
              chooseFiles={chooseFiles}
              composer={composer}
              extendedThinking={extendedThinking}
              host={host}
              incognito={incognito}
              incognitoControls={incognitoControls}
              mode={mode}
              notify={notify}
              onCreateProject={onCreateProject}
              onProject={onProject}
              onResearch={onResearch}
              onWebSearch={onWebSearch}
              openSettingsTab={openSettingsTab}
              openSkillsSettings={openSkillsSettings}
              pending={pending}
              pickFolder={pickFolder}
              platform={platform}
              project={project}
              projects={projects}
              report={report}
              research={research}
              researchAvailable={researchAvailable}
              researchUnavailableReason={researchUnavailableReason}
              running={running}
              sending={sending}
              setAddMenu={setAddMenu}
              setGithubOpen={setGithubOpen}
              setSkillTokens={setSkillTokens}
              setText={setText}
              skillRanges={skillRanges}
              text={text}
              toggleThinking={toggleThinking}
              unifiedChat={unifiedChat}
              webChat={webChat}
              webSearch={webSearch}
              webSearchAvailable={webSearchAvailable}
            />
          ))}
      </Suspense>
    </div>
  );
  // Research's chip sits right of "+" while it is on; it turns Research off, as
  // the menu row does.
  const researchChip = (
    <ChipPresence>
      {mode === "chat" && research && onResearch && (
        <ResearchChip onClick={onResearch} disabled={running || sending} />
      )}
    </ChipPresence>
  );
  // Code's model button names ⇧⌘I (openModelMenu) in its tooltip.
  const modelTip = useTooltip(mode === "code" ? "Model" : "Switch models", {
    shortcut: ["mod", "shift", mode === "code" ? "I" : "."],
    placement: "above",
    disabled: modelMenu,
  });
  const liveCode = codeLiveLayout(mode, host, codeHomeDraft);
  const modelPicker = (
    <div
      className={`popover-anchor ${mode === "code" ? "" : "model-effort-anchor"}`}
    >
      {liveCode ? (
        <CodeModelTrigger
          {...modelTip.props}
          model={model}
          effort={settings.codeEffort}
          aria-haspopup="menu"
          aria-expanded={modelMenu}
          onClick={() => {
            setEffortOpenRequest(0);
            setModelMenu(!modelMenu);
            setAddMenu(false);
          }}
        />
      ) : (
        <button
          {...modelTip.props}
          className={`model-button u-press ${mode === "code" ? "" : "model-effort-pill"}`}
          aria-haspopup="menu"
          aria-expanded={modelMenu}
          aria-label={
            mode !== "code" && catalogRead.value === undefined
              ? t("Select model")
              : modelTriggerLabel(
                  model,
                  mode === "code" ? settings.codeEffort : settings.effort,
                  catalog,
                )
          }
          aria-busy={
            (mode !== "code" && catalogRead.status === "pending") || undefined
          }
          onClick={() => {
            setModelMenu(!modelMenu);
            setAddMenu(false);
          }}
        >
          {mode === "code" ? (
            <ModelName model={model} />
          ) : catalogRead.value !== undefined ? (
            <>
              <span className="model-button-name">
                <ModelName model={model} />
              </span>
              <span className="model-button-effort">
                {chatEffortLabels[settings.effort]}
              </span>
            </>
          ) : null}
        </button>
      )}
      {modelTip.tooltip}
      {modelMenu && (
        <MenuSheetScrim
          onClose={() => {
            setModelMenu(false);
            if (codeHomeDraft) setEffortOpenRequest(0);
          }}
        />
      )}
      {modelMenu &&
        (mode === "code" ? (
          <Suspense fallback={null}>
            <CodeModelMenu
              sessionEffort={
                liveCode
                  ? {
                      value: settings.codeEffort,
                      openRequest: effortOpenRequest,
                      onChange: (value) => {
                        void updatePreference({ codeEffort: value }).catch(
                          report,
                        );
                      },
                    }
                  : undefined
              }
              providers={settings.providers}
              providerId={providerId}
              model={model}
              onSelect={(id, name) => {
                void selectModel(id, name);
              }}
              onManage={openModelService}
              onClose={() => {
                setModelMenu(false);
                if (codeHomeDraft) setEffortOpenRequest(0);
              }}
            />
          </Suspense>
        ) : (
          <Suspense fallback={null}>
            <ModelMenu
              providers={settings.providers}
              providerId={providerId}
              model={model}
              effort={settings.effort}
              onSelect={(id, name) => {
                void selectModel(id, name);
              }}
              onEffort={(effort) => {
                void updatePreference({ effort });
              }}
              thinking={
                mode === "chat"
                  ? settings.effort !== "low"
                  : thinkingMode === "extended"
              }
              onThinking={
                toggleThinking
                  ? () => void toggleThinking().catch(report)
                  : undefined
              }
              onManage={openModelService}
              onClose={() => setModelMenu(false)}
              notice={
                retired && active && model !== active.model
                  ? retiredModelNotice(
                      retired.legacy,
                      modelLabel(catalog, model),
                    )
                  : undefined
              }
            />
          </Suspense>
        ))}
    </div>
  );
  // Chat and Cowork show effort inside the model pill and change it from the model menu's Effort submenu.
  const effortPicker =
    mode === "code" && !liveCode ? (
      <CodeEffortSlider
        value={settings.codeEffort}
        supported={codeEffortsFor(catalog, model)}
        openRequest={effortOpenRequest}
        onChange={(value) => {
          void updatePreference({ codeEffort: value }).catch(report);
        }}
      />
    ) : null;
  const hasDraft = Boolean(
    text.trim() ||
    attachments.length ||
    pendingSlash ||
    reviewNotes.length ||
    (!active && mode === "code" && appContext?.composerDraft.draftLinearIssue),
  );
  // A Chat or Cowork conversation's frame draws Stop and Send as plain glyphs:
  // the reply composer's ghost Send with the return arrow.
  const plainGlyphs = mode !== "code" && Boolean(active);
  // Stop asked for: the button spins until the turn ends (the original's
  // "stopping" Stop), from the same mark as Code's "Stopping…" status line.
  // It stays clickable in case the first request is lost.
  const runningTurn = [...(active?.turns ?? [])]
    .reverse()
    .find((turn) => turn.status === "inProgress");
  const stopping = useTurnStopping(runningTurn?.id ?? "") && running;
  // Esc stops a running reply, as the Stop button does. An Escape that
  // something else used (a menu, a palette, a dialog, an input method's
  // composition, dictation) is left to that.
  useEffect(() => {
    if (!running || stopping) return;
    const listener = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        modelMenu ||
        addMenu ||
        dictation.live ||
        // Escape in another field (the sidebar's search) is that field's.
        (event.target !== composer.current &&
          event.target instanceof HTMLElement &&
          event.target.matches(
            'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
          )) ||
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        return;
      void interrupt().catch(report);
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [
    running,
    stopping,
    modelMenu,
    addMenu,
    dictation.live,
    interrupt,
    report,
  ]);
  // The Code prompt names its buttons "Stop" and "Send".
  const stopLabel = mode === "code" ? "Stop" : "Stop response";
  const chatStopFace = (tip: Record<string, unknown> = {}) => (
    <button
      {...tip}
      type="button"
      className={`send-button stop composer-ghost-stop ${plainGlyphs ? "plain" : ""}`}
      aria-label={t("Stop response")}
      aria-busy={stopping || undefined}
      onClick={() => void interrupt().catch(report)}
    >
      {stopping ? (
        <Spinner inheritColor size={plainGlyphs ? 20 : 14} className="spin" />
      ) : (
        <AppIcon
          name={plainGlyphs ? "StopCircle" : "Stop"}
          size={plainGlyphs ? 20 : 14}
        />
      )}
    </button>
  );
  return {
    plainGlyphs,
    chatStopFace,
    stopping,
    stopLabel,
    hasDraft,
    attachmentPicker,
    researchChip,
    modelPicker,
    effortPicker,
  } as const;
}

import { ComposerAddMenu, bashRefusal } from "./Composer";
import { maxAttachmentsFor, attachmentLimitNotice } from "./attachment-limits";
import { requestConnectorsEntry } from "../settings/navigation";
import { insertSkillToken } from "./skill-tokens";
import type { Conversation, Attachment, Project } from "../../shared/types";
import type { AppController } from "../app/AppContext";
import type { ComposerField } from "./composer-field";
import type { HostInfo } from "../../shared/host";
import type { PendingAttachment } from "./Attachments";
import type { SkillToken } from "./skill-tokens";

/** What ComposerAddPicker needs from useComposerPickers.tsx. */
export interface UseComposerPickersPart1Props {
  active: Conversation | undefined;
  appContext: AppController | undefined;
  attachments: Attachment[];
  bash: boolean;
  chooseFiles: () => void;
  composer: React.RefObject<ComposerField | null>;
  extendedThinking: boolean;
  host: HostInfo;
  incognito: boolean;
  incognitoControls: boolean;
  mode: "chat" | "cowork";
  notify: (message: string) => void;
  onCreateProject: (name?: string | undefined) => void;
  onProject: (id: string | null) => void;
  onResearch: (() => void) | undefined;
  onWebSearch: () => void;
  openSettingsTab: (tab: string) => void;
  openSkillsSettings: (view: "yours" | "discover") => void;
  pending: PendingAttachment[];
  pickFolder: () => Promise<void>;
  platform: NodeJS.Platform;
  project: Project | undefined;
  projects: Project[];
  report: (error: unknown) => void;
  research: boolean;
  researchAvailable: boolean;
  researchUnavailableReason: string | undefined;
  running: boolean;
  sending: boolean;
  setAddMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setGithubOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSkillTokens: ((tokens: SkillToken[]) => void) | undefined;
  setText: React.Dispatch<React.SetStateAction<string>>;
  skillRanges: SkillToken[];
  text: string;
  toggleThinking: (() => Promise<void>) | undefined;
  unifiedChat: boolean;
  webChat: boolean;
  webSearch: boolean;
  webSearchAvailable: boolean;
}

export function ComposerAddPicker({
  active,
  appContext,
  attachments,
  bash,
  chooseFiles,
  composer,
  extendedThinking,
  host,
  incognito,
  incognitoControls,
  mode,
  notify,
  onCreateProject,
  onProject,
  onResearch,
  onWebSearch,
  openSettingsTab,
  openSkillsSettings,
  pending,
  pickFolder,
  platform,
  project,
  projects,
  report,
  research,
  researchAvailable,
  researchUnavailableReason,
  running,
  sending,
  setAddMenu,
  setGithubOpen,
  setSkillTokens,
  setText,
  skillRanges,
  text,
  toggleThinking,
  unifiedChat,
  webChat,
  webSearch,
  webSearchAvailable,
}: UseComposerPickersPart1Props) {
  return (
    <ComposerAddMenu
      presentation={
        webChat
          ? "web-chat"
          : host.kind === "desktop"
            ? "native-chat"
            : "legacy"
      }
      processing={running || sending}
      onFolder={
        host.kind === "desktop" &&
        host.capabilities.localFolders &&
        active?.environment?.kind !== "ssh" &&
        (!incognito || !incognitoControls)
          ? () => {
              if (bash) {
                notify(bashRefusal);
                return;
              }
              if (!active) void pickFolder();
              else if (active.mode === "cowork")
                void import("../cowork/task-folders")
                  .then(({ addCoworkTaskFolder }) =>
                    addCoworkTaskFolder(active, { notify }),
                  )
                  .catch(report);
            }
          : undefined
      }
      folderUnavailableReason={
        active?.mode === "chat"
          ? "This session doesn't support adding folders yet."
          : undefined
      }
      onGitHub={
        mode === "chat"
          ? () => {
              const limit = maxAttachmentsFor(mode);
              if (attachments.length + pending.length >= limit)
                notify(attachmentLimitNotice(limit));
              else setGithubOpen(true);
            }
          : undefined
      }
      platform={platform}
      projects={projects}
      currentProjectId={project?.id}
      webSearch={webSearch}
      webSearchAvailable={webSearchAvailable}
      onWebSearch={onWebSearch}
      research={research}
      researchAvailable={researchAvailable}
      researchUnavailableReason={researchUnavailableReason}
      onResearch={onResearch}
      thinking={extendedThinking}
      onThinking={
        toggleThinking ? () => void toggleThinking().catch(report) : undefined
      }
      onClose={() => setAddMenu(false)}
      onFiles={chooseFiles}
      onSkill={(skill) => {
        const area = composer.current;
        const next = insertSkillToken(
          text,
          skillRanges,
          skill.name,
          area?.selectionStart ?? text.length,
          area?.selectionEnd ?? text.length,
        );
        if (!next) return;
        setText(next.text);
        setSkillTokens?.(next.skillTokens);
        requestAnimationFrame(() => {
          composer.current?.focus();
          composer.current?.setSelectionRange(next.caret, next.caret);
        });
      }}
      onBrowseSkills={
        unifiedChat && appContext
          ? () => openSkillsSettings("discover")
          : undefined
      }
      onBrowseConnectors={() => {
        requestConnectorsEntry("discover");
        openSettingsTab("connectors");
      }}
      onAddCustomConnector={() => {
        requestConnectorsEntry("add");
        openSettingsTab("connectors");
      }}
      onProject={onProject}
      onCreateProject={onCreateProject}
      onSettings={(tab) =>
        tab === "skills" ? openSkillsSettings("yours") : openSettingsTab(tab)
      }
      onUnavailable={notify}
      projectsAvailable
    />
  );
}

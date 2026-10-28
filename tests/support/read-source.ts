import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Modules whose code was split into pieces: their source, for a test that
 * reads it, is the module followed by the pieces.
 */
const splitModules: Record<string, string[]> = {
  "src/transcript/ConversationTranscript.tsx": [
    "src/transcript/ConversationTranscriptView.tsx",
    "src/transcript/AssistantContent.tsx",
    "src/transcript/TranscriptPrompt.tsx",
  ],
  "src/plugins/AddMarketplaceDialog.tsx": [
    "src/plugins/AddMarketplaceView.tsx",
  ],
  "src/composer/CloudWorkspaceBar.tsx": [
    "src/composer/CloudWorkspaceBarView.tsx",
  ],
  "src/composer/model/ModelMenu.tsx": ["src/composer/model/ModelMenuView.tsx"],
  "src/pr/PullRequestBar.tsx": ["src/pr/PullRequestBarView.tsx"],
  "src/composer/WorkspaceBar.tsx": ["src/composer/WorkspaceBarView.tsx"],
  "src/collections/routines/ScheduledTaskDialog.tsx": [
    "src/collections/routines/ScheduledTaskDialogView.tsx",
  ],
  "src/collections/projects/ProjectsPage.tsx": [
    "src/collections/projects/ProjectsPageView.tsx",
  ],
  "src/cowork/CoworkTasksPanel.tsx": ["src/cowork/CoworkTasksPanelView.tsx"],
  "src/conversation/BackgroundTasksPanel.tsx": [
    "src/conversation/BackgroundTasksPanelView.tsx",
  ],
  "src/collections/projects/ProjectOverview.tsx": [
    "src/collections/projects/ProjectOverviewView.tsx",
  ],
  "src/plugins/PluginUploadDialog.tsx": ["src/plugins/PluginUploadView.tsx"],
  "src/collections/history/HistoryPage.tsx": [
    "src/collections/history/HistoryPageView.tsx",
  ],
  "src/artifacts/ArtifactsPage.tsx": ["src/artifacts/ArtifactsPageView.tsx"],
  "electron/main.ts": [
    "electron/app/main-window.ts",
    "electron/app/ipc-register.ts",
    "electron/app/account-lifecycle.ts",
    "electron/app/mcp-config-file.ts",
    "electron/app/start-app.ts",
    "electron/app/app-window-registry.ts",
    "electron/app/ipc-handle.ts",
    "electron/app/quick-entry-launch.ts",
    "electron/app/main-folders.ts",
  ],
  "src/app/App.tsx": [
    "src/app/useAppState.tsx",
    "src/app/useAppNavigation.tsx",
    "src/app/useAppEffects.tsx",
  ],
  "src/settings/tabs/Connectors.tsx": [
    "src/settings/tabs/useConnectorsActions.tsx",
    "src/settings/tabs/ConnectorsView.tsx",
    "src/settings/tabs/InstalledConnectorRow.tsx",
    "src/settings/tabs/ConnectorsHeader.tsx",
    "src/settings/tabs/DesktopConnectorsTable.tsx",
    "src/settings/tabs/AddConnectorMenu.tsx",
    "src/settings/tabs/ConnectorsDialogs.tsx",
  ],
  "src/changes/ChangesPanel.tsx": [
    "src/changes/useChangesPanelActions.tsx",
    "src/changes/ChangesPanelView.tsx",
  ],
  "src/terminal/TerminalPanel.tsx": [
    "src/terminal/useTerminalPanelActions.tsx",
    "src/terminal/TerminalPanelView.tsx",
  ],
  "src/artifacts/ArtifactChrome.tsx": [
    "src/artifacts/useArtifactChromeState.tsx",
    "src/artifacts/useArtifactChromeActions.tsx",
    "src/artifacts/ArtifactChromeView.tsx",
    "src/artifacts/ArtifactCollaborationControls.tsx",
    "src/artifacts/ArtifactTitleMenu.tsx",
    "src/artifacts/ArtifactCommentsPane.tsx",
    "src/artifacts/ArtifactCollaborationHeader.tsx",
  ],
  "src/collections/customize/CustomizePage.tsx": [
    "src/collections/customize/useCustomizeState.tsx",
    "src/collections/customize/useCustomizeEffects.tsx",
    "src/collections/customize/useCustomizeControls.tsx",
    "src/collections/customize/CustomizeView.tsx",
    "src/collections/customize/CustomizeYoursSkills.tsx",
    "src/collections/customize/CustomizeDiscoverSections.tsx",
    "src/collections/customize/CustomizeNav.tsx",
    "src/collections/customize/customize-menus.tsx",
  ],
  "src/collections/search/SearchPalette.tsx": [
    "src/collections/search/useSearchPaletteActions.tsx",
    "src/collections/search/SearchPaletteView.tsx",
    "src/collections/search/SearchCompose.tsx",
    "src/collections/search/SearchPaletteHead.tsx",
  ],
  "src/files/FilesPanel.tsx": [
    "src/files/FilesPanelView.tsx",
    "src/files/FilesSaveBar.tsx",
    "src/files/FilesRows.tsx",
    "src/files/FilesContentRows.tsx",
    "src/files/FilesTreeContents.tsx",
  ],
  "src/ui/Menu.tsx": ["src/ui/Submenu.tsx", "src/ui/menu-rows.tsx"],
  "src/sidebar/ConversationList.tsx": [
    "src/sidebar/useConversationListActions.tsx",
    "src/sidebar/ConversationListView.tsx",
    "src/sidebar/ConversationListLabels.tsx",
  ],
  "src/simulators/AnnotateImage.tsx": [
    "src/simulators/useAnnotateImageActions.tsx",
    "src/simulators/AnnotateImageView.tsx",
    "src/simulators/AnnotateControls.tsx",
  ],
  "src/simulators/SimulatorDevice.tsx": [
    "src/simulators/useSimulatorDeviceActions.tsx",
    "src/simulators/DeviceViewMarkup.tsx",
    "src/simulators/DeviceControls.tsx",
  ],
  "src/collections/routines/RoutinesPage.tsx": [
    "src/collections/routines/useRoutinesPageActions.tsx",
    "src/collections/routines/RoutinesView.tsx",
    "src/collections/routines/routine-menus.tsx",
    "src/collections/routines/RoutineCard.tsx",
  ],
  "src/browser/BrowserPanel.tsx": [
    "src/browser/useBrowserPanelActions.tsx",
    "src/browser/BrowserPanelView.tsx",
  ],
  "src/composer/Composer.tsx": [
    "src/composer/useComposerDraft.tsx",
    "src/composer/useComposerSetup.tsx",
    "src/composer/useComposerActions.tsx",
    "src/composer/useComposerAttachments.tsx",
    "src/composer/useComposerPickers.tsx",
    "src/composer/useComposerControls.tsx",
    "src/composer/ComposerView.tsx",
    "src/composer/message-field-props.tsx",
    "src/composer/ComposerCard.tsx",
    "src/composer/ComposerInputRow.tsx",
    "src/composer/ComposerAddPicker.tsx",
  ],
  "src/simulators/SimulatorPanel.tsx": [
    "src/simulators/useSimulatorPanelState.tsx",
    "src/simulators/useSimulatorPanelActions.tsx",
  ],
  "src/auth/SignInPage.tsx": [
    "src/auth/useSignInPageState.tsx",
    "src/auth/useSignInPageActions.tsx",
  ],
  "src/cowork/ProgressPanel.tsx": [
    "src/cowork/useProgressPanelState.tsx",
    "src/cowork/useProgressPanelActions.tsx",
  ],
  "src/composer/voice/DictationButton.tsx": [
    "src/composer/voice/useDictationButtonState.tsx",
    "src/composer/voice/useDictationButtonActions.tsx",
  ],
  "src/settings/tabs/ClaudeCode.tsx": [
    "src/settings/tabs/ClaudeCodeAppearance.tsx",
    "src/settings/tabs/ClaudeCodeLocalSessions.tsx",
    "src/settings/tabs/ClaudeCodePullRequests.tsx",
    "src/settings/tabs/ClaudeCodeSections.tsx",
  ],
  "src/settings/tabs/General.tsx": [
    "src/settings/tabs/GeneralAppearance.tsx",
    "src/settings/tabs/SettingsVoice.tsx",
  ],
};

/**
 * Reads a source file as the build sees it: a stylesheet's relative
 * `@import "./part.css";` lines are replaced by the parts, in order (an
 * index such as chat-transcript.css lists its parts this way).
 */
export function readSource(file: string | URL, _encoding?: "utf8"): string {
  const filePath = file instanceof URL ? fileURLToPath(file) : file;
  const text = readFileSync(filePath, "utf8");
  const relative = path.relative(process.cwd(), path.resolve(filePath));
  if (splitModules[relative])
    return [
      text,
      ...splitModules[relative].map((part) => readFileSync(part, "utf8")),
    ].join("\n");
  if (!filePath.endsWith(".css")) return text;
  return text.replace(
    /^@import\s+"(\.{1,2}\/[^"]+\.css)";\s*$/gm,
    (_line, relative: string) =>
      readSource(path.join(path.dirname(filePath), relative)),
  );
}

import { trustedDevicesFixture } from "./trusted-devices";
import { privacyDataFixture } from "./privacy-data";
/**
 * The fixture bridge's domains. Each package keeps the synthetic answers for
 * its own bridge calls in `scripts/preview/fixtures/<domain>.ts` and reads
 * its own URL parameters of preview/app.html; app-fixture.ts builds the
 * shared snapshot and calls, then lets every domain listed here replace or
 * add calls. A package adds states in its file without editing this one.
 */
import type { AppEvent, DesktopAPI, Snapshot } from "../../../shared/types";
import { billingFixture } from "./billing";
import { composerFixture } from "./composer";
import { policyFixture } from "./policy";
import { usageFixture } from "./usage";
import { voiceFixture } from "./voice";
import { sharingFixture } from "./sharing";
import { windowsFixture } from "./windows";
import { memoryFixture } from "./memory";
import { researchFixture } from "./research";
import { toolDescriptionsFixture } from "./r7-tool-descriptions";
import { browserFixture } from "./browser";
import { sshFixture } from "./ssh";
import { computerUseFixture } from "./computer-use";
import { coworkFolderAccessFixture } from "./cowork-folder-access";
import { agentsFixture } from "./agents";
import { appUpdateFixture } from "./app-update";
import { settingsDirectoryFixture } from "./settings-directory";
import { settingsDesktopFixture } from "./settings-desktop";
import { collectionsFixture } from "./collections";
import { uaCodeComposerFixture } from "./ua-code-composer";
import { signInFixture } from "./sign-in";
import { shellChatAuditFixture } from "./shell-chat-audit";
import { chatTranscriptAuditFixture } from "./chat-transcript-audit";
import { chatTranscriptAudit2Fixture } from "./chat-transcript-audit-2";
import { webCloudFixture } from "./web-cloud";
import { webGithubFixture } from "./web-github";
import { announcementsFixture } from "./announcements";
import { usageStatsFixture } from "./usage-stats";
import { serviceStatusFixture } from "./service-status";
import { apiKeysFixture } from "./api-keys";
import { replyFeedbackFixture } from "./reply-feedback";
import { artifactsFixture } from "./artifacts";
import { agentToolsAuditFixture } from "./agent-tools-audit";
import { toolGalleryFixture } from "./tool-gallery";
import { codeListFixture } from "./code-list";
import { filesFixture } from "./files";

export interface FixtureContext {
  /** The preview page's URL parameters. */
  params: URLSearchParams;
  /** The fixture's fixed clock origin. */
  origin: number;
  /** The live snapshot; calls change it the way the main process would. */
  state: Snapshot;
  /** Sends an event to the window, like the main process's `push`. */
  emit(event: AppEvent): void;
}

export interface FixtureDomain {
  /** The URL parameters the domain reads and their values, for capture notes. */
  params: Record<string, string>;
  /** Bridge calls the domain answers; they replace the base fixture's. */
  bridge(context: FixtureContext): Partial<DesktopAPI>;
}

/** Applied in this order; a later domain's call replaces an earlier one's. */
export const fixtureDomains: Record<string, FixtureDomain> = {
  policy: policyFixture,
  usage: usageFixture,
  billing: billingFixture,
  voice: voiceFixture,
  composer: composerFixture,
  sharing: sharingFixture,
  windows: windowsFixture,
  memory: memoryFixture,
  research: researchFixture,
  "r7-tool-descriptions": toolDescriptionsFixture,
  browser: browserFixture,
  ssh: sshFixture,
  "computer-use": computerUseFixture,
  "cowork-folder-access": coworkFolderAccessFixture,
  agents: agentsFixture,
  // Claudex's own updates.
  "app-update": appUpdateFixture,
  "settings-directory": settingsDirectoryFixture,
  // Routines, projects, Customize skills and servers.
  collections: collectionsFixture,
  // System, storage, Developer/Connectors servers and Skills.
  "settings-desktop": settingsDesktopFixture,
  "privacy-data": privacyDataFixture,
  "trusted-devices": trustedDevicesFixture,
  // Code composer and home alignment (package UA).
  "ua-code-composer": uaCodeComposerFixture,
  // The signed-out pages.
  "sign-in": signInFixture,
  // The 2026-09-28 shell and chat audit's W969 comparison chat.
  "shell-chat-audit": shellChatAuditFixture,
  // The 2026-09-29 chat-transcript audit states (running, stopped, errors, tool rows).
  "chat-transcript-audit": chatTranscriptAuditFixture,
  // The chat-transcript-2 audit: the W1164 reference reply, versions, attachments.
  "chat-transcript-audit-2": chatTranscriptAudit2Fixture,
  // Artifact sharing records, notes and the library (it was left unregistered).
  artifacts: artifactsFixture,
  // The 2026-09-29 agent-tools-2 audit states (Code streaming, tool rows, Cowork notes).
  "agent-tools-audit": agentToolsAuditFixture,
  // Every tool row in Chat, Cowork and Code.
  "tool-gallery": toolGalleryFixture,
  // The web app's cloud Cowork and Code (audit C).
  "web-cloud": webCloudFixture,
  // The GitHub connection of the web Code home (package W-GITHUB).
  "web-github": webGithubFixture,
  // The API page: service groups and API keys.
  "api-keys": apiKeysFixture,
  announcements: announcementsFixture,
  // Settings → Usage → Activity.
  "usage-stats": usageStatsFixture,
  // The Service status page.
  "service-status": serviceStatusFixture,
  // Rating a reply opens the feedback dialog.
  "reply-feedback": replyFeedbackFixture,
  "code-list": codeListFixture,
  files: filesFixture,
};

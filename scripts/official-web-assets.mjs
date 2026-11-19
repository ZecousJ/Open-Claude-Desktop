import {deriveOfficialUiHostApiModule, hostApiRevision, hostApiAssets, hostApiInputHashes, hostApiOriginalHashes, hostApiRules} from "./official-ui-host-api.mjs";
import {deriveOfficialUiHostMemoryContextModule,hostMemoryContextRevision,hostMemoryContextInputHashes,hostMemoryContextOriginalHashes,hostMemoryContextRules} from "./official-ui-host-memory-context.mjs";
import {deriveOfficialUiHostBrowserSettingsModule,hostBrowserSettingsRevision,hostBrowserSettingsInputHashes,hostBrowserSettingsOriginalHashes,hostBrowserSettingsRules} from "./official-ui-host-browser-settings.mjs";
import { verifyPackagedOfficialResources } from "./official-ui-packaged-resources.mjs";
import { deriveOfficialUiCoworkComputerUseModule, hostCoworkComputerUseFile, hostCoworkComputerUseRevision, deriveOfficialUiCoworkFolderModule, hostCoworkFolderFile, hostCoworkFolderRevision, deriveOfficialUiCoworkStartModule, hostCoworkStartFile, hostCoworkStartRevision, deriveOfficialUiHostCoworkProjectModule, hostCoworkProjectFile, hostCoworkProjectRevision } from "./official-ui-host-cowork-project.mjs";
import { deriveOfficialUiHostExtensionPreviewModule, hostExtensionPreviewFiles, hostExtensionPreviewRevision } from "./official-ui-host-extension-preview.mjs";
import { desktopSessionExportAsset, deriveOfficialUiHostSessionExportModule, hostSessionExportRevision, hostSessionExportTarget } from "./official-ui-host-session-export.mjs";
import { deriveOfficialUiHostResearchSourcesModule, hostResearchSourcesRevision } from "./official-ui-host-research-sources.mjs";
import { deriveOfficialUiHostRoutineFireModule, hostRoutineFireRevision } from "./official-ui-host-routine-fire.mjs";
import { deriveOfficialUiHostImportedChatResumeModule, hostImportedChatResumeFiles, hostImportedChatResumeRevision } from "./official-ui-host-imported-chat.mjs";
import { deriveOfficialSideQuestionErrorModule, sideQuestionErrorRevision, sideQuestionErrorTarget, sideQuestionErrorInputSha256 } from "./official-ui-side-question-error.mjs";
import { deriveOfficialLegacyQuoteIdentityModule, legacyQuoteIdentityRevision, legacyQuoteIdentityTarget, legacyQuoteIdentityInputSha256, verifyOfficialLegacyQuoteIdentityManifest } from "./official-ui-legacy-quote-identity.mjs";
import { deriveCjkEmphasisModule, cjkEmphasisRevision } from "./official-ui-cjk-emphasis.mjs";
import {deriveOfficialModelCatalogStateModule,modelCatalogStateRevision,modelCatalogStateInputHashes,modelCatalogStateOriginalHashes,modelCatalogStateRules} from "./official-ui-model-catalog-state.mjs";
import { deriveOfficialReplyFeedbackSettlementModule, replyFeedbackSettlementRevision, replyFeedbackSettlementTarget, verifyOfficialReplyFeedbackSettlementManifest } from "./official-ui-reply-feedback-settlement.mjs";
import {deriveOfficialUiHostCodeTakebackModule,hostCodeTakebackRevision,hostCodeTakebackInputHashes,hostCodeTakebackOriginalHashes,hostCodeTakebackRules} from "./official-ui-host-code-takeback.mjs";
import { deriveOfficialCodeModes } from "./official-ui-host-code-modes.mjs";
import { deriveOfficialUiHostListUpdatesModule, hostListUpdatesRevision, hostListUpdatesInputHashes, hostListUpdatesOriginalHashes, hostListUpdatesRules } from "./official-ui-host-list-updates.mjs";
import {deriveOfficialUiHostProjectMoveModule,hostProjectMoveRevision,hostProjectMoveInputHashes,hostProjectMoveOriginalHashes,hostProjectMoveRules} from "./official-ui-host-project-move.mjs";
import {
  deriveOfficialUiHostConnectorLimitModule,
  hostConnectorLimitRevision,
  hostConnectorLimitInputHashes,
  hostConnectorLimitOriginalHashes,
  hostConnectorLimitRules,
} from "./official-ui-host-connector-limit.mjs";
import {deriveOfficialStopFeedbackModule,stopFeedbackRevision,stopFeedbackInputs,verifyOfficialStopFeedbackManifest} from "./official-ui-stop-feedback.mjs";
import {deriveOfficialRegenerationErrorModule,regenerationErrorRevision,regenerationErrorTarget,verifyOfficialRegenerationErrorManifest} from "./official-ui-regeneration-error.mjs";
import {deriveOfficialUiHostIncognitoLifecycleModule,hostIncognitoLifecycleRevision,hostIncognitoLifecycleInputHashes,hostIncognitoLifecycleOriginalHashes,hostIncognitoLifecycleRules} from "./official-ui-host-incognito-lifecycle.mjs";
import {
  deriveOfficialUiLaunchDraftModule,
  hostLaunchDraftRevision,
  hostLaunchDraftInputHashes,
  hostLaunchDraftOriginalHashes,
  hostLaunchDraftRules,
} from "./official-ui-host-launch-draft.mjs";
import {deriveOfficialModelPreferenceFeedbackModule,modelPreferenceFeedbackRevision,modelPreferenceFeedbackTarget,verifyOfficialModelPreferenceFeedbackManifest} from "./official-ui-model-preference-feedback.mjs";
import {deriveOfficialChatSearchReadinessModule,chatSearchReadinessRevision,chatSearchReadinessTarget,verifyOfficialChatSearchReadinessManifest} from "./official-ui-chat-search-readiness.mjs";
import {deriveOfficialUiUserContent,hostUserContentRevision,hostUserContentHashes,hostUserContentRules} from "./official-ui-host-usercontent.mjs";
import {deriveOfficialEditRetryModule,editRetryRevision,editRetryMain,editRetryInputHashes,verifyOfficialEditRetryManifest} from "./official-ui-edit-retry.mjs";
import {deriveOfficialChatStarReconcileModule,chatStarReconcileRevision,chatStarReconcileTarget,verifyOfficialChatStarReconcileManifest} from "./official-ui-chat-star-reconcile.mjs";
import {deriveOfficialUiHostCodeFeedbackModule,hostCodeFeedbackRevision,hostCodeFeedbackInputHashes,hostCodeFeedbackOriginalHashes,hostCodeFeedbackRules} from "./official-ui-host-code-feedback.mjs";
import {
  deriveOfficialUiHostCodeErrorModule,
  hostCodeErrorRevision,
  hostCodeErrorInputHashes,
  hostCodeErrorOriginalHashes,
  hostCodeErrorRules,
} from "./official-ui-host-code-error.mjs";
import {deriveOfficialUiHostFeedbackOutcomeModule,hostFeedbackOutcomeRevision,hostFeedbackOutcomeInputHashes,hostFeedbackOutcomeOriginalHashes,hostFeedbackOutcomeRules} from "./official-ui-host-feedback-outcome.mjs";
import {deriveOfficialUiHostWorkspaceTrustModule,hostWorkspaceTrustRevision,hostWorkspaceTrustInputHashes,hostWorkspaceTrustOriginalHashes,hostWorkspaceTrustRules} from "./official-ui-host-workspace-trust.mjs";
import {deriveOfficialUiHostCodeCapabilityModule,hostCodeCapabilityRevision,hostCodeCapabilityInputHashes,hostCodeCapabilityOriginalHashes,hostCodeCapabilityRules} from "./official-ui-host-code-capability.mjs";
import {
  deriveOfficialUiHostCodeConnectorMenuModule,
  hostCodeConnectorMenuRevision,
  hostCodeConnectorMenuInputHashes,
  hostCodeConnectorMenuOriginalHashes,
  hostCodeConnectorMenuRules,
} from "./official-ui-host-code-connector-menu.mjs";
import { deriveOfficialUiHostCodeElicitationModule, hostCodeElicitationFiles, hostCodeElicitationRevision } from "./official-ui-host-code-elicitation.mjs";
import {deriveOfficialUiHostSkillSearchModule,hostSkillSearchRevision,hostSkillSearchInputHashes,hostSkillSearchOriginalHashes,hostSkillSearchRules} from "./official-ui-host-skill-search.mjs";
import {deriveOfficialUiHostDirectorySubmissionsModule, hostDirectorySubmissionsRevision, hostDirectorySubmissionsInputHashes, hostDirectorySubmissionsOriginalHashes, hostDirectorySubmissionsRules} from "./official-ui-host-directory-submissions.mjs";
import {deriveOfficialUiHostInstalledPluginsModule,hostInstalledPluginsRevision,hostInstalledPluginsInputHashes,hostInstalledPluginsOriginalHashes,hostInstalledPluginsRules} from "./official-ui-host-installed-plugins.mjs";
import os from "node:os";
import {deriveOfficialUiHostSubscriptionModule,hostSubscriptionRevision,hostSubscriptionInputHashes,hostSubscriptionOriginalHashes,hostSubscriptionRules} from "./official-ui-host-subscription.mjs";
/** Offline integrity gate for the opt-in host. No capture/download path exists here. */
import fs from "node:fs";
import { deriveUnifiedChat, unifiedChatFiles, retiredChatPages } from "./official-ui-unified-chat.mjs";
import { deriveOfficialChatQueue, chatQueueModule } from "./official-ui-chat-queue.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  deriveOfficialHostWindowManager, hostWindowManagerRevision,
  hostWindowManagerSource, hostWindowManagerOriginalHash, hostWindowManagerRules,
} from "./official-ui-host-window-manager.mjs";
import {
  deriveOfficialUiHostCapabilityModule,
  hostCapabilityRevision,
  hostCapabilityRules,
  hostCapabilityInputHashes,
  hostCapabilityOriginalHashes,
} from "./official-ui-host-capabilities.mjs";
import {
  deriveOfficialUiHostAuthModule,
  hostAuthRevision,
  hostAuthSourceHashes,
  hostAuthRules,
} from "./official-ui-host-auth.mjs";
import {
  deriveOfficialUiHostCompletionModule,
  hostCompletionRevision,
  hostCompletionSourceHashes,
  hostCompletionRules,
} from "./official-ui-host-completion.mjs";
import {
  deriveOfficialUiHostUsageModule,
  hostUsageRevision,
  hostUsageAssets,
  hostUsageInputHashes,
  hostUsageOriginalHashes,
  hostUsageRules,
} from "./official-ui-host-usage.mjs";
import {deriveOfficialUiHostSecurityModule,hostSecurityRevision,hostSecurityInputHashes,hostSecurityOriginalHashes,hostSecurityRules} from "./official-ui-host-security.mjs";
import {deriveOfficialUiHostStaticPreviewModule,hostStaticPreviewRevision,hostStaticPreviewInputHashes,hostStaticPreviewOriginalHashes,hostStaticPreviewRules} from "./official-ui-host-static-preview.mjs";
import {deriveOfficialUiHostMemoryStatusModule,hostMemoryStatusRevision,hostMemoryStatusInputHashes,hostMemoryStatusOriginalHashes,hostMemoryStatusRules} from "./official-ui-host-memory-status.mjs";
import {deriveOfficialUiHostMemoryControlsModule,hostMemoryControlsRevision,hostMemoryControlsInputHashes,hostMemoryControlsOriginalHashes,hostMemoryControlsRules} from "./official-ui-host-memory-controls.mjs";
import { deriveOfficialUiHostSkillInvocationModule, hostSkillInvocationRevision } from "./official-ui-host-skill-invocation.mjs";
import {deriveOfficialUiHostProjectKnowledgeModule,hostProjectKnowledgeRevision,hostProjectKnowledgeInputHashes,hostProjectKnowledgeOriginalHashes,hostProjectKnowledgeRules} from "./official-ui-host-project-knowledge.mjs";
import { deriveOfficialUiHostProjectWorkspaceModule, hostProjectWorkspaceAsset, hostProjectWorkspaceFiles, hostProjectWorkspaceRevision } from "./official-ui-host-project-workspace.mjs";
import {hostHubResources, hostHubManifest, deriveOfficialUiHostHubModule, inspectPinnedHubResources} from "./official-ui-host-hub.mjs";
import { deriveOfficialWebAccountModule } from "./official-web-account-context.mjs";
import { deriveSessionKnowledge, sessionKnowledgeFiles, sessionKnowledgeRevision } from "./official-ui-host-session-knowledge.mjs";
import {
  deriveOfficialUiHostCodeAppScopeModule,
  hostCodeAppScopeInputHashes,
  hostCodeAppScopeOriginalHashes,
  hostCodeAppScopeRevision,
  hostCodeAppScopeRules,
} from "./official-ui-host-code-app-scope.mjs";
import { deriveOfficialIncognitoUploads } from "./official-ui-incognito-uploads.mjs";
import { brandedOfficialDocument, brandedOfficialLogos, officialBrandImages } from "./official-ui-branding.mjs";
import { deriveSupportBundleCopy, supportBundleAsset } from "./official-ui-support-bundle-copy.mjs";
import { derivePrivacyExportCopy, privacyExportAsset } from "./official-ui-privacy-export.mjs";
import { derivePrivacyControls, privacyControlsAsset } from "./official-ui-privacy-controls.mjs";
export const pinnedOfficialArchive =
  "1908f011fab0000852b4504f8ce3e98e3a7575097459a15f923023fa237d8099";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const renames = [
  [/\bclaude\.ai\b/g, "Claudex"],
  [/\bAnthropic\b/g, "Claudex"],
  [/\bClaude\b/g, "Claudex"],
];
export function brandedModule(text) {
  return text
    .replace(
      /(defaultMessage:\s*)("(?:[^"\\\n]|\\.)*")/g,
      (_, prefix, quoted) => {
        let value = JSON.parse(quoted);
        for (const [pattern, replacement] of renames)
          value = value.replace(pattern, replacement);
        return prefix + JSON.stringify(value);
      },
    )
    .replace(
      /(?<!id: )"Claude( Code| Nest)?"/g,
      (_, suffix) => `"Claudex${suffix ?? ""}"`,
    );
}
export function verifyHostCodeDerivationSet(meta) {
  if (meta.hostCodeCapability != null && meta.hostCodeCapability.revision !== hostCodeCapabilityRevision)
    throw Error("Unknown local Code capability derivation");
  if (meta.hostCodeConnectorMenu != null && meta.hostCodeConnectorMenu.revision !== hostCodeConnectorMenuRevision)
    throw Error("Unknown local Code connector menu derivation");
  if (meta.hostCodeAppScope != null && meta.hostCodeAppScope.revision !== hostCodeAppScopeRevision)
    throw Error("Unknown Code App origin derivation");
  if (meta.hostWorkspaceTrust != null && meta.hostWorkspaceTrust.revision !== hostWorkspaceTrustRevision)
    throw Error("Unknown workspace trust derivation");
  if (meta.hostFeedbackOutcome != null && meta.hostFeedbackOutcome.revision !== hostFeedbackOutcomeRevision)
    throw Error("Unknown feedback outcome derivation");
  if (meta.hostCodeFeedback != null && meta.hostCodeFeedback.revision !== hostCodeFeedbackRevision)
    throw Error("Unknown Code feedback derivation");
  // Explicit historical sets retain their own exact-byte derivation. Removing
  // metadata never authorizes bytes from a newer set.
  const codeSet = "claudex-host-code-navigation-v1";
  const trustSet = "claudex-host-workspace-trust-v1";
  const feedbackSet = "claudex-host-feedback-outcome-v1";
  const codeFeedbackSet = "claudex-host-code-feedback-v1";
  if (meta.hostDerivationSet != null && ![codeSet, trustSet, feedbackSet, codeFeedbackSet].includes(meta.hostDerivationSet))
    throw Error("Unknown host derivation set");
  if (meta.hostDerivationSet != null || meta.hostCodeCapability != null || meta.hostWorkspaceTrust != null || meta.hostFeedbackOutcome != null || meta.hostCodeFeedback != null) {
    if (![codeSet, trustSet, feedbackSet, codeFeedbackSet].includes(meta.hostDerivationSet) ||
        !meta.hostCodeCapability || !meta.hostAuth || !meta.hostInstalledPlugins || !meta.hostSkillSearch)
      throw Error("Incomplete local Code host derivation set");
    if (([trustSet, feedbackSet, codeFeedbackSet].includes(meta.hostDerivationSet)) !== !!meta.hostWorkspaceTrust)
      throw Error("Incomplete workspace trust host derivation set");
    if (([feedbackSet, codeFeedbackSet].includes(meta.hostDerivationSet)) !== !!meta.hostFeedbackOutcome)
      throw Error("Incomplete feedback outcome host derivation set");
    if ((meta.hostDerivationSet === codeFeedbackSet) !== !!meta.hostCodeFeedback)
      throw Error("Incomplete Code feedback host derivation set");
  }
}

export function verifyOfficialWebAssets(root = process.cwd(), options = {}) {
  const assembled = options.officialUi ?? path.join(root, "build/official-ui"),
    archive =
      process.env.CLAUDEX_OFFICIAL_ARCHIVE ??
      path.join(root, ".restore/handoff-source.tar.gz");
  if (sha(fs.readFileSync(archive)) !== pinnedOfficialArchive)
    throw Error("Pinned official source archive checksum mismatch.");
  const manifestBytes = execFileSync(
    "tar",
    ["-xOf", archive, "./source-files.json"],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const extracted =
    process.env.CLAUDEX_OFFICIAL_EXTRACTED ??
    path.join(root, ".restore/archive-extracted");
  if (
    !fs
      .readFileSync(path.join(extracted, "source-files.json"))
      .equals(manifestBytes)
  )
    throw Error("Extracted source manifest mismatch.");
  const original = new Map(
    JSON.parse(manifestBytes.toString()).map((row) => [row.path, row]),
  );
  verifyPackagedOfficialResources(root, original, { ...options, extracted });
  const meta = JSON.parse(
    fs.readFileSync(path.join(assembled, "manifest.json"), "utf8"),
  );
  if (
    meta.buildId !== "79979f1379" ||
    meta.entry !== "assets/v1/index-BJJTYFi2.js"
  )
    throw Error("Unexpected official frontend build.");
  let pinnedHubEntry;
  if (meta.hostHub) {
    const hubRoot = path.join(extracted, "claude-frontend-4.4212.0/src/cloud/assets/v1");
    pinnedHubEntry = inspectPinnedHubResources(hubRoot).entry;
    const loader = fs.readFileSync(path.join(hubRoot, hostHubResources.loader), "utf8");
    const expected = {...hostHubManifest(), loader: {...hostHubManifest().loader,
      outputSha256: sha(deriveOfficialUiHostHubModule(hostHubResources.loader, loader))}};
    if (JSON.stringify(meta.hostHub) !== JSON.stringify(expected))
      throw Error("Pinned local Hub manifest mismatch");
  }
  // Native host modules are not published as Web assets, but share this assembly.
  // Verify the exact original/derived bytes rather than trusting metadata alone.
  const wmRecord = original.get(hostWindowManagerSource);
  const wmSource = fs.readFileSync(path.join(extracted, hostWindowManagerSource));
  if (!wmRecord || sha(wmSource) !== hostWindowManagerOriginalHash ||
      wmRecord.sha256 !== hostWindowManagerOriginalHash || wmRecord.bytes !== wmSource.length)
    throw Error("Pinned native window-manager source mismatch.");
  const wmFile = path.join(assembled, "host/window-manager.cjs");
  if (fs.lstatSync(wmFile).isSymbolicLink()) throw Error("Native window-manager cannot be a symlink.");
  const wmExpected = meta.hostWindowManager
    ? Buffer.from(deriveOfficialHostWindowManager(wmSource.toString("utf8"))) : wmSource;
  if (!fs.readFileSync(wmFile).equals(wmExpected))
    throw Error("Native window-manager differs from exact approved derivation.");
  if (meta.hostWindowManager && JSON.stringify(meta.hostWindowManager) !== JSON.stringify({
    revision: hostWindowManagerRevision, source: hostWindowManagerSource,
    originalSha256: hostWindowManagerOriginalHash, outputSha256: sha(wmExpected),
    rules: hostWindowManagerRules.map(row => row[0]),
  })) throw Error("Native window-manager manifest mismatch.");
  if (
    meta.hostCapabilities != null &&
    meta.hostCapabilities.revision !== hostCapabilityRevision
  )
    throw Error("Unknown host capability transform revision.");
  if (meta.hostUserContent != null && meta.hostUserContent.revision !== hostUserContentRevision) throw Error("Unknown user-content origin derivation");
  for (const file of retiredChatPages)
    if (fs.existsSync(path.join(assembled, "ui/assets/v1", file))) throw Error("Retired standalone page is present: " + file);
  if (meta.unifiedChat !== true) throw Error("The shared assembly must contain the unified Chat surface.");
  if (Boolean(meta.hostCompletion) !== (meta.hostChatQueue === true))
    throw Error("Shared Chat completion requires the queue policy in the desktop and Web assembly.");
  if (meta.hostAuth != null && meta.hostAuth.revision !== hostAuthRevision)
    throw Error("Unknown host auth transform revision.");
  if (!!meta.hostAuth !== !!meta.hostCapabilities)
    throw Error(
      "Host routing and capability derivations must use one explicit revision set.",
    );
  if (
    meta.hostCompletion != null &&
    meta.hostCompletion.revision !== hostCompletionRevision
  )
    throw Error("Unknown completion derivation");
  if(meta.hostMemoryStatus != null && meta.hostMemoryStatus.revision !== hostMemoryStatusRevision) throw Error("Unknown memory status derivation");
  if (meta.hostMemoryContext != null && meta.hostMemoryContext.revision !== hostMemoryContextRevision) throw Error("Unknown memory context derivation");
  if (meta.hostApi != null && (meta.hostApi.revision !== hostApiRevision || !meta.hostCapabilities)) throw Error("Unknown API management derivation");
  const serviceAssets = meta.hostApi ? hostApiAssets.map(([file, source]) => ({
    file, source, sha256: sha(fs.readFileSync(path.join(root, source))),
  })) : [];
  if (meta.hostApi && JSON.stringify(meta.hostApi.ownedFiles) !== JSON.stringify(serviceAssets))
    throw Error("Owned service assets manifest mismatch");
  if (meta.hostBrowserSettings != null && meta.hostBrowserSettings.revision !== hostBrowserSettingsRevision) throw Error("Unknown browser settings derivation");
  if (meta.hostMemoryControls != null && meta.hostMemoryControls.revision !== hostMemoryControlsRevision) throw Error("Unknown memory controls derivation");
  if (meta.hostSkillInvocation != null && meta.hostSkillInvocation !== hostSkillInvocationRevision) throw Error("Unknown skill invocation derivation");
  if(meta.hostProjectKnowledge != null && meta.hostProjectKnowledge.revision !== hostProjectKnowledgeRevision) throw Error("Unknown project knowledge derivation");
  if (meta.hostProjectWorkspace != null && (meta.hostProjectWorkspace !== hostProjectWorkspaceRevision || !meta.hostAuth))
    throw Error("Unknown project workspace derivation");
  if(meta.hostStaticPreview != null && meta.hostStaticPreview.revision !== hostStaticPreviewRevision) throw Error("Unknown static preview derivation");
  if (meta.hostSecurity != null && meta.hostSecurity.revision !== hostSecurityRevision)
    throw Error("Unknown security derivation");
  if (meta.incognitoUploads && !meta.hostIncognitoLifecycle) throw Error("Incognito uploads require the lifecycle derivation");
  const incognitoUploadPredecessors = new Map();
  const skillInvocationPredecessors = new Map();
  const sessionKnowledgePredecessors = new Map();
  let computerUsePredecessor;
  if (meta.hostCoworkFolder != null && (meta.hostCoworkFolder !== hostCoworkFolderRevision || !meta.hostCoworkProject))
    throw Error("Unknown native Cowork folder derivation");
  if (meta.hostCoworkComputerUse != null && (meta.hostCoworkComputerUse !== hostCoworkComputerUseRevision || !meta.hostCoworkStart))
    throw Error("Unknown native Cowork computer-use derivation");
  if (meta.hostCoworkStart != null && (meta.hostCoworkStart !== hostCoworkStartRevision || !meta.hostCoworkProject))
    throw Error("Unknown native Cowork start derivation");
  if (meta.hostSessionKnowledge != null && (meta.hostSessionKnowledge !== sessionKnowledgeRevision || !meta.hostCoworkStart))
    throw Error("Unknown session knowledge derivation");
  let coworkFolderPredecessor;
  let coworkStartPredecessor;
  const incognitoUploadOutputs = {};
  if (meta.hostProjectMove != null && (meta.hostProjectMove.revision !== hostProjectMoveRevision || !meta.hostIncognitoLifecycle || !meta.hostCompletion)) throw Error("Unknown project move derivation");
  if (meta.hostConnectorLimit != null && (meta.hostConnectorLimit.revision !== hostConnectorLimitRevision || !meta.hostProjectMove))
    throw Error("Unknown custom connector creation derivation");
  if (meta.hostIncognitoLifecycle != null && (meta.hostIncognitoLifecycle.revision !== hostIncognitoLifecycleRevision || !meta.hostAuth || !meta.hostCompletion)) throw Error("Unknown incognito lifecycle derivation");
  if (meta.hostLaunchDraft != null && (meta.hostLaunchDraft.revision !== hostLaunchDraftRevision || !meta.hostWorkspaceTrust))
    throw Error("Unknown launch draft derivation");
  if (meta.hostListUpdates != null && meta.hostListUpdates.revision !== hostListUpdatesRevision) throw Error("Unknown list-update derivation");
  if (meta.hostModelCatalogState != null && meta.hostModelCatalogState.revision !== modelCatalogStateRevision)
    throw Error("Unsupported model catalog state manifest");
  if (meta.hostLegacyQuoteIdentity != null && meta.hostLegacyQuoteIdentity.revision !== legacyQuoteIdentityRevision) throw Error("Unknown legacy quote derivation");
  if (meta.hostCjkEmphasis != null && meta.hostCjkEmphasis.revision !== cjkEmphasisRevision) throw Error("Unknown CJK emphasis derivation");
  if (meta.hostSideQuestionError != null && (meta.hostSideQuestionError.revision !== sideQuestionErrorRevision || !meta.hostAuth)) throw Error("Unknown side-question error derivation");
  if (meta.hostCodeElicitation != null && (meta.hostCodeElicitation.revision !== hostCodeElicitationRevision || !meta.hostCodeCapability)) throw Error("Unknown native Code elicitation derivation");
  if (meta.hostCoworkProject != null && meta.hostCoworkProject.revision !== hostCoworkProjectRevision) throw Error("Unknown native Cowork project derivation");
  if (meta.hostExtensionPreview != null && meta.hostExtensionPreview.revision !== hostExtensionPreviewRevision) throw Error("Unknown native extension preview derivation");
  let desktopSessionExport;
  if (meta.hostSessionExport) {
    if (meta.hostSessionExport.revision !== hostSessionExportRevision)
      throw Error("Unknown native session export derivation");
    const key = "claude-frontend-4.4212.0/" + desktopSessionExportAsset;
    const record = original.get(key);
    const bytes = fs.readFileSync(path.join(extracted, key));
    if (!record || record.sha256 !== sha(bytes) || record.bytes !== bytes.length)
      throw Error("Pinned desktop session export dialog checksum mismatch");
    desktopSessionExport = bytes.toString("utf8");
  }
  if (meta.hostImportedChatResume != null && meta.hostImportedChatResume.revision !== hostImportedChatResumeRevision)
    throw Error("Unknown native imported Chat resume derivation");
  if (meta.hostResearchSources != null && meta.hostResearchSources.revision !== hostResearchSourcesRevision)
    throw Error("Unknown Research sources panel derivation");
  if (meta.hostRoutineFire != null && meta.hostRoutineFire.revision !== hostRoutineFireRevision)
    throw Error("Unknown routine token panel derivation");
  if (meta.hostReplyFeedbackSettlement != null && meta.hostReplyFeedbackSettlement.revision !== replyFeedbackSettlementRevision) throw Error("Unknown reply feedback derivation");
  if (meta.hostCodeTakeback != null && (meta.hostCodeTakeback.revision !== hostCodeTakebackRevision || !meta.hostLaunchDraft))
    throw Error("Unsupported Code takeback derivation chain");
  if (meta.hostCodeError != null && meta.hostCodeError.revision !== hostCodeErrorRevision)
    throw Error("Unknown Code server error derivation");
  verifyHostCodeDerivationSet(meta);
  if (meta.hostDirectorySubmissions != null && (meta.hostDirectorySubmissions.revision !== hostDirectorySubmissionsRevision || !meta.hostAuth)) throw Error("Unknown directory submissions derivation");
  if (meta.hostInstalledPlugins != null && meta.hostInstalledPlugins.revision !== hostInstalledPluginsRevision) throw Error("Unknown installed plugin summary derivation");
  if (meta.hostSkillSearch != null && meta.hostSkillSearch.revision !== hostSkillSearchRevision) throw Error("Unknown installed skill search derivation");
  if (meta.hostSubscription != null && meta.hostSubscription.revision !== hostSubscriptionRevision) throw Error("Unknown subscription presentation derivation");
  if (meta.hostUsage != null && meta.hostUsage.revision !== hostUsageRevision)
    throw Error("Unknown usage derivation");
  if (
    !!meta.hostCompletion !== !!meta.hostAuth ||
    !!meta.hostUsage !== !!meta.hostAuth ||
    !!meta.hostSubscription !== !!meta.hostAuth ||
    !!meta.hostSecurity !== !!meta.hostAuth ||
    !!meta.hostStaticPreview !== !!meta.hostAuth ||
    !!meta.hostMemoryStatus !== !!meta.hostAuth ||
    !!meta.hostMemoryControls !== !!meta.hostAuth ||
    !!meta.hostMemoryContext !== !!meta.hostAuth ||
    !!meta.hostProjectKnowledge !== !!meta.hostAuth
  )
    throw Error("Host derivations must use one revision set");
  const usageAssets = meta.hostUsage ? hostUsageAssets.map(([file, source]) => ({
    file, source, sha256: sha(fs.readFileSync(path.join(root, source))),
  })) : [];
  if (meta.hostUsage && JSON.stringify(meta.hostUsage.ownedFiles) !== JSON.stringify(usageAssets))
    throw Error("Owned usage assets manifest mismatch");
  if(meta.hostStaticPreview && JSON.stringify(meta.hostStaticPreview.ownedFiles)!==JSON.stringify(["static-preview","artifact-publishing"].map(name=>({file:"assets/v1/claudex-host-"+name+".js",source:"scripts/official-host/"+name+".mjs",sha256:sha(fs.readFileSync(path.join(root,"scripts/official-host/"+name+".mjs")))}))))throw Error('Owned static preview/publishing manifest mismatch');
  if(meta.hostProjectKnowledge && JSON.stringify(meta.hostProjectKnowledge.ownedFiles)!==JSON.stringify([{file:'assets/v1/claudex-host-project-knowledge-error.js',source:'scripts/official-host/project-knowledge-error.mjs',sha256:sha(fs.readFileSync(path.join(root,'scripts/official-host/project-knowledge-error.mjs')))}]))throw Error('Owned project knowledge manifest mismatch');
  if(meta.hostMemoryStatus && JSON.stringify(meta.hostMemoryStatus.ownedFiles)!==JSON.stringify([{file:'assets/v1/claudex-host-memory-status.js',source:'scripts/official-host/memory-status.mjs',sha256:sha(fs.readFileSync(path.join(root,'scripts/official-host/memory-status.mjs')))}]))throw Error('Owned memory status manifest mismatch');
  // Rebuild the exact owned module graph in isolation; manifest hashes alone cannot bless changed bytes.
  const expectedUsageActivity = new Map();
  if (meta.hostUsage) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-usage-verify-"));
    try {
      const rebuilt = JSON.parse(execFileSync(process.execPath,
        [path.join(root, "scripts/official-ui-usage-activity-bundle.mjs"), temporary],
        { cwd: root, maxBuffer: 2 * 1024 * 1024, timeout: 60000 }).toString());
      if (JSON.stringify(meta.hostUsage.activityBundle) !== JSON.stringify(rebuilt))
        throw Error("Owned Usage Activity bundle manifest mismatch");
      for (const row of rebuilt.files) expectedUsageActivity.set("assets/v1/" + row.file, row.sha256);
    } finally { fs.rmSync(temporary, {recursive:true,force:true}); }
  }
  if (meta.hostChatStarReconcile != null && (typeof meta.hostChatStarReconcile !== "object" || meta.hostChatStarReconcile.revision !== chatStarReconcileRevision)) throw Error("Unsupported Chat star reconcile manifest");
  if (meta.hostEditRetry != null && (typeof meta.hostEditRetry !== "object" || meta.hostEditRetry.revision !== editRetryRevision)) throw Error("Unsupported edit retry manifest");
  if (meta.hostEditRetry && !meta.hostChatStarReconcile) throw Error("Edit retry requires the complete Chat star derivation chain");
  if (meta.hostRegenerationError != null && (typeof meta.hostRegenerationError !== "object" || meta.hostRegenerationError.revision !== regenerationErrorRevision)) throw Error("Unsupported regeneration error manifest");
  if (meta.hostRegenerationError && !meta.hostEditRetry) throw Error("Regeneration error requires the complete edit retry derivation chain");
  if (meta.hostStopFeedback != null && (typeof meta.hostStopFeedback !== "object" || meta.hostStopFeedback.revision !== stopFeedbackRevision)) throw Error("Unsupported Stop feedback manifest");
  if (meta.hostStopFeedback && !meta.hostRegenerationError) throw Error("Stop feedback requires the complete regeneration error derivation chain");
  const expectedStopFeedbackInputs = new Map(), expectedStopFeedbackOutputs = {};
  let expectedRegenerationInput, expectedRegenerationOutput;
  if (meta.hostChatSearchReadiness != null && (typeof meta.hostChatSearchReadiness !== "object" || meta.hostChatSearchReadiness.revision !== chatSearchReadinessRevision)) throw Error("Unsupported Chat search readiness manifest");
  if (meta.hostChatSearchReadiness && !meta.hostEditRetry) throw Error("Chat search readiness requires the complete host derivation chain");
  if (meta.hostModelPreferenceFeedback != null && (typeof meta.hostModelPreferenceFeedback !== "object" || meta.hostModelPreferenceFeedback.revision !== modelPreferenceFeedbackRevision)) throw Error("Unsupported model preference feedback manifest");
  if (meta.hostModelPreferenceFeedback && !meta.hostChatSearchReadiness) throw Error("Model preference feedback requires the complete host derivation chain");
  let expectedModelPreferenceFeedbackOutput, expectedModelPreferenceFeedbackInput;
  let expectedChatSearchReadinessOutput;
  let expectedReplyFeedbackSettlementOutput;
  const expectedEditRetryInputs = new Map(), expectedEditRetryOutputs = {};
  let expectedChatStarOutput;
  let chatQueuePredecessor;
  const unifiedChatPredecessors = new Map();
  if (meta.hostChatStarReconcile && !meta.hostCodeFeedback) throw Error("Chat star reconcile requires the complete host derivation chain");
  const expectedUserContent = new Map();
  const expectedFeedbackOutcome = new Map();
  const expectedHostAuth = new Map(),
    expectedCompletion = new Map(),
    expectedCapabilities = new Map(),
    expectedInstalledPlugins = new Map(),
    expectedCodeTakeback = new Map(),
    expectedModelCatalogState = new Map();
  const codeModePredecessors = new Map();
  const projectWorkspacePredecessors = new Map();
  const ui = path.join(assembled, "ui"),
    files = [];
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink())
        throw Error("Symlinks are not accepted in official Web assets.");
      const full = path.join(directory, item.name);
      if (item.isDirectory()) {
        walk(full);
        continue;
      }
      if (!item.isFile()) throw Error("Unexpected asset type.");
      const relative = path.relative(ui, full).split(path.sep).join("/");
      const bytes = fs.readFileSync(full);
      if (relative === "assets/v1/" + hostHubResources.localEntry) {
        if (!meta.hostHub || !pinnedHubEntry || !bytes.equals(pinnedHubEntry))
          throw Error("Pinned local Hub alias mismatch");
      } else if (expectedUsageActivity.has(relative)) {
        if (sha(bytes) !== expectedUsageActivity.get(relative)) throw Error("Owned Usage Activity asset mismatch: " + relative);
      } else if (serviceAssets.some(({ file }) => file === relative)) {
        const entry = serviceAssets.find(({ file }) => file === relative);
        if (!bytes.equals(fs.readFileSync(path.join(root, entry.source))))
          throw Error("Owned service panel source mismatch");
      } else if (usageAssets.some(({ file }) => file === relative)) {
        const entry = usageAssets.find(({ file }) => file === relative);
        if (!bytes.equals(fs.readFileSync(path.join(root, entry.source))))
          throw Error("Owned usage asset source mismatch");
      } else if(relative === "assets/v1/claudex-host-artifact-publishing.js") {
        if(!meta.hostStaticPreview || !bytes.equals(fs.readFileSync(path.join(root,"scripts/official-host/artifact-publishing.mjs"))))throw Error("Owned publishing status source mismatch");
      } else if(relative === "assets/v1/claudex-host-static-preview.js") {
        if(!meta.hostStaticPreview || !bytes.equals(fs.readFileSync(path.join(root,"scripts/official-host/static-preview.mjs"))))throw Error("Owned static preview source mismatch");
      } else if(relative === "assets/v1/claudex-host-memory-status.js") {
        if(!meta.hostMemoryStatus || !bytes.equals(fs.readFileSync(path.join(root,"scripts/official-host/memory-status.mjs"))))throw Error("Owned memory status source mismatch");
      } else if(relative === "assets/v1/claudex-host-project-knowledge-error.js") {
        if(!meta.hostProjectKnowledge || !bytes.equals(fs.readFileSync(path.join(root,"scripts/official-host/project-knowledge-error.mjs"))))throw Error("Owned project knowledge source mismatch");
      } else if (relative === hostProjectWorkspaceAsset.file) {
        if (!meta.hostProjectWorkspace || !bytes.equals(fs.readFileSync(path.join(root, hostProjectWorkspaceAsset.source))))
          throw Error("Owned project workspace source mismatch");
      } else if (relative === "assets/v1/claudex-host-side-question-error.js") {
        if (!meta.hostSideQuestionError || !bytes.equals(fs.readFileSync(path.join(root,"shared/side-question-errors.mjs")))) throw Error("Owned side-question error source mismatch");
      } else if (relative.startsWith("assets/")) {
        const key = "claude-frontend-4.4212.0/src/cloud/" + relative,
          record = original.get(key);
        if (!record) throw Error("Unpinned published asset: " + relative);
        const source = fs.readFileSync(path.join(extracted, key));
        if (sha(source) !== record.sha256 || source.length !== record.bytes)
          throw Error("Recovered asset checksum mismatch: " + relative);
        let expected = source;
        if (relative.startsWith("assets/v1/") && relative.endsWith(".js")) {
          const name = path.basename(relative);
          const hubLocated = meta.hostHub
            ? deriveOfficialUiHostHubModule(name, source.toString("utf8"))
            : source.toString("utf8");
          const authenticated = meta.hostAuth
            ? deriveOfficialUiHostAuthModule(name, hubLocated)
            : hubLocated;
          if (meta.hostAuth && Object.hasOwn(hostAuthSourceHashes, name))
            expectedHostAuth.set(name, sha(authenticated));
          const completed = meta.hostCompletion
            ? deriveOfficialUiHostCompletionModule(name, authenticated)
            : authenticated;
          if (
            meta.hostCompletion &&
            Object.hasOwn(hostCompletionSourceHashes, name)
          )
            expectedCompletion.set(name, sha(completed));
          const userContentReady = meta.hostUserContent ? deriveOfficialUiUserContent(name, completed) : completed;
          if (meta.hostUserContent && Object.hasOwn(hostUserContentHashes,name)) expectedUserContent.set(name,sha(userContentReady));
          const brandedSource = brandedModule(brandedOfficialLogos(name, userContentReady));
          const branded = name === supportBundleAsset ? deriveSupportBundleCopy(brandedSource)
            : name === privacyExportAsset ? derivePrivacyExportCopy(brandedSource)
            : name === privacyControlsAsset ? derivePrivacyControls(brandedSource) : brandedSource;
          const capable = meta.hostCapabilities
            ? deriveOfficialUiHostCapabilityModule(name, branded)
            : branded;
          if (meta.hostCapabilities && Object.hasOwn(hostCapabilityInputHashes, name))
            expectedCapabilities.set(name, sha(capable));
          const memoryAware = meta.hostMemoryStatus
            ? deriveOfficialUiHostMemoryStatusModule(name, capable) : capable;
          const knowledgeAware = meta.hostProjectKnowledge
            ? deriveOfficialUiHostProjectKnowledgeModule(name, memoryAware) : memoryAware;
          const previewed = meta.hostStaticPreview
            ? deriveOfficialUiHostStaticPreviewModule(name, knowledgeAware) : knowledgeAware;
          const secured = meta.hostSecurity
            ? deriveOfficialUiHostSecurityModule(name, previewed)
            : previewed;
          const usageAware = meta.hostUsage
            ? deriveOfficialUiHostUsageModule(name, secured) : secured;
          const subscribed = meta.hostSubscription
            ? deriveOfficialUiHostSubscriptionModule(name, usageAware) : usageAware;
          const submissionAware = meta.hostDirectorySubmissions
            ? deriveOfficialUiHostDirectorySubmissionsModule(name, subscribed) : subscribed;
          const pluginAware = meta.hostInstalledPlugins
            ? deriveOfficialUiHostInstalledPluginsModule(name, submissionAware) : submissionAware;
          if (meta.hostInstalledPlugins && Object.hasOwn(hostInstalledPluginsInputHashes, name))
            expectedInstalledPlugins.set(name, sha(pluginAware));
          const skillAware = meta.hostSkillSearch
            ? deriveOfficialUiHostSkillSearchModule(name, pluginAware) : pluginAware;
          const codeAware = meta.hostCodeCapability
            ? deriveOfficialUiHostCodeCapabilityModule(name, skillAware) : skillAware;
          const codeConnectorMenuAware = meta.hostCodeConnectorMenu
            ? deriveOfficialUiHostCodeConnectorMenuModule(name, codeAware) : codeAware;
          const trustAware = meta.hostWorkspaceTrust
            ? deriveOfficialUiHostWorkspaceTrustModule(name, codeConnectorMenuAware) : codeConnectorMenuAware;
          const feedbackAware = meta.hostFeedbackOutcome
            ? deriveOfficialUiHostFeedbackOutcomeModule(name, trustAware) : trustAware;
          if (meta.hostFeedbackOutcome && Object.hasOwn(hostFeedbackOutcomeInputHashes, name))
            expectedFeedbackOutcome.set(name, sha(feedbackAware));
          const codeFeedbackAware = meta.hostCodeFeedback
            ? deriveOfficialUiHostCodeFeedbackModule(name, feedbackAware) : feedbackAware;
          options.onChatStarInput?.(name, codeFeedbackAware);
          const chatStarAware = meta.hostChatStarReconcile
            ? deriveOfficialChatStarReconcileModule(name, codeFeedbackAware) : codeFeedbackAware;
          if (meta.hostChatStarReconcile && name === chatStarReconcileTarget) expectedChatStarOutput = sha(chatStarAware);
          if (meta.hostEditRetry && Object.hasOwn(editRetryInputHashes, name)) {
            expectedEditRetryInputs.set(name, sha(chatStarAware));
            options.onEditRetryInput?.(name, chatStarAware);
          }
          const editRetryAware = meta.hostEditRetry ? deriveOfficialEditRetryModule(name, chatStarAware) : chatStarAware;
          if (meta.hostEditRetry && Object.hasOwn(editRetryInputHashes, name)) expectedEditRetryOutputs[name] = sha(editRetryAware);
          if (meta.hostRegenerationError && name === regenerationErrorTarget) expectedRegenerationInput = sha(editRetryAware);
          const regenerationAware = meta.hostRegenerationError ? deriveOfficialRegenerationErrorModule(name, editRetryAware) : editRetryAware;
          if (meta.hostRegenerationError && name === regenerationErrorTarget) expectedRegenerationOutput = sha(regenerationAware);
          if (meta.hostStopFeedback && Object.hasOwn(stopFeedbackInputs, name)) {
            expectedStopFeedbackInputs.set(name, sha(regenerationAware));
            options.onStopFeedbackInput?.(name, regenerationAware);
          }
          const stopAware = meta.hostStopFeedback ? deriveOfficialStopFeedbackModule(name, regenerationAware) : regenerationAware;
          if (meta.hostStopFeedback && Object.hasOwn(stopFeedbackInputs, name)) expectedStopFeedbackOutputs[name] = sha(stopAware);
          const chatSearchReady = meta.hostChatSearchReadiness ? deriveOfficialChatSearchReadinessModule(name, stopAware) : stopAware;
          if (meta.hostChatSearchReadiness && name === chatSearchReadinessTarget) expectedChatSearchReadinessOutput = sha(chatSearchReady);
          if (meta.hostModelPreferenceFeedback && name === modelPreferenceFeedbackTarget) expectedModelPreferenceFeedbackInput = sha(chatSearchReady);
          const modelPreferenceAware = meta.hostModelPreferenceFeedback ? deriveOfficialModelPreferenceFeedbackModule(name, chatSearchReady) : chatSearchReady;
          if (meta.hostModelPreferenceFeedback && name === modelPreferenceFeedbackTarget) expectedModelPreferenceFeedbackOutput = sha(modelPreferenceAware);
          const incognitoLifecycleAware = meta.hostIncognitoLifecycle
            ? deriveOfficialUiHostIncognitoLifecycleModule(name, modelPreferenceAware) : modelPreferenceAware;
          const launchDraftAware = meta.hostLaunchDraft
            ? deriveOfficialUiLaunchDraftModule(name, incognitoLifecycleAware) : incognitoLifecycleAware;
          const takebackAware = meta.hostCodeTakeback
            ? deriveOfficialUiHostCodeTakebackModule(name, launchDraftAware) : launchDraftAware;
          if (meta.hostCodeTakeback && Object.hasOwn(hostCodeTakebackInputHashes, name))
            expectedCodeTakeback.set(name, sha(takebackAware));
          const codeErrorAware = meta.hostCodeError
            ? deriveOfficialUiHostCodeErrorModule(name, takebackAware) : takebackAware;
          const projectMoveAware = meta.hostProjectMove
            ? deriveOfficialUiHostProjectMoveModule(name, codeErrorAware) : codeErrorAware;
          const connectorLimitAware = meta.hostConnectorLimit
            ? deriveOfficialUiHostConnectorLimitModule(name, projectMoveAware) : projectMoveAware;
          const listsAware = meta.hostListUpdates ? deriveOfficialUiHostListUpdatesModule(name, connectorLimitAware) : connectorLimitAware;
          const modelCatalogAware = meta.hostModelCatalogState ? deriveOfficialModelCatalogStateModule(name, listsAware) : listsAware;
          if (meta.hostModelCatalogState && Object.hasOwn(modelCatalogStateInputHashes, name))
            expectedModelCatalogState.set(name, sha(modelCatalogAware));
          const replyFeedbackAware = meta.hostReplyFeedbackSettlement ? deriveOfficialReplyFeedbackSettlementModule(name, modelCatalogAware) : modelCatalogAware;
          if (meta.hostReplyFeedbackSettlement && name === replyFeedbackSettlementTarget) expectedReplyFeedbackSettlementOutput = sha(replyFeedbackAware);
          const legacyQuoteAware = meta.hostLegacyQuoteIdentity ? deriveOfficialLegacyQuoteIdentityModule(name, replyFeedbackAware) : replyFeedbackAware;
          const cjkAware = meta.hostCjkEmphasis ? deriveCjkEmphasisModule(name, legacyQuoteAware) : legacyQuoteAware;
          const sideQuestionAware = meta.hostSideQuestionError ? deriveOfficialSideQuestionErrorModule(name, cjkAware) : cjkAware;
          const elicitationAware = meta.hostCodeElicitation ? deriveOfficialUiHostCodeElicitationModule(name, sideQuestionAware) : sideQuestionAware;
          const coworkAware = meta.hostCoworkProject ? deriveOfficialUiHostCoworkProjectModule(name, elicitationAware) : elicitationAware;
          const extensionAware = meta.hostExtensionPreview ? deriveOfficialUiHostExtensionPreviewModule(name, coworkAware) : coworkAware;
          const exportAware = desktopSessionExport ? deriveOfficialUiHostSessionExportModule(name, extensionAware, desktopSessionExport) : extensionAware;
          const resumeAware = meta.hostImportedChatResume ? deriveOfficialUiHostImportedChatResumeModule(name, exportAware) : exportAware;
          const routineAware = meta.hostRoutineFire ? deriveOfficialUiHostRoutineFireModule(name, resumeAware) : resumeAware;
          const researchAware = meta.hostResearchSources ? deriveOfficialUiHostResearchSourcesModule(name, routineAware) : routineAware;
          const memoryControlsAware = meta.hostMemoryControls ? deriveOfficialUiHostMemoryControlsModule(name, researchAware) : researchAware;
          const memoryContextAware = meta.hostMemoryContext ? deriveOfficialUiHostMemoryContextModule(name, memoryControlsAware) : memoryControlsAware;
          const browserSettingsAware = meta.hostBrowserSettings ? deriveOfficialUiHostBrowserSettingsModule(name, memoryContextAware) : memoryContextAware;
          expected = Buffer.from(browserSettingsAware);
        }
        if (meta.incognitoUploads) {
          const before = expected.toString("utf8");
          const after = deriveOfficialIncognitoUploads(path.basename(relative), before);
          if (after !== before) {
            incognitoUploadPredecessors.set(relative, sha(expected));
            expected = Buffer.from(after);
            incognitoUploadOutputs[path.basename(relative)] = sha(expected);
          }
        }
        if (meta.hostSkillInvocation && relative.startsWith("assets/v1/") && relative.endsWith(".js")) {
          const before = expected.toString("utf8");
          const after = deriveOfficialUiHostSkillInvocationModule(path.basename(relative), before);
          if (after !== before) {
            skillInvocationPredecessors.set(relative, sha(expected));
            expected = Buffer.from(after);
          }
        }
        if (meta.hostCodeAppScope && relative.startsWith("assets/v1/") && Object.hasOwn(hostCodeAppScopeInputHashes, path.basename(relative))) {
          expected = Buffer.from(deriveOfficialUiHostCodeAppScopeModule(path.basename(relative), expected.toString("utf8")));
        }
        if (meta.hostCoworkFolder && relative === "assets/v1/" + hostCoworkFolderFile) {
          coworkFolderPredecessor = sha(expected);
          expected = Buffer.from(deriveOfficialUiCoworkFolderModule(hostCoworkFolderFile, expected.toString("utf8")));
        }
        if (meta.hostCoworkStart && relative === "assets/v1/" + hostCoworkStartFile) {
          coworkStartPredecessor = sha(expected);
          expected = Buffer.from(deriveOfficialUiCoworkStartModule(hostCoworkStartFile, expected.toString("utf8")));
        }
        if (meta.hostSessionKnowledge && relative.startsWith("assets/v1/") && sessionKnowledgeFiles.includes(path.basename(relative))) {
          sessionKnowledgePredecessors.set(relative, sha(expected));
          expected = Buffer.from(deriveSessionKnowledge(path.basename(relative), expected.toString("utf8")));
        }
        if (meta.hostCoworkComputerUse && relative === "assets/v1/" + hostCoworkComputerUseFile) {
          computerUsePredecessor = sha(expected);
          expected = Buffer.from(deriveOfficialUiCoworkComputerUseModule(hostCoworkComputerUseFile, expected.toString("utf8")));
        }
        if (meta.hostApi && relative.startsWith("assets/v1/") && Object.hasOwn(hostApiInputHashes, path.basename(relative)))
          expected = Buffer.from(deriveOfficialUiHostApiModule(path.basename(relative), expected.toString("utf8")));
        if (meta.hostCodeModes && relative.startsWith("assets/v1/") && relative.endsWith(".js")) {
          const before = expected.toString("utf8");
          const after = deriveOfficialCodeModes(path.basename(relative), before);
          if (after !== before) {
            codeModePredecessors.set(relative, sha(expected));
            expected = Buffer.from(after);
          }
        }
        if (meta.hostProjectWorkspace && relative.startsWith("assets/v1/") && hostProjectWorkspaceFiles.includes(path.basename(relative))) {
          projectWorkspacePredecessors.set(relative, sha(expected));
          expected = Buffer.from(deriveOfficialUiHostProjectWorkspaceModule(path.basename(relative), expected.toString("utf8")));
        }
        if (meta.hostChatQueue && relative === "assets/v1/" + chatQueueModule) {
          chatQueuePredecessor = sha(expected);
          expected = Buffer.from(deriveOfficialChatQueue(relative, expected.toString("utf8")));
        }
        if (relative.startsWith("assets/v1/") && unifiedChatFiles.includes(path.basename(relative))) {
          unifiedChatPredecessors.set(relative, sha(expected));
          expected = Buffer.from(deriveUnifiedChat(relative, expected.toString("utf8")));
        }
        if (!bytes.equals(expected))
          throw Error(
            "Assembled module/CSS differs from approved exact source derivation: " +
              relative,
          );
      }
      const content = deriveOfficialWebAccountModule(relative, bytes);
      files.push({
        path: relative,
        file: full,
        ...(content ? { content } : {}),
        bytes: bytes.length,
        sha256: sha(bytes),
      });
    }
  }
  for (const dir of ["assets", "i18n", "images"]) walk(path.join(ui, dir));
  for (const file of unifiedChatFiles)
    execFileSync(process.execPath, ["--check", path.join(ui, "assets/v1", file)], { stdio: "pipe" });
  if (meta.hostProjectWorkspace && (projectWorkspacePredecessors.size !== hostProjectWorkspaceFiles.length ||
      !files.some(row => row.path === hostProjectWorkspaceAsset.file)))
    throw Error("Project workspace assets are missing");
  if (usageAssets.some(({ file }) => !files.some(row => row.path === file)))
    throw Error("Owned usage asset missing");
  if (meta.incognitoUploads && (Object.keys(incognitoUploadOutputs).length !== 3 ||
      Object.entries(meta.incognitoUploads).length !== 3 ||
      Object.entries(incognitoUploadOutputs).some(([name, digest]) => meta.incognitoUploads[name] !== digest)))
    throw Error("Incognito upload manifest mismatch");
  if (meta.hostCodeElicitation && hostCodeElicitationFiles.some(name => !files.some(row => row.path === "assets/v1/" + name)))
    throw Error("Native Code elicitation module missing");
  if (meta.hostCoworkProject && !files.some(row => row.path === "assets/v1/" + hostCoworkProjectFile))
    throw Error("Native Cowork project module missing");
  if (meta.hostSessionKnowledge && sessionKnowledgeFiles.some(name => !files.some(row => row.path === "assets/v1/" + name)))
    throw Error("Session knowledge module missing");
  if (meta.hostExtensionPreview && hostExtensionPreviewFiles.some(name => !files.some(row => row.path === "assets/v1/" + name)))
    throw Error("Native extension preview module missing");
  if (meta.hostSessionExport && !files.some(row => row.path === "assets/v1/" + hostSessionExportTarget))
    throw Error("Native session export derivation target is missing");
  if (meta.hostImportedChatResume && hostImportedChatResumeFiles.some(name => !files.some(row => row.path === "assets/v1/" + name)))
    throw Error("Native imported Chat resume derivation target is missing");
  if (meta.hostSideQuestionError) {
    const rows = files.filter(row => row.path === "assets/v1/" + sideQuestionErrorTarget);
    const owned = files.filter(row => row.path === "assets/v1/claudex-host-side-question-error.js");
    const expected = { revision: sideQuestionErrorRevision, modules: [{ file: sideQuestionErrorTarget, inputSha256: sideQuestionErrorInputSha256, outputSha256: rows[0]?.sha256 }], ownedFiles: [{ file: "assets/v1/claudex-host-side-question-error.js", source: "shared/side-question-errors.mjs", sha256: sha(fs.readFileSync(path.join(root,"shared/side-question-errors.mjs"))) }] };
    if (rows.length !== 1 || owned.length !== 1 || JSON.stringify(meta.hostSideQuestionError) !== JSON.stringify(expected)) throw Error("Side-question error manifest mismatch");
  }
  if (meta.hostCoworkFolder && !coworkFolderPredecessor)
    throw Error("Native Cowork folder confirmation module missing");
  if (meta.hostCoworkComputerUse && !computerUsePredecessor)
    throw Error("Native Cowork computer-use approval module missing");
  if (meta.hostCoworkStart && !coworkStartPredecessor)
    throw Error("Native Cowork start module missing");
  if (meta.hostApi) {
    const preview = serviceAssets.find(({file}) => file === "official-status-preview.html");
    const file = path.join(ui, preview.file);
    const bytes = fs.readFileSync(file);
    if (!bytes.equals(fs.readFileSync(path.join(root, preview.source))))
      throw Error("Owned status preview source mismatch");
    files.push({path: preview.file, file, bytes: bytes.length, sha256: preview.sha256});
  }
  if (serviceAssets.some(({ file }) => !files.some(row => row.path === file))) throw Error("Owned service asset missing");
  if (meta.hostChatQueue && !chatQueuePredecessor) throw Error("Shared Chat queue module missing");
  const beforeSkillInvocation = files.map(row => {
    const predecessor = skillInvocationPredecessors.get(row.path) ??
      (row.path === "assets/v1/" + hostCoworkFolderFile ? coworkFolderPredecessor : undefined) ??
      (row.path === "assets/v1/" + hostCoworkStartFile ? coworkStartPredecessor : undefined) ??
      sessionKnowledgePredecessors.get(row.path) ??
      (row.path === "assets/v1/" + hostCoworkComputerUseFile ? computerUsePredecessor : undefined) ??
      (meta.hostApi && row.path.startsWith("assets/v1/") && Object.hasOwn(hostApiInputHashes, path.basename(row.path)) ? hostApiInputHashes[path.basename(row.path)] : undefined) ??
      codeModePredecessors.get(row.path) ?? projectWorkspacePredecessors.get(row.path) ??
      (row.path === "assets/v1/" + chatQueueModule ? chatQueuePredecessor : undefined) ?? unifiedChatPredecessors.get(row.path);
    return predecessor ? {...row, sha256: predecessor} : row;
  });
  if (meta.hostLegacyQuoteIdentity) verifyOfficialLegacyQuoteIdentityManifest(meta.hostLegacyQuoteIdentity, beforeSkillInvocation);
  const beforeIncognitoUploads = beforeSkillInvocation.map(row => incognitoUploadPredecessors.has(row.path)
    ? {...row, sha256: incognitoUploadPredecessors.get(row.path)} : row);
  const beforeLegacyFiles = meta.hostLegacyQuoteIdentity ? beforeIncognitoUploads.map(row => row.path === "assets/v1/" + legacyQuoteIdentityTarget ? {...row, sha256: legacyQuoteIdentityInputSha256} : row) : beforeIncognitoUploads;
  if (meta.hostChatStarReconcile) {
    // The prior transform still validates its exact intermediate output; the
    // final bytes above and the new manifest below remain separately checked.
    const priorFiles = meta.hostEditRetry ? beforeLegacyFiles.map(row => row.path === "assets/v1/" + editRetryMain ? {...row, sha256: expectedEditRetryInputs.get(editRetryMain)} : row) : beforeLegacyFiles;
    verifyOfficialChatStarReconcileManifest(meta.hostChatStarReconcile, priorFiles, expectedChatStarOutput);
  }
  const preStopFiles = meta.hostStopFeedback ? beforeLegacyFiles.map(row => expectedStopFeedbackInputs.has(row.path.slice("assets/v1/".length)) ? {...row, sha256: expectedStopFeedbackInputs.get(row.path.slice("assets/v1/".length))} : row) : beforeLegacyFiles;
  const priorModelPreferenceFiles = meta.hostModelPreferenceFeedback ? preStopFiles.map(row => row.path === "assets/v1/" + modelPreferenceFeedbackTarget ? {...row, sha256: expectedModelPreferenceFeedbackInput} : row) : preStopFiles;
  const priorRegenerationFiles = meta.hostRegenerationError ? priorModelPreferenceFiles.map(row => row.path === "assets/v1/" + regenerationErrorTarget ? {...row, sha256: expectedRegenerationInput} : row) : priorModelPreferenceFiles;
  const priorElicitationFiles = meta.hostCodeElicitation ? priorRegenerationFiles.map(row => {
    const name = row.path.startsWith("assets/v1/") ? row.path.slice("assets/v1/".length) : "";
    return hostCodeElicitationFiles.includes(name) && Object.hasOwn(expectedEditRetryOutputs, name)
      ? {...row, sha256: expectedEditRetryOutputs[name]} : row;
  }) : priorRegenerationFiles;
  if (meta.hostEditRetry) verifyOfficialEditRetryManifest(meta.hostEditRetry, priorElicitationFiles, expectedEditRetryOutputs);
  if (meta.hostRegenerationError) verifyOfficialRegenerationErrorManifest(meta.hostRegenerationError, preStopFiles, expectedRegenerationOutput);
  const preModelCatalogFiles = meta.hostModelCatalogState ? beforeLegacyFiles.map(row => {
    const name = row.path.startsWith("assets/v1/") ? row.path.slice("assets/v1/".length) : "";
    return Object.hasOwn(modelCatalogStateInputHashes, name) ? {...row, sha256: modelCatalogStateInputHashes[name]} : row;
  }) : beforeLegacyFiles;
  if (meta.hostStopFeedback) verifyOfficialStopFeedbackManifest(meta.hostStopFeedback, preModelCatalogFiles, expectedStopFeedbackOutputs);
  if (meta.hostChatSearchReadiness) verifyOfficialChatSearchReadinessManifest(meta.hostChatSearchReadiness, beforeSkillInvocation, expectedChatSearchReadinessOutput);
  if (meta.hostModelPreferenceFeedback) {
    const preferenceFiles = meta.hostMemoryControls ? beforeSkillInvocation.map(row => row.path === "assets/v1/" + modelPreferenceFeedbackTarget
      ? {...row, sha256: hostMemoryControlsInputHashes[modelPreferenceFeedbackTarget]} : row) : beforeSkillInvocation;
    verifyOfficialModelPreferenceFeedbackManifest(meta.hostModelPreferenceFeedback, preferenceFiles, expectedModelPreferenceFeedbackOutput);
  }
  if (meta.hostReplyFeedbackSettlement) verifyOfficialReplyFeedbackSettlementManifest(meta.hostReplyFeedbackSettlement, beforeSkillInvocation, expectedReplyFeedbackSettlementOutput);
  if (meta.hostHub && !files.some(row => row.path === "assets/v1/" + hostHubResources.localEntry)) throw Error("Pinned local Hub alias missing");
  if (meta.hostUsage && !files.some(row => row.path === 'assets/v1/claudex-host-usage.js')) throw Error('Owned usage view missing');
  for (const asset of expectedUsageActivity.keys()) if (!files.some(row => row.path === asset)) throw Error("Owned Usage Activity asset missing: " + asset);
  if(meta.hostStaticPreview && !files.some(row=>row.path==='assets/v1/claudex-host-artifact-publishing.js'))throw Error('Owned publishing status control missing');
  if(meta.hostStaticPreview && !files.some(row=>row.path==='assets/v1/claudex-host-static-preview.js'))throw Error('Owned static preview control missing');
  if(meta.hostMemoryStatus && !files.some(row=>row.path==='assets/v1/claudex-host-memory-status.js'))throw Error('Owned memory status control missing');
  if(meta.hostProjectKnowledge && !files.some(row=>row.path==='assets/v1/claudex-host-project-knowledge-error.js'))throw Error('Owned project knowledge error control missing');
  if (meta.hostAuth) {
    const actual = meta.hostAuth.modules;
    const names = Object.keys(hostAuthSourceHashes);
    if (!Array.isArray(actual) || actual.length !== names.length)
      throw Error("Host auth manifest shape mismatch.");
    for (const name of names) {
      const records = actual.filter((row) => row.file === name),
        record = records[0];
      if (
        records.length !== 1 ||
        record.originalSha256 !== hostAuthSourceHashes[name] ||
        record.outputSha256 !== expectedHostAuth.get(name) ||
        JSON.stringify(record.rules) !==
          JSON.stringify(
            hostAuthRules
              .filter((rule) => rule.file === name)
              .map((rule) => rule.name),
          )
      )
        throw Error("Host auth manifest derivation mismatch: " + name);
    }
  }
  if (meta.hostCapabilities) {
    const actual = meta.hostCapabilities.modules;
    const names = Object.keys(hostCapabilityInputHashes);
    if (!Array.isArray(actual) || actual.length !== names.length)
      throw Error("Host capability manifest shape mismatch.");
    for (const name of names) {
      const records = actual.filter((row) => row.file === name);
      const record = records[0];
      const output = expectedCapabilities.get(name);
      if (
        records.length !== 1 ||
        record.originalSha256 !== hostCapabilityOriginalHashes[name] ||
        record.inputSha256 !== hostCapabilityInputHashes[name] ||
        record.outputSha256 !== output ||
        JSON.stringify(record.rules) !==
          JSON.stringify(
            hostCapabilityRules
              .filter((rule) => rule.file === name)
              .map((rule) => rule.name),
          )
      )
        throw Error("Host capability manifest derivation mismatch: " + name);
    }
  }
  for (const [manifest, hashes, rules, originalHashes, outputs] of [
    [
      meta.hostCompletion,
      hostCompletionSourceHashes,
      hostCompletionRules,
      hostCompletionSourceHashes,
      expectedCompletion,
    ],
    [meta.hostUserContent, hostUserContentHashes, hostUserContentRules, hostUserContentHashes, expectedUserContent],
    [meta.hostSubscription, hostSubscriptionInputHashes, hostSubscriptionRules, hostSubscriptionOriginalHashes, null],
    [meta.hostDirectorySubmissions, hostDirectorySubmissionsInputHashes, hostDirectorySubmissionsRules, hostDirectorySubmissionsOriginalHashes, null],
    [meta.hostInstalledPlugins, hostInstalledPluginsInputHashes, hostInstalledPluginsRules, hostInstalledPluginsOriginalHashes, expectedInstalledPlugins],
    [meta.hostSkillSearch, hostSkillSearchInputHashes, hostSkillSearchRules, hostSkillSearchOriginalHashes, null],
    [meta.hostCodeCapability, hostCodeCapabilityInputHashes, hostCodeCapabilityRules, hostCodeCapabilityOriginalHashes, null],
    [meta.hostCodeConnectorMenu, hostCodeConnectorMenuInputHashes, hostCodeConnectorMenuRules, hostCodeConnectorMenuOriginalHashes, null],
    [meta.hostCodeAppScope, hostCodeAppScopeInputHashes, hostCodeAppScopeRules, hostCodeAppScopeOriginalHashes, null],
    [meta.hostWorkspaceTrust, hostWorkspaceTrustInputHashes, hostWorkspaceTrustRules, hostWorkspaceTrustOriginalHashes, null],
    [meta.hostFeedbackOutcome, hostFeedbackOutcomeInputHashes, hostFeedbackOutcomeRules, hostFeedbackOutcomeOriginalHashes, expectedFeedbackOutcome],
    [meta.hostCodeFeedback, hostCodeFeedbackInputHashes, hostCodeFeedbackRules, hostCodeFeedbackOriginalHashes, null],
    [meta.hostIncognitoLifecycle, hostIncognitoLifecycleInputHashes, hostIncognitoLifecycleRules, hostIncognitoLifecycleOriginalHashes, null],
    [meta.hostProjectMove, hostProjectMoveInputHashes, hostProjectMoveRules, hostProjectMoveOriginalHashes, null],
    [meta.hostConnectorLimit, hostConnectorLimitInputHashes, hostConnectorLimitRules, hostConnectorLimitOriginalHashes, null],
    [meta.hostLaunchDraft, hostLaunchDraftInputHashes, hostLaunchDraftRules, hostLaunchDraftOriginalHashes, null],
    [meta.hostCodeTakeback, hostCodeTakebackInputHashes, hostCodeTakebackRules, hostCodeTakebackOriginalHashes, null],
    [meta.hostModelCatalogState, modelCatalogStateInputHashes, modelCatalogStateRules, modelCatalogStateOriginalHashes, null],
    [meta.hostCodeError, hostCodeErrorInputHashes, hostCodeErrorRules, hostCodeErrorOriginalHashes, null],
    [meta.hostListUpdates, hostListUpdatesInputHashes, hostListUpdatesRules, hostListUpdatesOriginalHashes, null],
    [meta.hostMemoryStatus, hostMemoryStatusInputHashes, hostMemoryStatusRules, hostMemoryStatusOriginalHashes, null],
    [meta.hostMemoryControls, hostMemoryControlsInputHashes, hostMemoryControlsRules, hostMemoryControlsOriginalHashes, null],
    [meta.hostMemoryContext, hostMemoryContextInputHashes, hostMemoryContextRules, hostMemoryContextOriginalHashes, null],
    [meta.hostBrowserSettings, hostBrowserSettingsInputHashes, hostBrowserSettingsRules, hostBrowserSettingsOriginalHashes, null],
    [meta.hostProjectKnowledge, hostProjectKnowledgeInputHashes, hostProjectKnowledgeRules, hostProjectKnowledgeOriginalHashes, null],
    [meta.hostStaticPreview, hostStaticPreviewInputHashes, hostStaticPreviewRules, hostStaticPreviewOriginalHashes, null],
    [meta.hostSecurity, hostSecurityInputHashes, hostSecurityRules, hostSecurityOriginalHashes, null],
    [meta.hostApi, hostApiInputHashes, hostApiRules, hostApiOriginalHashes, null],
    [
      meta.hostUsage,
      hostUsageInputHashes,
      hostUsageRules,
      hostUsageOriginalHashes,
      null,
    ],
  ]) {
    if (!manifest) continue;
    const names = Object.keys(hashes);
    if (
      !Array.isArray(manifest.modules) ||
      manifest.modules.length !== names.length
    )
      throw Error("Host manifest count mismatch");
    for (const name of names) {
      const records = manifest.modules.filter((row) => row.file === name),
        r = records[0];
      const output = manifest === meta.hostApi ? codeModePredecessors.get("assets/v1/" + name) ?? projectWorkspacePredecessors.get("assets/v1/" + name) ?? unifiedChatPredecessors.get("assets/v1/" + name) ?? files.find((row) => row.path === "assets/v1/" + name)?.sha256
        : meta.hostMemoryContext && (manifest === meta.hostMemoryControls || manifest === meta.hostUsage) && Object.hasOwn(hostMemoryContextInputHashes, name)
        ? hostMemoryContextInputHashes[name]
        : outputs
        ? outputs.get(name)
        : manifest === meta.hostModelCatalogState
          ? expectedModelCatalogState.get(name)
        : manifest === meta.hostCodeTakeback
          ? expectedCodeTakeback.get(name)
        : meta.hostSideQuestionError && manifest === meta.hostSubscription && name === sideQuestionErrorTarget
          ? sideQuestionErrorInputSha256
        : meta.hostModelCatalogState && manifest === meta.hostSubscription && Object.hasOwn(modelCatalogStateInputHashes, name)
          ? modelCatalogStateInputHashes[name]
        : meta.hostConnectorLimit && manifest === meta.hostProjectMove && Object.hasOwn(hostConnectorLimitInputHashes, name)
          ? hostConnectorLimitInputHashes[name]
        : meta.hostProjectMove && manifest === meta.hostIncognitoLifecycle && Object.hasOwn(hostProjectMoveInputHashes, name)
          ? hostProjectMoveInputHashes[name]
          : meta.hostCodeTakeback && manifest === meta.hostLaunchDraft && Object.hasOwn(hostCodeTakebackInputHashes, name)
            ? hostCodeTakebackInputHashes[name]
          : meta.hostLaunchDraft && manifest === meta.hostWorkspaceTrust && Object.hasOwn(hostLaunchDraftInputHashes, name)
            ? hostLaunchDraftInputHashes[name]
            : beforeIncognitoUploads.find((row) => row.path === "assets/v1/" + name)?.sha256;
      if (
        records.length !== 1 ||
        r.originalSha256 !== originalHashes[name] ||
        ((!outputs || manifest === meta.hostFeedbackOutcome || manifest === meta.hostInstalledPlugins) && r.inputSha256 !== hashes[name]) ||
        r.outputSha256 !== output ||
        JSON.stringify(r.rules) !==
          JSON.stringify(
            rules.filter((x) => x.file === name).map((x) => x.name),
          )
      )
        throw Error("Host manifest derivation mismatch: " + name);
    }
  }
  const images = JSON.parse(
    fs.readFileSync(
      path.join(root, "docs/official-ui-static-assets.json"),
      "utf8",
    ),
  );
  for (const image of images.assets) {
    const row = files.find((f) => "/" + f.path === image.path);
    const brandSource = officialBrandImages[image.path.slice(1)];
    if (!row || (brandSource
      ? !fs.readFileSync(row.file).equals(fs.readFileSync(path.join(root, brandSource)))
      : row.sha256 !== image.sha256))
      throw Error("Pinned image checksum mismatch: " + image.path);
  }
  const documentKey = "claude-frontend-4.4212.0/src/cloud/index.html";
  const documentRecord = original.get(documentKey);
  const originalDocument = fs.readFileSync(path.join(extracted, documentKey));
  if (!documentRecord || sha(originalDocument) !== documentRecord.sha256)
    throw Error("Pinned document source checksum mismatch.");
  let expectedDocument = brandedOfficialDocument(originalDocument.toString("utf8"));
  for (const name of fs
    .readdirSync(path.join(ui, "i18n"))
    .filter((name) => name.endsWith(".json"))) {
    const locale = name.slice(0, -5),
      shortFile = path.join(ui, "i18n/s", name),
      dynamicFile = path.join(ui, "i18n/dynamic", name);
    if (fs.existsSync(shortFile) && fs.existsSync(dynamicFile))
      expectedDocument = expectedDocument.replace(
        new RegExp(locale + ":[0-9a-f]+\\.[0-9a-f]+"),
        locale +
          ":" +
          sha(fs.readFileSync(shortFile)).slice(0, 12) +
          "." +
          sha(fs.readFileSync(dynamicFile)).slice(0, 12),
      );
  }
  const assembledDocument = fs.readFileSync(
    path.join(ui, "index.html"),
    "utf8",
  );
  if (assembledDocument !== expectedDocument)
    throw Error(
      "Official host document differs from its source derivation.",
    );
  const document = assembledDocument.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );
  if (
    !document.includes('data-build-id="79979f1379"') ||
    /<script\b/i.test(document)
  )
    throw Error("Invalid official frame document.");
  // Assembly proofs refer to the shared native assets. Record the Web
  // derivative bytes only after those proofs have been checked.
  for (const file of files) {
    if (!file.content) continue;
    file.bytes = file.content.length;
    file.sha256 = sha(file.content);
  }
  return {
    entry: "/" + meta.entry,
    document,
    files,
    manifest: {
      buildId: meta.buildId,
      archiveSha256: pinnedOfficialArchive,
      source:
        "verified archive; exact authorized host-auth, branding and host-capability derivation",
      hostCapabilities: meta.hostCapabilities ?? null,
      hostAuth: meta.hostAuth ?? null,
      hostCompletion: meta.hostCompletion ?? null,
      hostUsage: meta.hostUsage ?? null,
      hostSubscription: meta.hostSubscription ?? null,
      hostCodeCapability: meta.hostCodeCapability ?? null,
      hostCodeConnectorMenu: meta.hostCodeConnectorMenu ?? null,
      hostCodeAppScope: meta.hostCodeAppScope ?? null,
      hostWorkspaceTrust: meta.hostWorkspaceTrust ?? null,
      hostFeedbackOutcome: meta.hostFeedbackOutcome ?? null,
      hostCodeFeedback: meta.hostCodeFeedback ?? null,
      hostChatStarReconcile: meta.hostChatStarReconcile ?? null,
      hostEditRetry: meta.hostEditRetry ?? null,
      hostRegenerationError: meta.hostRegenerationError ?? null,
      hostStopFeedback: meta.hostStopFeedback ?? null,
      hostChatSearchReadiness: meta.hostChatSearchReadiness ?? null,
      hostModelPreferenceFeedback: meta.hostModelPreferenceFeedback ?? null,
      hostModelCatalogState: meta.hostModelCatalogState ?? null,
      hostChatQueue: meta.hostChatQueue ?? null,
      unifiedChat: true,
      hostIncognitoLifecycle: meta.hostIncognitoLifecycle ?? null,
      hostLaunchDraft: meta.hostLaunchDraft ?? null,
      hostCodeTakeback: meta.hostCodeTakeback ?? null,
      hostCodeError: meta.hostCodeError ?? null,
      hostListUpdates: meta.hostListUpdates ?? null,
      hostReplyFeedbackSettlement: meta.hostReplyFeedbackSettlement ?? null,
      hostSideQuestionError: meta.hostSideQuestionError ?? null,
      hostCodeElicitation: meta.hostCodeElicitation ?? null,
      hostCoworkProject: meta.hostCoworkProject ?? null,
      hostExtensionPreview: meta.hostExtensionPreview ?? null,
      hostSessionExport: meta.hostSessionExport ?? null,
      hostRoutineFire: meta.hostRoutineFire ?? null,
      hostResearchSources: meta.hostResearchSources ?? null,
      hostImportedChatResume: meta.hostImportedChatResume ?? null,
      hostProjectMove: meta.hostProjectMove ?? null,
      hostConnectorLimit: meta.hostConnectorLimit ?? null,
      hostDerivationSet: meta.hostDerivationSet ?? null,
      hostSecurity: meta.hostSecurity ?? null,
      hostStaticPreview: meta.hostStaticPreview ?? null,
      hostProjectKnowledge: meta.hostProjectKnowledge ?? null,
      hostProjectWorkspace: meta.hostProjectWorkspace ?? null,
      hostDirectorySubmissions: meta.hostDirectorySubmissions ?? null,
      hostMemoryStatus: meta.hostMemoryStatus ?? null,
      hostMemoryControls: meta.hostMemoryControls ?? null,
      hostMemoryContext: meta.hostMemoryContext ?? null,
      hostBrowserSettings: meta.hostBrowserSettings ?? null,
      hostApi: meta.hostApi ?? null,
      hostSkillInvocation: meta.hostSkillInvocation ?? null,
      hostCoworkFolder: meta.hostCoworkFolder ?? null,
      hostCoworkStart: meta.hostCoworkStart ?? null,
      hostCoworkComputerUse: meta.hostCoworkComputerUse ?? null,
      hostSessionKnowledge: meta.hostSessionKnowledge ?? null,
      hostWindowManager: meta.hostWindowManager ?? null,
      hostHub: meta.hostHub ?? null,
      verificationScope: {
        publishedAssets:
          "source archive SHA + each module/CSS/binary source hash + exact host derivations + Web document account context",
        localHubResources: meta.hostHub ? "entire supplied static catalogue hash; fixed entry alias and body; unchanged descriptor presence and module/service permission checks; no restored secret" : null,
        ownedHostGlue:
          "isolated reproducible owned Usage Activity bundle (all code, CSS, font, sprite and locale chunks); exact self-authored usage-panel.mjs, memory-status.mjs, project-knowledge-error.mjs static-preview.mjs and artifact-publishing.mjs bytes; not archive source",
        images: "pinned static image manifest SHA",
        document: "source archive hash + exact locale-hash substitution",
        locales:
          "assembled locale output SHA recorded; full translation derivation audit remains separate",
      },
      files: files.map(({ file, content, ...row }) => row),
      unavailableImages: images.unavailable ?? images.failures ?? [],
    },
  };
}


import { applyOfficialUiHostMemoryContext } from "./official-ui-host-memory-context.mjs";
import { applyOfficialUiHostBrowserSettings } from "./official-ui-host-browser-settings.mjs";
import { verifiedBootstrapDefaults } from "./official-ui-bootstrap-defaults.mjs";
import { installOfficialUi } from "./official-ui-install.mjs";
import { verifyOfficialWebAssets } from "./official-web-assets.mjs";
import { verifyPackagedHostWindowManager } from "./official-ui-host-window-manager.mjs";
import { applyUnifiedChat } from "./official-ui-unified-chat.mjs";
import { applyOfficialChatQueue } from "./official-ui-chat-queue.mjs";
import { applyOfficialCodeModes } from "./official-ui-host-code-modes.mjs";
import { desktopBootDocument, desktopBootSource, mainWindowSource } from "./official-ui-desktop-boot.mjs";
import {
  brandedDesktopShell,
  brandedOfficialDocument,
  brandedOfficialLogos,
  brandedQuickWindow,
  officialBrandImages,
} from "./official-ui-branding.mjs";
import { applyOfficialLegacyQuoteIdentity } from "./official-ui-legacy-quote-identity.mjs";
import { applyCjkEmphasis } from "./official-ui-cjk-emphasis.mjs";
import { applyOfficialReplyFeedbackSettlement } from "./official-ui-reply-feedback-settlement.mjs";
import { applyOfficialUiHostListUpdates } from "./official-ui-host-list-updates.mjs";
import {applyOfficialUiUserContent} from "./official-ui-host-usercontent.mjs";
import { applyOfficialUiHostCodeElicitation } from "./official-ui-host-code-elicitation.mjs";
import { applyOfficialUiHostCodeAppScope } from "./official-ui-host-code-app-scope.mjs";
import { applyOfficialUiCoworkComputerUse, applyOfficialUiCoworkFolder, applyOfficialUiCoworkStart, applyOfficialUiHostCoworkProject } from "./official-ui-host-cowork-project.mjs";
import { applyOfficialUiHostExtensionPreview } from "./official-ui-host-extension-preview.mjs";
import { applyOfficialUiHostSessionExport, deriveOfficialUiSessionTransferPreload } from "./official-ui-host-session-export.mjs";
import { applyOfficialUiHostResearchSources } from "./official-ui-host-research-sources.mjs";
import { applyOfficialUiHostMemoryControls } from "./official-ui-host-memory-controls.mjs";
import { applyOfficialUiHostSkillInvocation } from "./official-ui-host-skill-invocation.mjs";
import { applyOfficialUiHostRoutineFire } from "./official-ui-host-routine-fire.mjs";
import { applyOfficialUiHostImportedChatResume } from "./official-ui-host-imported-chat.mjs";
import { applySessionKnowledge } from "./official-ui-host-session-knowledge.mjs";
import { applyOfficialUiHostProjectWorkspace, hostProjectWorkspaceAsset } from "./official-ui-host-project-workspace.mjs";
import {
  deriveSupportBundleCopy,
  supportBundleAsset,
  supportBundleLogLabel,
  supportBundleLogMessage,
} from "./official-ui-support-bundle-copy.mjs";
import {
  derivePrivacyExportCopy,
  privacyExportAsset,
  privacyExportChinese,
} from "./official-ui-privacy-export.mjs";
import {
  derivePrivacyControls,
  privacyControlsAsset,
  privacyControlsChinese,
} from "./official-ui-privacy-controls.mjs";
// Assembles build/official-ui/ from the recovered official front-end project
// (docs/official-ui-client.md): the built page and its published modules, the
// official preload and window manager, the native IPC contract, the protobuf
// protocol and the flag defaults the client's API adapter starts from.
//   node scripts/build-official-ui.mjs [--no-build]
// CLAUDEX_OFFICIAL_UI_SOURCE names the project (default ../claude-frontend-4.4212.0).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { installOfficialQuickAccessAddon } from "./official-quick-access-resource.mjs";

// Bind all cwd-relative inputs and outputs to this script's own project.
// This must run before loading project modules or inspecting recovered sources.
const buildProjectRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const buildWorkingRoot = fs.realpathSync(process.cwd());
if (buildWorkingRoot !== buildProjectRoot)
  throw new Error("Official UI assembly refused: run from the project root containing this build script.");

const { applyOfficialSideQuestionError } = await import("./official-ui-side-question-error.mjs");
const { applyOfficialIncognitoUploads } = await import("./official-ui-incognito-uploads.mjs");
const { applyOfficialUiHostIncognitoLifecycle } = await import("./official-ui-host-incognito-lifecycle.mjs");
const { applyOfficialUiHostProjectMove } = await import("./official-ui-host-project-move.mjs");
const { applyOfficialUiHostConnectorLimit } = await import("./official-ui-host-connector-limit.mjs");
const { applyOfficialUiHostLaunchDraft } = await import("./official-ui-host-launch-draft.mjs");
const { applyOfficialUiHostCodeTakeback } = await import("./official-ui-host-code-takeback.mjs");
const { applyOfficialUiHostCodeError } = await import("./official-ui-host-code-error.mjs");
const { applyOfficialUiHostFeedbackOutcome } = await import("./official-ui-host-feedback-outcome.mjs");
const { applyOfficialChatStarReconcile } = await import("./official-ui-chat-star-reconcile.mjs");
const { applyOfficialEditRetry } = await import("./official-ui-edit-retry.mjs");
const { applyOfficialRegenerationError } = await import("./official-ui-regeneration-error.mjs");
const { applyOfficialStopFeedback } = await import("./official-ui-stop-feedback.mjs");
const { applyOfficialChatSearchReadiness } = await import("./official-ui-chat-search-readiness.mjs");
const { applyOfficialModelPreferenceFeedback } = await import("./official-ui-model-preference-feedback.mjs");
const { applyOfficialModelCatalogState } = await import("./official-ui-model-catalog-state.mjs");
const { applyOfficialUiHostCodeFeedback } = await import("./official-ui-host-code-feedback.mjs");
const { applyOfficialUiHostWorkspaceTrust } = await import("./official-ui-host-workspace-trust.mjs");
const { applyOfficialUiHostCodeCapability } = await import("./official-ui-host-code-capability.mjs");
const { applyOfficialUiHostCodeConnectorMenu } = await import("./official-ui-host-code-connector-menu.mjs");
const { applyOfficialUiHostSkillSearch } = await import("./official-ui-host-skill-search.mjs");
const { applyOfficialUiHostDirectorySubmissions } = await import("./official-ui-host-directory-submissions.mjs");
const { applyOfficialUiHostInstalledPlugins } = await import("./official-ui-host-installed-plugins.mjs");
const { buildOfficialUsageActivity } = await import("./official-ui-usage-activity-bundle.mjs");
const { assembleOfficialLocales } = await import("./official-ui-locales.mjs");
const { applyOfficialUiHostCapabilities } = await import("./official-ui-host-capabilities.mjs");
const { applyOfficialUiHostAuth } = await import("./official-ui-host-auth.mjs");
const { applyOfficialUiHostCompletion } = await import("./official-ui-host-completion.mjs");
const { applyOfficialUiHostUsage, hostUsageAssets } = await import("./official-ui-host-usage.mjs");
const { applyOfficialUiHostApi, hostApiAssets } = await import("./official-ui-host-api.mjs");
const { applyOfficialUiHostSecurity } = await import("./official-ui-host-security.mjs");
const { applyOfficialUiHostStaticPreview } = await import("./official-ui-host-static-preview.mjs");
const { applyOfficialUiHostMemoryStatus } = await import("./official-ui-host-memory-status.mjs");
const { applyOfficialUiHostProjectKnowledge } = await import("./official-ui-host-project-knowledge.mjs");
const { applyOfficialUiHostSubscription } = await import("./official-ui-host-subscription.mjs");
const { applyOfficialUiHostHub } = await import("./official-ui-host-hub.mjs");
const { applyOfficialHostWindowManager } = await import("./official-ui-host-window-manager.mjs");

const source = path.resolve(
  process.env.CLAUDEX_OFFICIAL_UI_SOURCE ?? "../claude-frontend-4.4212.0",
);
if (!fs.existsSync(path.join(source, "package.json")))
  throw new Error(`No recovered front-end project at ${source}`);
const archive = process.env.CLAUDEX_OFFICIAL_ARCHIVE ?? path.join(buildProjectRoot, ".restore/handoff-source.tar.gz");
const bootstrapDefaults = verifiedBootstrapDefaults(source, archive);
const usercontentSource = path.join(source, "src/usercontent");
if (!fs.existsSync(path.join(usercontentSource, "manifest.json")))
  throw Error("The recovered user-content renderer is missing; capture its pinned resources first.");
const buildRoot = path.resolve("build");
fs.mkdirSync(buildRoot, { recursive: true });
const stage = fs.mkdtempSync(path.join(buildRoot, ".official-ui-assembly-"));
const out = path.join(stage, "official-ui");
const userContent = path.join(stage, "official-usercontent");
try {
fs.cpSync(usercontentSource, userContent, {recursive:true});
fs.copyFileSync(path.join(buildProjectRoot, "electron/official-ui/assets/mcp_apps.html"), path.join(userContent, "mcp_apps.html"));
const previewManifest=JSON.parse(fs.readFileSync(path.join(userContent,"manifest.json"),"utf8"));
if(!previewManifest.pdfRuntime)
  execFileSync(process.execPath,[path.resolve('scripts/capture-official-pdf-resources.mjs'),userContent],{stdio:'inherit'});
if (!process.argv.includes("--no-build"))
  execFileSync("npm", ["run", "build"], { cwd: source, stdio: "inherit" });

const copyTree = (from, to, skip = () => false) => {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const rel = path.relative(source, src);
    if (skip(rel, entry)) continue;
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTree(src, dest, skip);
    } else if (entry.isFile()) fs.copyFileSync(src, dest);
    else throw Error(`Unsupported source entry: ${src}`);
  }
};
// The page: source maps and the bundled-renderer variant stay out of the client.
fs.mkdirSync(path.join(out, "ui"), { recursive: true });
copyTree(
  path.join(source, "dist"),
  path.join(out, "ui"),
  (rel, entry) =>
    (entry.isFile() && rel.endsWith(".map")) || rel === "dist/desktop",
);
// Verify the untouched supplied catalogue before any host/branding derivation.
const hostHub = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostHub(path.join(out, "ui/assets/v1"));
// Reuse the pinned image cache before the preparer considers downloading.
// prepare-official-preview-assets still validates every expected image hash.
const imageCache = path.resolve("build/official-static-assets/images");
if (fs.existsSync(imageCache))
  fs.cpSync(imageCache, path.join(out, "ui/images"), { recursive: true });
execFileSync(process.execPath,[path.resolve('scripts/prepare-official-preview-assets.mjs'),out],{stdio:'inherit'});
for (const [file, source] of Object.entries(officialBrandImages))
  fs.copyFileSync(path.join(buildProjectRoot, source), path.join(out, "ui", file));
// The official preload (the desktop client's own file) and its window manager.
fs.mkdirSync(path.join(out, "host"), { recursive: true });
fs.copyFileSync(
  path.join(source, "electron/official-preload.cjs"),
  path.join(out, "host", "official-preload.cjs"),
);
fs.mkdirSync(path.join(out, "main-window"));
copyTree(path.join(source, mainWindowSource), path.join(out, "main-window"));
const mainShell = path.join(out, "main-window/assets/MainWindowPage-DTApdGAL.js");
fs.writeFileSync(mainShell, brandedDesktopShell(fs.readFileSync(mainShell, "utf8")));
fs.copyFileSync(
  path.join(source, "reference/desktop-main/mainWindow.js"),
  path.join(out, "host", "main-window-preload.cjs"),
);
fs.mkdirSync(path.join(out, "quick-window"));
copyTree(path.join(source, "src/cloud/desktop/quick_window"), path.join(out, "quick-window"));
const quickWindow = path.join(out, "quick-window/quick-window.html");
fs.writeFileSync(quickWindow, brandedQuickWindow(fs.readFileSync(quickWindow, "utf8")));
fs.copyFileSync(
  path.join(source, "reference/desktop-main/quickWindow.js"),
  path.join(out, "host", "quick-window-preload.cjs"),
);
installOfficialQuickAccessAddon(out, process.env.CLAUDEX_OFFICIAL_QUICK_ACCESS_ADDON);
// The window manager is one official module with its own chunk beside it.
for (const name of fs.readdirSync(path.join(source, "electron/recovered")))
  if (/\.(?:c?js|json)$/.test(name))
    fs.copyFileSync(
      path.join(source, "electron/recovered", name),
      path.join(out, "host", name),
    );
const hostWindowManager = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialHostWindowManager(path.join(out, "host"));
// Claudex's own page shim (electron/official-ui/page-shim.cjs), loaded beside the official preload.
fs.copyFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "../electron/official-ui/page-shim.cjs"),
  path.join(out, "host", "claudex-shim.cjs"),
);
// Contracts and protocol recovered from the build.
fs.mkdirSync(path.join(out, "data"), { recursive: true });
for (const [file, name] of [
  ["recovery/native-ipc-contract.json", "native-ipc-contract.json"],
  ["recovery/conversation-protocol.json", "conversation-protocol.json"],
  ["recovery/official-display-settings.json", "display-settings.json"],
  ["src/cloud/development/official-capabilities.json", "capabilities.json"],
  ["recovery/official-live-document.json", "build.json"],
])
  fs.copyFileSync(path.join(source, file), path.join(out, "data", name));
// The product name in the string catalogs (owner, 2026-10-31: only the i18n
// data changes, never the modules). Later explicit owner authorization on
// 2026-11-02 permits the separately pinned host-capability derivation below.
// "Claude Code" keeps its second word.
const renames = [
  [/\bclaude\.ai\b/g, "Claudex"],
  [/\bAnthropic\b/g, "Claudex"],
  [/\bClaude\b/g, "Claudex"],
];
// Only the pinned, sanitized handoff defaults are used; local captures are never packaged.
fs.writeFileSync(path.join(out, "data", "bootstrap-defaults.json"), bootstrapDefaults);
let renamed = 0;
assembleOfficialLocales(source, out);
const i18nDir = path.join(out, "ui", "i18n");
const walkJson = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkJson(path.join(dir, e.name)) : e.name.endsWith(".json") ? [path.join(dir, e.name)] : []));
for (const file of walkJson(i18nDir)) {
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  if (file === path.join(i18nDir, "zh-Hans.json")) {
    Object.assign(catalog, privacyExportChinese, privacyControlsChinese);
    catalog["2EP78YSv/i"] ??= "报告仅包含系统信息及近期的警告和错误日志。日志可能引用文件、消息或工具输出中的片段，也可能提到文件、文件夹、对话和任务的名称。可识别格式的邮箱地址和访问令牌等信息会被遮盖。请在分享前检查报告内容。";
  }
  if (Object.hasOwn(catalog, supportBundleLogMessage)) {
    const locale = path.basename(file, ".json");
    const language = locale === "zh-Hans" ? "zh-CN" : locale;
    const translation = new URL(`../shared/i18n/catalogs/${language}.ts`, import.meta.url);
    catalog[supportBundleLogMessage] = fs.existsSync(translation)
      ? (await import(translation.href)).default[supportBundleLogLabel] ?? supportBundleLogLabel
      : supportBundleLogLabel;
  }
  const visit = (value) => {
    if (typeof value === "string") {
      let next = value;
      for (const [pattern, replacement] of renames) next = next.replace(pattern, replacement);
      if (next !== value) renamed += 1;
      return next;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]));
    return value;
  };
  fs.writeFileSync(file, JSON.stringify(visit(catalog)) + "\n");
}
// English has no catalog: its strings are the modules' own defaultMessage
// literals. Only the text inside those literals changes; ids and code do not.
let renamedLiterals = 0, renamedFiles = 0;
const literal = /(defaultMessage:\s*)("(?:[^"\\\n]|\\.)*")/g;
const modulesDir = path.join(out, "ui", "assets", "v1");
// Independent genuine host session routing; full raw hashes checked before branding.
const hostAuth = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostAuth(modulesDir);
const hostUserContent = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0" ? null : applyOfficialUiUserContent(modulesDir);
const hostCompletion = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCompletion(modulesDir);
for (const name of fs.readdirSync(modulesDir)) {
  if (!name.endsWith(".js")) continue;
  const file = path.join(modulesDir, name);
  const text = fs.readFileSync(file, "utf8");
  const branded = brandedOfficialLogos(name, text);
  if (branded === text && !/defaultMessage|"Claude(?: Code| Nest)?"/.test(text)) continue;
  let changed = 0;
  let next = branded.replace(literal, (match, prefix, quoted) => {
    let value = JSON.parse(quoted);
    for (const [pattern, replacement] of renames) value = value.replace(pattern, replacement);
    const encoded = JSON.stringify(value);
    if (encoded !== quoted) changed += 1;
    return prefix + encoded;
  });
  // Whole-string product names outside default messages (site name, mention
  // label, "Read by Claude" fallback, window title): the exact literals only,
  // never a substring, never a message id.
  next = next.replace(/(?<!id: )"Claude( Code| Nest)?"/g, (match, suffix) => {
    changed += 1;
    return `"Claudex${suffix ?? ""}"`;
  });
  if (next !== text) {
    fs.writeFileSync(file, next);
    renamedLiterals += changed;
    renamedFiles += 1;
  }
}
console.log(`product name: ${renamed} catalog strings renamed, ${renamedLiterals} module literals in ${renamedFiles} modules`);
const supportBundleModule = path.join(modulesDir, supportBundleAsset);
fs.writeFileSync(supportBundleModule, deriveSupportBundleCopy(fs.readFileSync(supportBundleModule, "utf8")));
const privacyExportModule = path.join(modulesDir, privacyExportAsset);
fs.writeFileSync(privacyExportModule, derivePrivacyExportCopy(fs.readFileSync(privacyExportModule, "utf8")));
const privacyControlsModule = path.join(modulesDir, privacyControlsAsset);
fs.writeFileSync(privacyControlsModule, derivePrivacyControls(fs.readFileSync(privacyControlsModule, "utf8")));
// Minimal reversible host capability repair; source archive and recovered modules stay immutable.
const hostCapabilities = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCapabilities(modulesDir);
const hostMemoryStatus = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostMemoryStatus(modulesDir);
if(hostMemoryStatus) {
 const source="scripts/official-host/memory-status.mjs", bytes=fs.readFileSync(path.resolve(source));
 fs.copyFileSync(path.resolve(source),path.join(modulesDir,"claudex-host-memory-status.js"));
 hostMemoryStatus.ownedFiles=[{file:"assets/v1/claudex-host-memory-status.js",source,sha256:createHash("sha256").update(bytes).digest("hex")}];
}
const hostProjectKnowledge = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostProjectKnowledge(modulesDir);
if(hostProjectKnowledge) {
 const source="scripts/official-host/project-knowledge-error.mjs", bytes=fs.readFileSync(path.resolve(source));
 fs.copyFileSync(path.resolve(source),path.join(modulesDir,"claudex-host-project-knowledge-error.js"));
 hostProjectKnowledge.ownedFiles=[{file:"assets/v1/claudex-host-project-knowledge-error.js",source,sha256:createHash("sha256").update(bytes).digest("hex")}];
}
const hostStaticPreview = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostStaticPreview(modulesDir);
if(hostStaticPreview) {
 hostStaticPreview.ownedFiles=["static-preview","artifact-publishing"].map(name=>{
  const source="scripts/official-host/"+name+".mjs", bytes=fs.readFileSync(path.resolve(source));
  const file="assets/v1/claudex-host-"+name+".js";
  fs.copyFileSync(path.resolve(source),path.join(modulesDir,"claudex-host-"+name+".js"));
  return {file,source,sha256:createHash("sha256").update(bytes).digest("hex")};
 });
}
const hostSecurity = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostSecurity(modulesDir);
const hostUsage = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostUsage(modulesDir);
if (hostUsage) {
 hostUsage.activityBundle = await buildOfficialUsageActivity(modulesDir);
 hostUsage.ownedFiles = hostUsageAssets.map(([file, source]) => {
   const bytes = fs.readFileSync(path.resolve(source));
   fs.writeFileSync(path.join(out, "ui", file), bytes);
   return { file, source, sha256: createHash("sha256").update(bytes).digest("hex") };
 });
}
const hostSubscription = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostSubscription(modulesDir);
const hostDirectorySubmissions = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostDirectorySubmissions(modulesDir);
const hostInstalledPlugins = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostInstalledPlugins(modulesDir);
const hostSkillSearch = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostSkillSearch(modulesDir);
const hostCodeCapability = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCodeCapability(modulesDir);
const hostCodeConnectorMenu = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCodeConnectorMenu(modulesDir);
const hostWorkspaceTrust = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostWorkspaceTrust(modulesDir);
const hostFeedbackOutcome = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostFeedbackOutcome(modulesDir);
const hostCodeFeedback = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCodeFeedback(modulesDir);
const hostChatStarReconcile = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialChatStarReconcile(modulesDir);
const hostEditRetry = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialEditRetry(modulesDir);
const hostRegenerationError = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialRegenerationError(modulesDir);
const hostStopFeedback = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialStopFeedback(modulesDir);
const hostChatSearchReadiness = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialChatSearchReadiness(modulesDir);
const hostModelPreferenceFeedback = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialModelPreferenceFeedback(modulesDir);
const hostIncognitoLifecycle = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostIncognitoLifecycle(modulesDir);
const hostLaunchDraft = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostLaunchDraft(modulesDir);
const hostCodeTakeback = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCodeTakeback(modulesDir);
const hostCodeError = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCodeError(modulesDir);
const hostProjectMove = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostProjectMove(modulesDir);
const hostConnectorLimit = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostConnectorLimit(modulesDir);
const hostListUpdates = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostListUpdates(modulesDir);
const hostModelCatalogState = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialModelCatalogState(modulesDir);
const hostReplyFeedbackSettlement = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialReplyFeedbackSettlement(modulesDir);
const hostLegacyQuoteIdentity = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialLegacyQuoteIdentity(modulesDir);
const hostCjkEmphasis = applyCjkEmphasis(modulesDir);
const hostSideQuestionError = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialSideQuestionError(modulesDir);
const hostCodeElicitation = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCodeElicitation(modulesDir);
const hostCoworkProject = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostCoworkProject(modulesDir);
const hostExtensionPreview = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostExtensionPreview(modulesDir);
const hostSessionExport = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostSessionExport(modulesDir, source);
if (hostSessionExport) {
  const preload = path.join(out, "host/official-preload.cjs");
  fs.writeFileSync(preload, deriveOfficialUiSessionTransferPreload(fs.readFileSync(preload, "utf8")));
}
const hostImportedChatResume = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostImportedChatResume(modulesDir);
const hostRoutineFire = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostRoutineFire(modulesDir);
const hostResearchSources = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostResearchSources(modulesDir);
const hostMemoryControls = process.env.CLAUDEX_OFFICIAL_HOST_CAPABILITIES === "0"
  ? null : applyOfficialUiHostMemoryControls(modulesDir);
const hostMemoryContext = hostMemoryControls ? applyOfficialUiHostMemoryContext(modulesDir) : null;
const incognitoUploads = hostIncognitoLifecycle ? applyOfficialIncognitoUploads(modulesDir) : null;
const hostSkillInvocation = hostMemoryControls ? applyOfficialUiHostSkillInvocation(modulesDir) : null;
const hostCodeAppScope = hostCapabilities ? applyOfficialUiHostCodeAppScope(modulesDir) : null;
const hostCoworkFolder = hostCoworkProject ? applyOfficialUiCoworkFolder(modulesDir) : null;
const hostCoworkStart = hostCoworkProject ? applyOfficialUiCoworkStart(modulesDir) : null;
const hostSessionKnowledge = hostCoworkStart ? applySessionKnowledge(modulesDir) : null;
const hostCoworkComputerUse = hostCoworkStart ? applyOfficialUiCoworkComputerUse(modulesDir) : null;
const hostBrowserSettings = hostAuth ? applyOfficialUiHostBrowserSettings(modulesDir) : null;
const hostApi = hostCapabilities ? applyOfficialUiHostApi(modulesDir) : null;
const hostCodeModes = hostCapabilities ? applyOfficialCodeModes(modulesDir) : null;
const hostChatQueue = hostCompletion ? applyOfficialChatQueue(modulesDir) : null;
const hostProjectWorkspace = hostAuth ? applyOfficialUiHostProjectWorkspace(modulesDir) : null;
if (hostProjectWorkspace) {
  fs.copyFileSync(path.resolve(hostProjectWorkspaceAsset.source), path.join(out, "ui", hostProjectWorkspaceAsset.file));
}
if (hostApi) {
  hostApi.ownedFiles = hostApiAssets.map(([file, source]) => {
    fs.copyFileSync(path.resolve(source), path.join(out, "ui", file));
    return { file, source, sha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex") };
  });
}
const unifiedChat = applyUnifiedChat(modulesDir);

// The page caches catalogs by the hashes in the i18n-catalogs meta: renamed
// catalogs get their own hashes so a profile that saw the originals reloads.
{
  const indexFile = path.join(out, "ui", "index.html");
  const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
  // Expand the same collision-safe short-ID aliases the official fallback
  // loader uses (Fl). The recorded page asks /i18n/s/<locale>.json first.
  fs.mkdirSync(path.join(i18nDir, "s"), { recursive: true });
  const locales = fs.readdirSync(i18nDir).filter((name) => name.endsWith(".json"));
  for (const name of locales) {
    const catalog = JSON.parse(fs.readFileSync(path.join(i18nDir, name), "utf8"));
    const short = new Map();
    for (const id of Object.keys(catalog)) if (/^[A-Za-z0-9+/]{10}$/.test(id)) {
      const key = id.slice(0, 6);
      short.set(key, short.has(key) ? null : id);
    }
    for (const [key, id] of short) if (id && !Object.hasOwn(catalog, key)) catalog[key] = catalog[id];
    fs.writeFileSync(path.join(i18nDir, "s", name), JSON.stringify(catalog) + "\n");
  }
  let html = brandedOfficialDocument(fs.readFileSync(indexFile, "utf8"));
  for (const name of locales) {
    const locale = name.slice(0, -5);
    const hash = digest(path.join(i18nDir, "s", name));
    const dynamic = digest(path.join(i18nDir, "dynamic", name));
    html = html.replace(new RegExp(`${locale}:[0-9a-f]+\\.[0-9a-f]+`), `${locale}:${hash}.${dynamic}`);
  }
  fs.writeFileSync(indexFile, html);
  fs.writeFileSync(
    path.join(out, "main-window", "view.html"),
    desktopBootDocument(html, fs.readFileSync(path.join(source, desktopBootSource), "utf8")),
  );
}
const build = JSON.parse(
  fs.readFileSync(path.join(out, "data", "build.json"), "utf8"),
);
fs.writeFileSync(
  path.join(out, "manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source,
      buildId: build.buildId,
      hostCapabilities,
      hostAuth,
      hostUserContent,
      hostCompletion,
      hostUsage,
      hostSubscription,
      hostDirectorySubmissions,
      hostInstalledPlugins,
      hostSkillSearch,
      hostCodeCapability,
      hostCodeConnectorMenu,
      hostCodeAppScope,
      hostWorkspaceTrust,
      hostFeedbackOutcome,
      hostCodeFeedback,
      hostChatStarReconcile,
      hostEditRetry,
      hostRegenerationError,
      hostStopFeedback,
      hostChatSearchReadiness,
      hostModelPreferenceFeedback,
      hostModelCatalogState,
      hostIncognitoLifecycle,
      incognitoUploads,
      hostLaunchDraft,
      hostCodeTakeback,
      hostCodeError,
      hostListUpdates,
      hostReplyFeedbackSettlement,
      hostLegacyQuoteIdentity,
      hostCjkEmphasis,
      hostSideQuestionError,
      hostCodeElicitation,
      hostCoworkProject,
      hostExtensionPreview,
      hostSessionExport,
      hostImportedChatResume,
      hostRoutineFire,
      hostResearchSources,
      hostProjectMove,
      hostConnectorLimit,
      hostDerivationSet: hostCodeFeedback ? "claudex-host-code-feedback-v1" : hostFeedbackOutcome ? "claudex-host-feedback-outcome-v1" : hostWorkspaceTrust ? "claudex-host-workspace-trust-v1" : null,
      hostSecurity,
      hostStaticPreview,
      hostProjectKnowledge,
      hostProjectWorkspace,
      hostMemoryStatus,
      hostMemoryControls,
      hostMemoryContext,
      hostBrowserSettings,
      hostApi,
      hostCodeModes,
      hostChatQueue,
      unifiedChat,
      hostSkillInvocation,
      hostCoworkFolder,
      hostCoworkStart,
      hostSessionKnowledge,
      hostCoworkComputerUse,
      hostWindowManager,
      hostHub,
      entry: build.entry,
      bootstrapDefaults: true,
    },
    null,
    2,
  ) + "\n",
);
verifyPackagedHostWindowManager(out);
verifyOfficialWebAssets(buildProjectRoot, { officialUi: out, userContent });
const publishedFiles = fs.readdirSync(path.join(out, "ui/assets/v1")).length;
installOfficialUi(stage, buildRoot);
for (const name of ["official-ui", "official-usercontent"])
  fs.rmSync(path.join(stage, "previous-" + name), { recursive: true, force: true });
console.log(
  `official-ui assembled: build ${build.buildId}, ${publishedFiles} published files`,
);
} finally {
  // Retain any previous tree if an exceptional rollback itself failed.
  if (!fs.readdirSync(stage).some((name) => name.startsWith("previous-")))
    fs.rmSync(stage, { recursive: true, force: true });
}


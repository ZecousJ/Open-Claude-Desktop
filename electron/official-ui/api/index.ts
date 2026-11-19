import { designArtifactsRoute } from "./design-artifacts";
import { chatPermissionToWire } from "../../../shared/chat-permission-mode";
import { restReplyFeedbackRoute } from "./rest-reply-feedback";
import { nativeCompletionInlineSchema } from "./completion-attachments";
import { createWebSideQuestionRoute } from "./web-side-question";
import { nativeSideQuestionRoute } from "./native-side-question";
import { researchReportFileRoute } from "./research-report-files";
import { researchStatusRoute } from "./research-status";
import { generatedOutputFileRoute } from "./generated-output-files";
import {projectFileAliasRoute} from './project-file-aliases';
import { usageActivityRoute } from "./usage-activity";
import {staticArtifactPreviewRoute} from "./static-artifact-preview";
/**
 * The API adapter: routes every request the official front-end makes to its
 * own origin. Claudex-backed answers first (bootstrap, account, conversations,
 * the timeline stream), then the honest fixtures for what has no Claudex
 * counterpart yet; anything else is 501 so the gap is visible, never silent.
 */
import type http from "node:http";
import { bootstrapRoute } from "./bootstrap";
import { conversationsRoute, loadConversationState } from "./conversations";
import { fixtureRoute } from "./fixtures";
import { createTimelineRpc, deepCreate, registryFor } from "./timeline";
import { toBinary } from "@bufbuild/protobuf";
import { createActionRpc } from "./actions";
import { usageRoute } from "./usage";
import { filesRoute, ensureFileRegistry } from "./files";
import { sharingRoute } from "./sharing";
import { projectsRoute } from "./projects";
import { accountPluginRoute, libraryRoute, skillsRoute } from "./skills";
import { connectorsRoute } from "./connectors";
import { McpAppToolbox, mcpAppToolboxRoute } from "./mcp-app-toolbox";
import { reply, type AdapterContext } from "./context";
import { accountRoute } from "./account";
import { currentAdapterScope, inAdapterScope, newAdapterScope, type AdapterScope } from "./scope";
import { accountOwner, anonymousOwner, guardAdapterContext } from "./scoped-context";
import { migrateLegacyState } from "./migrate-state";
import { memoryRoute } from "./memory";
import { createMelangeRoute } from "./melange";
import { melangePrivacyRoute } from "./melange-privacy";
import { artifactsRoute } from "./artifacts";
import { artifactPublishingRoute } from "./artifact-publishing";
import { pluginReadRoute } from "./plugin-read";
import { pluginOrganizationRead } from "./plugin-organization-read";
import { organizationProjectRoute } from "./organization-projects";
import { skillDownloadRoute } from "./skill-download";
import { approvedDirectoryReadRoute, directoryReadRoute } from "./directory-read";
import { directoryMcpSubmissionsRoute } from "./directory-submissions-mcp";
import { pluginDirectorySubmissionsRoute } from "./directory-submissions-plugin";
import { createRestCompletionRoute } from "./rest-completion";
import { createNativeRestCompletionRoute } from "./native-rest-completion";
import { createRecentsRpc, LIST_RECENTS_PATH } from "./recents";
import { conversationSearchRoute } from "./conversation-search";
import { restConversationLeafRoute } from "./rest-conversation-leaf";
import { hostUsageRoute } from "./host-usage";
import { apiManagementRoute } from "./api-management";
import { serviceStatusRoute } from "./service-status";
import { announcementsRoute } from "./announcements";
import { dispatchRoute } from "./dispatch";
import { zecousMigrationRoute } from "./zecous-migration";
import { emptyChatRoute } from "./chat-creation";
import { codeSessionTitleRoute } from "./code-session-title";
import { cloudCodeHistoryRoute } from "./cloud-code-history";
import { desktopRemoteCodeRoute } from "./remote-code";
import { desktopCloudCodeRoute } from "./desktop-cloud-code";
import { workspaceDownloadRoute } from "./workspace-download";
import { cloudCodeTriggerRoute } from "./code-triggers";
import { deviceRegistryRoute } from "./device-registry";

export function createApiAdapter(original: AdapterContext, options: { scoped?: boolean; migrateLegacy?: boolean; timelineWaitMs?: number; restCompletion?: boolean | "native"; nextTimelineVersion?: () => string } = {}) {
  const scoped = options.scoped ?? process.env.CLAUDEX_OFFICIAL_SCOPED_STATE === "1";
  const scopes = new Map<string, AdapterScope>();
  // Capability metadata describes installed protocol wiring, never a renderer-provided flag.
  const installed = options.restCompletion === true || options.restCompletion === "native";
  const wired = new Proxy(original, {
    get(target, key, receiver) {
      if (key === "usageSummaryProtocol") return "readonly-v1";
      if (key === "completionProtocol") return installed ? "text-chat-v1" : undefined;
      return Reflect.get(target, key, receiver);
    },
  });
  const ctx = scoped ? guardAdapterContext(wired) : wired;
  const mcpAppToolbox = mcpAppToolboxRoute(new McpAppToolbox(), ctx);
  const restCompletion = options.restCompletion === "native" ? createNativeRestCompletionRoute(ctx) : options.restCompletion ? createRestCompletionRoute(ctx, ctx.richQuoteActions ? {inlineAttachmentsSchema:nativeCompletionInlineSchema} : {}) : undefined;
  const melange = createMelangeRoute(ctx);
  const webSideQuestion = options.restCompletion === true ? createWebSideQuestionRoute(ctx) : undefined;
  let recents: ReturnType<typeof createRecentsRpc> | undefined;
  let timeline: ReturnType<typeof createTimelineRpc> | undefined;
  let actions: ReturnType<typeof createActionRpc> | undefined;
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    if (!ctx.account() && !/\/bootstrap(?:\/|$)|^\/api\/account$/.test(p))
      return reply(res, { error: { type: "authentication_error", message: "Sign in to continue." } }, 401);
    if (await pluginOrganizationRead(req, res, url, ctx)) return true;
    if (await organizationProjectRoute(req, res, url, ctx)) return true;
    if (await mcpAppToolbox(req, res)) return true;
    if (ctx.account() && (await accountRoute(req, res, p, ctx))) return true;
    if (await apiManagementRoute(req, res, url, ctx)) return true;
    if (await serviceStatusRoute(req, res, url, ctx)) return true;
    if (await announcementsRoute(req, res, url, ctx)) return true;
    if (await dispatchRoute(req, res, url, ctx)) return true;
    if (await deviceRegistryRoute(req, res, url, ctx)) return true;
    if (await zecousMigrationRoute(req, res, url, ctx)) return true;
    if (restCompletion && await restCompletion(req, res, p, url)) return true;
    if (await designArtifactsRoute(req, res, url, ctx)) return true;
    if (await bootstrapRoute(req, res, p, ctx)) return true;
    if (await codeSessionTitleRoute(req, res, p, ctx)) return true;
    if (await desktopRemoteCodeRoute(req, res, url, ctx, ctx.officialDesktopCloudCode?.request)) return true;
    if (await desktopCloudCodeRoute(req, res, url, ctx)) return true;
    if (await cloudCodeHistoryRoute(req, res, p, url, ctx)) return true;
    if (await cloudCodeTriggerRoute(req, res, url, ctx)) return true;
    if (await workspaceDownloadRoute(req, res, url, ctx)) return true;
    if (options.restCompletion === "native" && await nativeSideQuestionRoute(req, res, p, ctx)) return true;
    if (webSideQuestion && await webSideQuestion(req,res,p,url)) return true;
    if (await conversationSearchRoute(req, res, p, ctx)) return true;
    if (await restConversationLeafRoute(req, res, p, ctx)) return true;
    if (await emptyChatRoute(req, res, p, url, ctx)) return true;
    if (await researchStatusRoute(req, res, p, url, ctx)) return true;
    if (await restReplyFeedbackRoute(req, res, url, ctx)) return true;
    if (await conversationsRoute(req, res, p, url, ctx)) return true;
    if (await usageActivityRoute(req, res, p, url, ctx)) return true;
    if (await hostUsageRoute(req, res, p, url, ctx)) return true;
    if (await usageRoute(req, res, p, ctx)) return true;
    if (await projectFileAliasRoute(req,res,p,url,ctx,(target,aliasUrl,expected)=>projectsRoute(req,res,target,aliasUrl,ctx,expected))) return true;
    if (await generatedOutputFileRoute(req, res, p, url, ctx)) return true;
    if (await researchReportFileRoute(req, res, p, url, ctx)) return true;
    if (await filesRoute(req, res, p, ctx)) return true;
    if (await sharingRoute(req, res, p, ctx)) return true;
    if (await projectsRoute(req, res, p, url, ctx)) return true;
    if (await artifactPublishingRoute(req, res, url, ctx)) return true;
    if (await artifactsRoute(req, res, p, url, ctx)) return true;
    if (await staticArtifactPreviewRoute(req, res, p, ctx)) return true;
    if (await skillDownloadRoute(req, res, p, url, ctx)) return true;
    if (await skillsRoute(req, res, p, url, ctx)) return true;
    if (await directoryMcpSubmissionsRoute(req, res, url, ctx)) return true;
    if (await pluginDirectorySubmissionsRoute(req, res, url, ctx)) return true;
    if (await approvedDirectoryReadRoute(req, res, url, ctx)) return true;
    if (await directoryReadRoute(req, res, p, url, ctx)) return true;
    if (await libraryRoute(res, p, url, ctx)) return true;
    if (await pluginReadRoute(req, res, p, url, ctx)) return true;
    if (await accountPluginRoute(req, res, p, url, ctx)) return true;
    if (await connectorsRoute(req, res, p, ctx)) return true;
    if (await melangePrivacyRoute(req, res, url, ctx)) return true;
    if (await melange(req, res, p, url)) return true;
    if (await memoryRoute(req, res, p, url, ctx)) return true;
    if (p.endsWith("/StreamTimeline") || p.endsWith("/ReportViewing")) {
      timeline ??= createTimelineRpc(ctx, { missingConversationWaitMs: options.timelineWaitMs, nextVersion: options.nextTimelineVersion });
      if (timeline(req, res, p)) return true;
    }
    if (p.endsWith("/PerformAction")) {
      actions ??= createActionRpc(ctx, registryFor(ctx.root), { durableAppend: options.restCompletion === "native" });
      if (await actions(req, res, p)) return true;
    }
    if (p === "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/GetNewConversationDefaults") {
      // Unary Connect call; answered in the request's encoding. Enum numbers from the build's descriptors
      // (WORK_MODE_CHAT = 1, COMPUTER_LINK_ADMISSION_NOT_OFFERED = 2).
      req.resume();
      await new Promise((resolve) => req.on("end", resolve));
      const modes = ctx.chatPermissionModes;
      const nativeAutoModeAvailable = modes?.includes("auto") === true;
      const defaultPermission = nativeAutoModeAvailable && ctx.settings().taskPermission === "auto" ? "auto"
        : modes?.includes("default") ? "default" : nativeAutoModeAvailable ? "auto" : undefined;
      const defaults = {
        workMode: 1, unavailableActions: [], computerToolsEligible: false, nativeAutoModeAvailable,
        settings: { enabledArtifacts: true, ...(defaultPermission ? { permissionMode: chatPermissionToWire(defaultPermission) } : {}) },
      };
      const body = { regular: defaults, temporary: defaults, computerLinkAdmission: 2, previousVersionChoiceOffered: false };
      if ((req.headers["content-type"] ?? "").includes("proto")) {
        const schema = registryFor(ctx.root).getMessage("anthropic.bard.api.v1alpha.GetNewConversationDefaultsResponse");
        if (!schema) throw new Error("GetNewConversationDefaultsResponse is not in the protocol");
        res.writeHead(200, { "Content-Type": "application/proto", "Cache-Control": "no-store" });
        res.end(Buffer.from(toBinary(schema, deepCreate(schema, body))));
        return true;
      }
      const jsonDefaults = { ...defaults, workMode: "WORK_MODE_CHAT",
        settings: { enabledArtifacts: true, ...(defaultPermission ? {
          permissionMode: defaultPermission === "auto" ? "PERMISSION_MODE_AUTO" : "PERMISSION_MODE_ACCEPT_EDITS",
        } : {}) },
      };
      return reply(res, { ...body, regular: jsonDefaults, temporary: jsonDefaults, computerLinkAdmission: "COMPUTER_LINK_ADMISSION_NOT_OFFERED" });
    }
    if (p === LIST_RECENTS_PATH) {
      recents ??= createRecentsRpc(ctx, registryFor(ctx.root));
      return recents(req, res, p);
    }
    if (p.startsWith("/claudeai-rpc/"))
      return reply(res, { code: "unimplemented", message: `No adapter for ${p}` }, 501);
    if (await fixtureRoute(req, res, p)) return true;
    ctx.log("[official-ui] no adapter for", req.method, p);
    return false;
  };
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    if (!scoped) return handle(req, res);
    const owner = accountOwner(original);
    const scopedHandle = async () => {
      const scope = currentAdapterScope();
      if (!scope.loaded) {
        scope.initializing ??= (async () => {
          if (owner !== anonymousOwner && options.migrateLegacy !== false) await migrateLegacyState(ctx);
          ensureFileRegistry();
          loadConversationState();
          scope.loaded = true;
        })().catch((error) => { scope.initializing = undefined; throw error; });
        await scope.initializing;
      }
      return handle(req, res);
    };
    if (owner !== anonymousOwner && options.migrateLegacy === false && original.withOfficialApiScope)
      return original.withOfficialApiScope(scopedHandle);
    const identity = original.sessionIdentity?.();
    let scope = scopes.get(owner);
    if (!scope || scope.sessionIdentity !== identity) {
      scope = newAdapterScope(owner, owner === anonymousOwner ? undefined : original.stateDirectory?.(), identity);
      scopes.set(owner, scope);
    }
    return inAdapterScope(scope, scopedHandle);
  };
}

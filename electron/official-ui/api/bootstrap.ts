import { organizationProjectWorkspaces } from "./organization-projects";
import { officialCapabilityPreferences } from "./capability-preferences";
import { officialClassificationEnabled, officialCodeFlaggedSwitchEnabled } from "./classification-settings";
import { officialChatFont } from "./appearance";
import { officialCodeSettings } from "../../../shared/official-code-settings";
/**
 * The front-end's startup answer (`/edge-api/bootstrap/<org>/app_start`,
 * `/api/bootstrap/...`, `/api/account`, `/api/organizations`): the signed-in
 * Claudex account as the one account of its one organization, on top of the
 * flag, gate and catalog defaults recorded from the official desktop surface
 * (build/official-ui/data/bootstrap-defaults.json).
 */
import fs from "node:fs";
import { preference } from "../../../shared/settings-extras";
import path from "node:path";
import type http from "node:http";
import { officialRemoteCodeGate, officialRemoteCodeTransportGates } from "../../../shared/official-remote-code";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { modelProtocol } from "../../../shared/provider-routes";
import { accountProfileFields } from "./account";
import {
  accountConnectorToolSettings,
  waitForConnectorToolChanges,
} from "./connectors";
import { memorySettingsWithMode } from "./memory";
import {
  unavailableMemory,
  type MemoryStatus,
} from "../../../shared/memory-api";
import { modeInstructions } from "../../engine/instructions";
import { memoryLimits } from "../../memory/types";
import {
  isConversationModel,
  type CatalogEffort,
  type ModelCatalogItem,
} from "../../../shared/model-catalog-api";
import {
  officialLocale,
  officialLocales,
  officialLocaleSelection,
} from "../locale";
import { nativeTranslator } from "../../app/native-i18n";
import { completionProtocolDescriptor } from "./completion-protocol";
import { artifactPublishingStatus } from "./artifact-publishing";
import { knowledgeProjectLimit } from "../../projects/project-knowledge";

import {
  readModelPreference,
  writeModelPreference,
  selectorPatchSchema,
  ModelPreferenceError,
} from "./model-selection-preferences";
import { readBoundedJson, RequestBodyError } from "./request-body";
import { officialAccountMenuGate, officialAccountMenuMessages } from "../../../shared/official-account-menu";

const defaultsByRoot = new Map<string, Record<string, any>>();
const bootstrapTranslators = new Map<string, Promise<(text: string) => string>>();
function loadDefaults(root: string): Record<string, any> {
  const key = path.resolve(root);
  const cached = defaultsByRoot.get(key);
  if (cached) return cached;
  const file = path.join(key, "data", "bootstrap-defaults.json");
  const defaults = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {
        org_growthbook: { hashing_algorithm: "djb2", features: {} },
        org_statsig: null,
        gated_imports: {},
        gated_imports_build_id: "",
        gated_messages: { messages: {}, gates: {}, locale: "en-US" },
        model_selector_state: [],
        model_selector_config: [],
      };
  defaultsByRoot.set(key, defaults);
  return defaults;
}

/**
 * Whether a model can search the web here: the engine sends web search only
 * over a Responses route (electron/engine/engine-guards.ts assertSendable).
 */
export function canSearch(ctx: AdapterContext, model: string) {
  if (ctx.webSearchAllowed?.() === false) return false;
  const settings = ctx.settings();
  const providers = settings.providers ?? [];
  const provider =
    providers.find((p) => p.backend === "sub2api") ??
    providers.find((p) => p.id === settings.activeProviderId);
  return !!provider && modelProtocol(provider, model) === "responses";
}

/** Office add-ins are separate integrations, not a Claudex subscription tier. */
export function currentUserAccessOf(ctx: AdapterContext) {
  const access = structuredClone(loadDefaults(ctx.root).current_user_access ?? {
    features: [], account_features: [],
  });
  access.features ??= [];
  if (ctx.webSearchAllowed?.() === false) {
    const search = access.features.find(
      (feature: { feature: string }) => feature.feature === "web_search",
    );
    if (search) search.status = "blocked_by_org_admin";
    else access.features.push({ feature: "web_search", status: "blocked_by_org_admin" });
  }
  const office = access.features.find((feature: {feature: string}) => feature.feature === "work_across_apps");
  if (office) office.status = "blocked_by_platform";
  else access.features.push({feature: "work_across_apps", status: "blocked_by_platform"});
  if (!ctx.readOnly && ctx.localCall) {
    const cloudCode = access.features.find(
      (feature: { feature: string }) => feature.feature === "claude_code_web",
    );
    const cloudCodeStatus = ctx.officialDesktopCloudCode?.available() ||
      ctx.officialRemoteCode ? "available" : "blocked_by_platform";
    if (cloudCode) cloudCode.status = cloudCodeStatus;
    else access.features.push({ feature: "claude_code_web", status: cloudCodeStatus });
    // Native Cowork starts here. Only the Web Runner serves cloud Cowork creation.
    const cloudCowork = access.features.find(
      (feature: { feature: string }) => feature.feature === "dramatic_shrimp",
    );
    if (cloudCowork) cloudCowork.status = "blocked_by_platform";
  }
  if (ctx.readOnly) {
    const skill = access.features.find((feature: { feature: string }) => feature.feature === "skill_creation");
    if (skill) skill.status = ctx.allowSkillCreation === true ? "available" : "blocked_by_platform";
  }
  return access;
}

export function organizationOf(ctx: AdapterContext) {
  const account = ctx.account();
  if (!account) return undefined;
  return {
    uuid: organizationUuid(account.id),
    name: account.name || "Claudex",
    // Claudex model access is not an Anthropic Pro/Max/Team subscription.
    // Vendor tier flags also drive billing copy; never borrow a recorded tier
    // merely to unlock navigation. Actual model availability is catalog-backed.
    capabilities: ["chat"],
    settings: {},
    active_flags: [],
    rate_limit_tier: null,
    billing_type: null,
    merchant_of_record: null,
    plan_display_name: account.plan ?? "Claudex",
    created_at: new Date(0).toISOString(),
  };
}

function comparisonSupported(ctx: AdapterContext) {
  return !!ctx.createEmptyChat && ctx.completionProtocol === "text-chat-v1" && ctx.isCurrent?.() !== false;
}

async function nativeCustomConnectorCreation(ctx: AdapterContext) {
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  if (!owner || ctx.readOnly || ctx.isCurrent?.() !== true || !ctx.localCall)
    return false;
  const policy = await ctx.localCall("clientPolicy").catch(() => undefined);
  return (
    !!policy &&
    typeof policy === "object" &&
    "localMcpEditing" in policy &&
    policy.localMcpEditing === true &&
    ctx.isCurrent?.() === true &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation
  );
}

export function accountOf(
  ctx: AdapterContext,
  publishing?: Awaited<ReturnType<typeof artifactPublishingStatus>>,
  nativeCustomConnector = false,
) {
  const account = ctx.account();
  const organization = organizationOf(ctx);
  if (!account || !organization) return undefined;
  const settings = ctx.settings();
  const profile = accountProfileFields(ctx);
  const completionProtocol = completionProtocolDescriptor(ctx);
  return {
    uuid: account.id,
    full_name: profile.full_name,
    display_name: profile.display_name || profile.full_name,
    avatar_image_url: profile.avatar_image_url,
    email_address: account.email,
    // This marks an existing authenticated Claudex host session only. It is
    // not vendor identity, age or email verification; those facts are unknown.
    claudex_host_authentication: {
      version: 1,
      status: "authenticated",
      account_uuid: account.id,
    },
    ...(comparisonSupported(ctx) ? { claudex_comparison_supported: true } : {}),
    ...(!ctx.readOnly && ctx.localCall && ctx.isCurrent?.() === true ? {
      claudex_native_privacy: {
        organization_uuid: organization.uuid,
        location_metadata: ctx.locationMetadataAvailable?.() === true,
      },
    } : {}),
    ...(ctx.apiManagement && ctx.isCurrent?.() === true ? { claudex_api_management: true } : {}),
    ...(ctx.serviceStatus && ctx.isCurrent?.() === true ? { claudex_service_status: true } : {}),
    ...(ctx.announcements && ctx.isCurrent?.() === true ? { claudex_service_announcements: true } : {}),
    ...(ctx.dispatch && ctx.isCurrent?.() === true ? {
      claudex_dispatch: true,
      claudex_dispatch_receiving: !!ctx.dispatchReceiver,
    } : {}),
    ...(ctx.officialRemoteCode && ctx.isCurrent?.() === true ? { claudex_remote_code: true } : {}),
    ...(ctx.zecousMigration && ctx.isCurrent?.() === true ? { claudex_zecous_migration: true } : {}),
    ...(ctx.allowDirectorySubmissions ? {
      claudex_directory_submissions: true,
      claudex_directory_terms_url: ctx.directoryTermsUrl,
    } : {}),
    ...(ctx.isCurrent?.() === true && ctx.chatPermissionModes?.includes("auto") &&
    loadDefaults(ctx.root).org_growthbook?.features?.["2295073874"]?.defaultValue === true
      ? { claudex_composer_layout_seed: "marlin" as const }
      : {}),
    ...(ctx.isCurrent?.() === true &&
    (ctx.readOnly
      ? ctx.allowCustomConnectorCreation === true &&
        !!ctx.authorizeCustomConnector
      : nativeCustomConnector)
      ? { claudex_custom_connector_creation: true }
      : {}),
    ...(ctx.readOnly &&
    ctx.allowSkillCreation === true &&
    ctx.isCurrent?.() === true
      ? { claudex_skill_creation: true }
      : {}),
    ...(ctx.readOnly && ctx.allowSkillUpload === true && ctx.isCurrent?.() === true
      ? { claudex_skill_upload: true }
      : {}),
    // The original Markdown review sends an ordinary prompt to the current Chat.
    ...((!ctx.readOnly || ctx.allowChatArtifactReview === true) && ctx.isCurrent?.() !== false
      ? { claudex_chat_artifact_review: true }
      : {}),
    // Native host registers LocalSessions; this only exposes its navigation entry.
    // It grants no model execution, file access, provider or vendor subscription rights.
    ...(typeof ctx.localCall === "function" && !ctx.readOnly && ctx.isCurrent?.() === true ? {
      claudex_local_code: {
        version: 1,
        account_uuid: account.id,
        organization_uuid: organization.uuid,
        available: true,
      },
    } : {}),
    ...(ctx.readOnly && ctx.officialCodeHistory === true && ctx.isCurrent?.() === true
      ? {
          claudex_web_code: {
            version: 1,
            account_uuid: account.id,
            organization_uuid: organization.uuid,
            available: true,
            ...(ctx.officialCodeTerminalAvailable ? { terminal_available: true } : {}),
            ...(ctx.officialCodeWorkspaceDiffAvailable ? { workspace_diff_available: true } : {}),
          },
        }
      : {}),
    ...(ctx.officialCoworkHistory === true && ctx.isCurrent?.() === true ? {
      claudex_web_cowork_history: {
        account_uuid: account.id,
        organization_uuid: organization.uuid,
        ...(ctx.officialCoworkFollowupAvailable ? { followup_available: true } : {}),
        ...(ctx.allowConversationProjectMove ? { project_move: true } : {}),
      },
    } : {}),
    // Hosted publication follows the active Claudex service's policy.
    ...(ctx.isCurrent?.() !== false ? {
      claudex_artifact_publishing: {
        version: 1,
        account_uuid: account.id,
        organization_uuid: organization.uuid,
        supported: publishing !== undefined,
        ...(ctx.readOnly && publishing ? { web_open: true } : {}),
        ...publishing,
      },
    } : {}),
    ...(completionProtocol
      ? { claudex_frontend_completion_protocol: completionProtocol }
      : {}),
    ...(ctx.usageSummaryProtocol === "readonly-v1" &&
    ctx.isCurrent?.() !== false
      ? {
          claudex_usage_summary: {
            version: 1,
            account_uuid: account.id,
            organization_uuid: organization.uuid,
            read_only: true,
          },
        }
      : {}),
    has_claude_pro: false,
    settings: {
      // Captured personal choices (model, web search, egress, voice, drafts,
      // privacy and tool choices) do not belong to this account. Omit unknown
      // settings instead of claiming they are enabled or disabled.
      // The recorded account's per-tool choices do not belong to the signed-in
      // Claudex user. An empty map inherits that user's real connector policy.
      enabled_mcp_tools: accountConnectorToolSettings(ctx),
      ...officialCapabilityPreferences(ctx),
      ccr_session_state_buckets: officialClassificationEnabled(ctx),
      ccr_switch_models_on_flag: officialCodeFlaggedSwitchEnabled(ctx),
      enabled_model_auto_fallback: preference(settings, "modelAutoFallback"),
      ...officialCodeSettings(settings),
      theme: settings.theme,
      ...(officialChatFont(settings.chatFont)
        ? { chat_font: settings.chatFont }
        : {}),
      locale: officialLocale(ctx),
      has_finished_claudeai_onboarding: true,
      work_function: profile.work_function,
    },
    memberships: [{ role: "admin", organization }],
    invites: [],
    created_at: new Date(0).toISOString(),
  };
}

/**
 * The model menu (`model_selector_config`/`model_selector_state`, read by the
 * composer's model picker) offers conversation models from the Claudex catalog.
 */
export async function modelSelectorOf(
  ctx: AdapterContext,
  base: Record<string, any>,
) {
  const catalog = await ctx.modelCatalog().catch(() => null);
  if (!catalog?.items.length)
    ctx.log(
      "[official-ui] Claudex model catalog unavailable; no recorded account models are advertised",
    );
  const items = (catalog?.items ?? [])
    .filter((item) => isConversationModel(item.id))
    .sort((a, b) => a.sort - b.sort);
  const surfaces: string[] = (base.model_selector_config ?? [])
    .map((entry: any) => entry.id)
    .filter((id: unknown) => typeof id === "string");
  const surfaceIds = surfaces.length ? surfaces : ["chat", "code", "cowork", "hub"];
  if (!items.length) {
    return {
      config: surfaceIds.map((id) => ({ id, models: [] })),
      state: [],
      available: { models: [] },
      items,
      defaultModel: undefined,
    };
  }
  const searchable = (id: string, native: boolean) =>
    native && canSearch(ctx, id);
  const effortName = (id: string) =>
    ({
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra",
      max: "Max",
      ultra: "Ultra",
    })[id] ?? id;
  // Catalog hidden means More models, not unavailable (owner decision 11).
  const codeSurface = (surface: string) =>
    ["code", "cc", "ccr", "ccd"].includes(surface) ||
    surface.startsWith("code_");
  // ModelCatalogItem defines absent efforts as no effort setting. Legacy picker
  // defaults are not evidence that this model accepts those request parameters.
  const effortsFor = (
    item: ModelCatalogItem,
    _surface: string,
  ): readonly CatalogEffort[] => item.efforts ?? [];
  const providerId = ctx.settings().activeProviderId;
  const modelsFor = (surface: string) =>
    items.map((item) => ({
      id: item.id,
      name: item.displayName,
      short_name: item.displayName,
      description: item.description,
      notice_text: item.usageHint || null,
      section: item.hidden ? "overflow" : "main",
      capabilities: {
        web_search: searchable(item.id, item.webSearch === "native"),
        mm_images: true,
        mm_pdf: true,
      },
      thinking: effortsFor(item, surface).length
        ? {
            type: "effort_and_mode",
            description: "",
            effort_options: [
              ...effortsFor(item, surface).map((effort) => ({
                id: effort,
                name: effortName(effort),
                ...(effort === item.defaultEffort ? { recommended: true } : {}),
              })),
              ...(codeSurface(surface) && providerId && ctx.codeUltracodeAvailable?.(providerId, item.id)
                ? [{ id: "ultracode", name: "Ultracode" }] : []),
            ],
          }
        : { type: "disabled" },
      ...(item.contextWindow === undefined
        ? {}
        : { hard_limit: item.contextWindow }),
      quick_select: false,
    }));
  const defaultModel =
    items.find((item) => item.id === catalog?.defaultModel)?.id ??
    items.find((item) => item.isDefault)?.id ??
    items[0].id;
  const config = surfaceIds.map((id) => ({ id, models: modelsFor(id) }));
  const thinkingFor = (modelId: string, surface: string) => {
    const item = items.find((entry) => entry.id === modelId);
    if (!item) return { type: "disabled" };
    const efforts = effortsFor(item, surface);
    const preferred =
      item.defaultEffort ??
      (codeSurface(surface)
        ? ctx.settings().codeEffort
        : ctx.settings().effort);
    return efforts.length
      ? {
          type: "effort_and_mode",
          effort: efforts.includes(preferred) ? preferred : efforts[0],
          mode: "auto",
        }
      : { type: "disabled" };
  };
  const known = new Set(items.map((m) => m.id));
  const state = config.map(({ id }) => {
    const chosen = readModelPreference(ctx, id);
    const model =
      chosen?.model && known.has(chosen.model) ? chosen.model : defaultModel;
    const saved =
      !chosen?.model || chosen.model === model
        ? (chosen?.thinking as
            { type?: string; effort?: CatalogEffort } | undefined)
        : undefined;
    const item = items.find((item) => item.id === model);
    const valid =
      (saved?.type === "effort_and_mode" || saved?.type === "effort") &&
      saved.effort &&
      item &&
      effortsFor(item, id).includes(saved.effort);
    const thinking = valid ? saved : thinkingFor(model, id);
    return {
      id,
      model,
      selection_source:
        chosen?.model && known.has(chosen.model) ? "user_setting" : "default",
      thinking,
      thinking_by_model: items.map((m) => ({
        id: m.id,
        thinking: m.id === model ? thinking : thinkingFor(m.id, id),
      })),
    };
  });
  const available = {
    models: items.map((m) => ({ model_id: m.id, minimum_tier: "free" })),
  };
  return { config, state, available, items, defaultModel };
}

/** Official shared-6 sX/ST reads entry.value.prompt, including on refetch. */
export function systemPromptsOf(ctx: AdapterContext) {
  return {
    cowork_system_prompt: {
      value: { prompt: modeInstructions("cowork", ctx.settings()) },
    },
  };
}

async function accountMemorySettings(ctx: AdapterContext) {
  return memorySettingsWithMode(ctx,
    ((await ctx.call("memoryStatus", { snapshotOnly: true }).catch(() => undefined)) as MemoryStatus | undefined) ?? unavailableMemory,
  );
}

export async function bootstrapOf(ctx: AdapterContext) {
  const base = loadDefaults(ctx.root);
  void ctx.refreshOfficialCodeSettings?.().catch(() => {});
  const [selector, publishing, customConnector, projectWorkspaces, memory] = await Promise.all([
    modelSelectorOf(ctx, base),
    artifactPublishingStatus(ctx),
    nativeCustomConnectorCreation(ctx),
    organizationProjectWorkspaces(ctx),
    accountMemorySettings(ctx),
  ]);
  const account = accountOf(ctx, publishing, customConnector);
  if (account && projectWorkspaces.length) Object.assign(account, {
    claudex_project_workspaces: projectWorkspaces,
    claudex_project_share_origin: ctx.organizationProjects?.shareOrigin,
  });
  if (account)
    Object.assign(account.settings, {
      enabled_saffron: memory.enabled_saffron,
      enabled_saffron_search: memory.enabled_saffron_search,
      enabled_melange: memory.enabled_melange,
    });
  const organization = organizationOf(ctx);
  const { locale, source: localeSource } = officialLocaleSelection(ctx);
  const growthbook = structuredClone(
    base.org_growthbook ?? { hashing_algorithm: "djb2", features: {} },
  );
  const releasedLocales: unknown = growthbook.features?.["2420925338"]?.defaultValue?.released;
  const deliveredLocales = new Set(officialLocales(ctx.root));
  (growthbook.features ??= {})["2420925338"] = {
    defaultValue: {
      released: Array.isArray(releasedLocales)
        ? releasedLocales.filter((locale): locale is string =>
            typeof locale === "string" && deliveredLocales.has(locale))
        : [],
    },
  };
  // Pinned vendor training and data-management programs have different scopes.
  for (const gate of ["1253021364", "401687431", "521672345", "3573939499"])
    growthbook.features[gate] = { defaultValue: false };
  growthbook.features["1356709763"] = { defaultValue: memory.melange_available };
  growthbook.features["3868090370"] = { defaultValue: memory.melange_available };
  if (ctx.allowDirectorySubmissions) {
    growthbook.features["1659798068"] = { defaultValue: false };
    growthbook.features["794656599"] = { defaultValue: false };
  }
  growthbook.features["4287354656"] = { defaultValue: false };
  if (ctx.officialDesktopCloudCode?.available())
    growthbook.features["2831057674"] = { defaultValue: true };
  if (ctx.readOnly)
    growthbook.features["1282688181"] = { defaultValue: false }; // velvet_anvil: host-bound network secrets
  growthbook.features["4074912323"] = {
    defaultValue: !!account && ctx.isCurrent?.() === true &&
      (ctx.readOnly ? ctx.officialCodeSettingsAvailable === true : typeof ctx.localCall === "function"),
  };
  growthbook.features[officialRemoteCodeGate] = {
    defaultValue: !!ctx.officialRemoteCode && ctx.isCurrent?.() === true,
  };
  if (ctx.officialRemoteCode && ctx.isCurrent?.() === true)
    Object.assign(growthbook.features, officialRemoteCodeTransportGates);
  const canOfferAccountMenu = !ctx.readOnly && ctx.browserAccountsAvailable?.() === true;
  if (!ctx.readOnly)
    growthbook.features[officialAccountMenuGate] = { defaultValue: canOfferAccountMenu };
  if (!ctx.readOnly && typeof ctx.localCall === "function")
    growthbook.features["4255272488"] = { defaultValue: true }; // desktop-notification-level-picker
  const gatedImports = structuredClone(base.gated_imports ?? {});
  delete gatedImports.cardinal;

  if (ctx.officialCodeWorkspaceDiffAvailable && ctx.isCurrent?.() === true) {
    (growthbook.features ??= {})["2023598694"] = { defaultValue: false };
    growthbook.features["3867332596"] = { defaultValue: true };
  }
  if (ctx.isCurrent?.() === true) {
    if (ctx.officialCodeTriggerWrites)
      (growthbook.features ??= {})["3951777386"] = { defaultValue: true };
    if (ctx.readOnly && ctx.officialCodeHistory)
      (growthbook.features ??= {})["1970025994"] = { defaultValue: ctx.officialCodeRewindAvailable !== true };
    if (ctx.officialCodeHistory || !ctx.readOnly && typeof ctx.localCall === "function")
      (growthbook.features ??= {})["1551835466"] = { defaultValue: true };
  }
  // The server-backed capacity meter divides kb/stats bytes by this limit.
  (growthbook.features ??= {})["815173524"] = {
    defaultValue: { limit: knowledgeProjectLimit },
  };
  // The pinned Compare panel reads this gate for its per-Chat Memory switch.
  (growthbook.features ??= {})["3082987388"] = {
    defaultValue: comparisonSupported(ctx),
  };
  // The original quote-reply control sends protobuf quote metadata.
  const canOfferRichQuotes = !!ctx.account() && ctx.isCurrent?.() !== false &&
    (!ctx.readOnly || ctx.richQuoteActions === true);
  if ((canOfferRichQuotes || canOfferAccountMenu) && !bootstrapTranslators.has(locale))
    bootstrapTranslators.set(locale, nativeTranslator(locale).catch(() => (text: string) => text));
  const translate = await bootstrapTranslators.get(locale) ?? ((text: string) => text);
  const accountMenu = canOfferAccountMenu && ctx.isCurrent?.() !== false;
  const richQuotes = canOfferRichQuotes && !!ctx.account() && ctx.isCurrent?.() !== false &&
    (!ctx.readOnly || ctx.richQuoteActions === true);
  growthbook.features["638990223"] = {
    defaultValue: richQuotes,
  };
  const sideQuestions = !!ctx.account() && ctx.isCurrent?.() !== false && !!ctx.sideQuestionGateway;
  growthbook.features["3717420587"] = { defaultValue: sideQuestions };
  // ccr_file_attachments is the original Code composer's remote file gate.
  if (ctx.officialCodeUpload === true)
    growthbook.features["1639550458"] = { defaultValue: true };
  // Hashed claudeai_saffron_frontend key in the frozen official configuration.
  // The page's editor must enforce the actual host limits before saving.
  const memoryConfig = growthbook.features?.["3903416871"]?.defaultValue;
  if (memoryConfig && typeof memoryConfig === "object") {
    if (ctx.readOnly) {
      const canSynthesize = ctx.memoryGenerationAvailable?.() === true;
      memoryConfig.edit_resynthesize_enabled = canSynthesize && memoryConfig.edit_resynthesize_enabled === true;
      memoryConfig.import_resynthesize_enabled = canSynthesize && memoryConfig.import_resynthesize_enabled === true;
    }
    memoryConfig.max_control_chars = Math.min(
      memoryConfig.max_control_chars ?? memoryLimits.editChars,
      memoryLimits.editChars,
    );
    memoryConfig.max_num_controls = Math.min(
      memoryConfig.max_num_controls ?? memoryLimits.editsPerScope,
      memoryLimits.editsPerScope,
    );
  }
  const {
    account_settings_template: _accountTemplate,
    organization_template: _organizationTemplate,
    ...wireDefaults
  } = base;
  return {
    ...wireDefaults,
    account: account ?? null,
    organizations: organization ? [organization] : [],
    featureFlagsOrgUuid: organization?.uuid ?? null,
    feature_flags: {},
    gated_imports: gatedImports,
    statsig: base.org_statsig ?? null,
    growthbook,
    org_growthbook: growthbook,
    // The official merger only adopts a public catalog when its bootstrap
    // locale agrees. Unrecovered gated translations keep their recorded
    // English fallback; their coverage remains an explicit inventory gap.
    gated_messages: {
      ...(base.gated_messages ?? { messages: {}, gates: {} }),
      messages: {
        ...(richQuotes ? {
          "secret:1xgqplv": translate("Reply"),
          "secret:8ot1xa": translate("Write a reply"),
          "secret:1x91a6d": translate("Write a reply"),
          "secret:ebcglr": translate("Cancel"),
          "secret:dp31aq": translate("Save"),
          "secret:7bcw8c": translate("Add"),
          "secret:puv8n3": "The quote must be at most {max} characters.",
          "secret:xhxj9b": "You can add up to {count} quotes.",
          "secret:1kx83wx": "The reply must be at most {max} characters.",
        } : {}),
        ...(accountMenu ? officialAccountMenuMessages(translate) : {}),
        ...(base.gated_messages?.messages ?? {}),
      },
      gates: [
        ...(Array.isArray(base.gated_messages?.gates) ? base.gated_messages.gates : [])
          .filter((gate: unknown) => gate !== "cardinal" && gate !== "__gb__638990223" && gate !== "__gb__3717420587"),
        ...(richQuotes ? ["__gb__638990223"] : []),
        ...(sideQuestions ? ["__gb__3717420587"] : []),
        ...(accountMenu ? [`__gb__${officialAccountMenuGate}`] : []),
      ],
      locale,
    },
    org_feature_flags: base.org_feature_flags ?? {
      user: {},
      values: {},
      values_hash: "",
    },
    resolved_org_uuid: organization?.uuid ?? null,
    country: "US",
    is_anonymous: !account,
    locale,
    locale_source: localeSource,
    current_user_access: currentUserAccessOf(ctx),
    model_selector_config: selector.config,
    model_selector_state: selector.state,
    claude_ai_available_models: selector.available,
    memory_mode: memory.memory_mode,
    classic_mode_available: memory.classic_mode_available,
    melange_available: memory.melange_available,
    // Do not relabel an invented Pro/Max subscription as pay-as-you-go.
    // The official client lacks a Claudex billing kind; that UI gap stays open.
    served_copy: base.served_copy ?? {},
    personalized_greeting: null,
    system_prompts: systemPromptsOf(ctx),
  };
}

export async function bootstrapRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  if (p.endsWith("/current_user_access"))
    return reply(
      res,
      currentUserAccessOf(ctx),
    );
  if (/\/bootstrap(?:\/|$)/.test(p) && !p.endsWith("/mcp/v2/bootstrap")) {
    await waitForConnectorToolChanges();
    if (p.endsWith("/cowork_sysprompt_map")) return reply(res, {});
    if (p.endsWith("/system_prompts")) return reply(res, systemPromptsOf(ctx));
    return reply(res, await bootstrapOf(ctx));
  }
  if (p === "/api/account") {
    void ctx.refreshOfficialCodeSettings?.().catch(() => {});
    await waitForConnectorToolChanges();
    const [publishing, customConnector, projectWorkspaces, memory] = await Promise.all([
      artifactPublishingStatus(ctx),
      nativeCustomConnectorCreation(ctx),
      organizationProjectWorkspaces(ctx),
      ctx.account() ? accountMemorySettings(ctx) : undefined,
    ]);
    const account = accountOf(ctx, publishing, customConnector);
    if (account) {
      if (projectWorkspaces.length) Object.assign(account, {
        claudex_project_workspaces: projectWorkspaces,
        claudex_project_share_origin: ctx.organizationProjects?.shareOrigin,
      });
      if (memory) Object.assign(account.settings, {
        enabled_saffron: memory.enabled_saffron,
        enabled_saffron_search: memory.enabled_saffron_search,
        enabled_melange: memory.enabled_melange,
      });
    }
    return account
      ? reply(res, account)
      : reply(
          res,
          {
            error: {
              type: "authentication_error",
              message: "Sign in to continue.",
            },
          },
          401,
        );
  }
  if (p === "/api/organizations") {
    const organization = organizationOf(ctx);
    return reply(res, organization ? [organization] : []);
  }
  // The model the person picked for a surface (shared-0 15821): kept for the next bootstrap.
  const selection =
    /^\/api\/organizations\/[^/]+\/model_selector_state\/([^/]+)$/.exec(p);
  if (selection && (req.method === "PATCH" || req.method === "PUT")) {
    if (ctx.readOnly && !ctx.saveModelPreference)
      return reply(
        res,
        {
          error: {
            message:
              "Model preference writes are not available on the web yet.",
          },
        },
        501,
      );
    const owner = ctx.account()?.id,
      activation = ctx.sessionIdentity?.();
    if (!owner)
      return reply(res, { error: { message: "Sign in to continue." } }, 401);
    if (p.split("/")[3] !== organizationUuid(owner))
      return reply(res, { error: { message: "Organization not found." } }, 404);
    const current = () =>
      ctx.isCurrent?.() !== false &&
      ctx.account()?.id === owner &&
      ctx.sessionIdentity?.() === activation;
    try {
      const body = selectorPatchSchema.safeParse(
        await readBoundedJson(req, 4096),
      );
      if (!current())
        return reply(
          res,
          {
            error: {
              message: "The account changed. Reload model preferences.",
            },
          },
          409,
        );
      if (!body.success)
        return reply(
          res,
          {
            error: {
              message:
                "These model preference options are invalid or unsupported.",
            },
          },
          400,
        );
      let surface: string;
      try {
        surface = decodeURIComponent(selection[1]);
      } catch {
        return reply(
          res,
          { error: { message: "Invalid model selector surface." } },
          400,
        );
      }
      const catalog = await ctx.modelCatalog();
      if (!current())
        return reply(
          res,
          {
            error: {
              message: "The account changed. Reload model preferences.",
            },
          },
          409,
        );
      if (!catalog?.items.length)
        return reply(
          res,
          { error: { message: "The model catalog is unavailable." } },
          503,
        );
      const sourceCtx = { ...ctx, modelCatalog: async () => catalog };
      const selector = await modelSelectorOf(sourceCtx, loadDefaults(ctx.root));
      if (!selector.config.some((row) => row.id === surface))
        return reply(
          res,
          { error: { message: "Unknown model selector surface." } },
          400,
        );
      const model =
        body.data.model === null
          ? selector.defaultModel
          : (body.data.model ??
            selector.state.find((row) => row.id === surface)?.model);
      const matches = selector.items.filter((item) => item.id === model);
      if (matches.length !== 1)
        return reply(
          res,
          { error: { message: "The selected model is unavailable." } },
          400,
        );
      const thinking = body.data.thinking;
      if (thinking) {
        const offered = matches[0].efforts ?? [];
        if (
          ("effort" in thinking && !offered.includes(thinking.effort)) ||
          (!("effort" in thinking) && offered.length)
        )
          return reply(
            res,
            {
              error: {
                message:
                  "This thinking preference is not supported by the selected model.",
              },
            },
            400,
          );
      }
      if (!current())
        return reply(
          res,
          {
            error: {
              message: "The account changed. Reload model preferences.",
            },
          },
          409,
        );
      const savedModel =
        body.data.model === undefined
          ? readModelPreference(ctx, surface).model
          : undefined;
      const patch = {
        ...body.data,
        ...(savedModel && savedModel !== model ? { model: null } : {}),
        ...(body.data.model !== undefined && body.data.thinking === undefined
          ? { thinking: null }
          : {}),
      };
      if (ctx.saveModelPreference) await ctx.saveModelPreference(surface, patch);
      else writeModelPreference(ctx, surface, patch);
      const updated = await modelSelectorOf(sourceCtx, loadDefaults(ctx.root));
      if (!current())
        return reply(
          res,
          {
            error: {
              message: "The account changed. Reload model preferences.",
            },
          },
          409,
        );
      return reply(
        res,
        updated.state.find((row) => row.id === surface),
      );
    } catch (error) {
      if (
        error instanceof RequestBodyError ||
        error instanceof ModelPreferenceError
      )
        return reply(res, { error: { message: error.message } }, error.status);
      return reply(
        res,
        { error: { message: "Model preferences could not be saved." } },
        503,
      );
    }
  }
  const organization = organizationOf(ctx);
  if (organization && p === `/api/organizations/${organization.uuid}`)
    return reply(res, organization);
  // Another organization (the account before a switch): not this account's.
  const other =
    /^\/api\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/.exec(
      p,
    );
  if (organization && other && other[1] !== organization.uuid)
    return reply(
      res,
      {
        type: "error",
        error: { type: "not_found_error", message: "Organization not found" },
      },
      404,
    );
  return false;
}

import bundled from "./codex-models.json";
import prompt from "./codex-prompt.json";
import type { GatewayModelEfforts } from "../../shared/gateway-signals";
import { preloadedModelSuffix } from "../../shared/tool-search-mode";

/**
 * The model catalog Codex starts with (`-c model_catalog_json=…`).
 *
 * `codex-models.json` is the catalog bundled with the pinned Codex
 * (`codex debug models --bundled`, @openai/codex 0.144.1; the runner image
 * pins the same version). It knows GPT-5.x only, so the GPT-6 models the
 * service sells run on Codex's fallback metadata (`model_info_from_slug`),
 * which has no apply_patch tool: the model wrote files with
 * `apply_patch <<'PATCH'` inside a shell command and nothing showed until
 * the whole file was written (owner, 2026-10-09: a long thesis sat at
 * "Still thinking…" for minutes).
 *
 * A "gpt-6" entry (Codex matches a model by the longest slug prefix, so it
 * covers gpt-6.1-sol, gpt-6-sol, gpt-6-astra…) keeps every fallback value,
 * prompt included (`codex-prompt.json`, Codex's BASE_INSTRUCTIONS), and adds
 * only a freeform apply_patch, whose input Codex streams as
 * `item/fileChange/patchUpdated` while the model writes it
 * (`features.apply_patch_streaming_events`). Checked against the service with
 * the real Codex: the same tools and prompt as before plus apply_patch, and
 * updates every ~0.5 s from the first line until the file was written.
 */
/**
 * Codex's prompts introduce the model as Codex, built on GPT-5 and run in
 * OpenAI's Codex CLI. In Claudex it is Claudex, made by ZecousAI (owner,
 * 2026-10-12). Only those identity sentences change; everything else in the
 * prompts, including Codex as the name of tools and settings, is kept.
 */
const identity: [RegExp, string][] = [
  [
    /You are Codex, a coding agent based on GPT-5\./g,
    "You are Claudex, a coding agent made by ZecousAI.",
  ],
  [
    /You are Codex, an agent based on GPT-5\./g,
    "You are Claudex, an agent made by ZecousAI.",
  ],
  [
    /You are GPT-[\d.]+ running in the Codex CLI, a terminal-based coding assistant\./g,
    "You are Claudex, an assistant made by ZecousAI, running in the Claudex app.",
  ],
  [
    /You are a coding agent running in the Codex CLI, a terminal-based coding assistant\./g,
    "You are Claudex, a coding agent made by ZecousAI, running in the Claudex app.",
  ],
  [
    /Codex CLI is an open source project led by OpenAI\./g,
    "Claudex is made by ZecousAI.",
  ],
  [
    /Within this context, Codex refers to the open-source agentic coding interface \(not the old Codex language model built by OpenAI\)\./g,
    "Within this context, Claudex refers to the ZecousAI app you are running in.",
  ],
  [/As Codex, you are/g, "As Claudex, you are"],
  [
    /You have a vivid inner life as Codex:/g,
    "You have a vivid inner life as Claudex:",
  ],
];

/** A prompt with Codex's identity sentences rewritten for Claudex. */
export function claudexIdentity(text: string) {
  return identity.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
}

/** Every string in a model entry's prompt fields, rewritten (claudexIdentity). */
function rebrand(value: unknown): unknown {
  if (typeof value === "string") return claudexIdentity(value);
  if (Array.isArray(value)) return value.map(rebrand);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rebrand(entry)]),
    );
  return value;
}

/** A catalog entry with its base instructions and model messages rebranded. */
function rebrandModel(model: Record<string, unknown>): Record<string, unknown> {
  return {
    ...model,
    base_instructions: rebrand(model.base_instructions),
    model_messages: rebrand(model.model_messages),
  };
}

/**
 * `preloadTools` (Capabilities → Tool access mode: Tools already loaded)
 * turns Codex's tool search off for every model, so connector tools are in
 * the request from the start instead of found with `tool_search`.
 */
export function codexModelCatalog({
  preloadTools = false,
  modelEfforts = [],
  reviewModels = [],
}: { preloadTools?: boolean; modelEfforts?: readonly GatewayModelEfforts[]; reviewModels?: readonly string[] } = {}): { models: Record<string, unknown>[] } {
  const models = (bundled.models as Array<Record<string, unknown>>)
    .map(rebrandModel)
    .map((model) =>
      preloadTools ? { ...model, supports_search_tool: false } : model,
    );
  const template = models.find((model) => model.slug === "gpt-5.5");
  if (!template) return { models };
  const gpt6 = {
    ...template,
    // model_info_from_slug's values (codex-rs/models-manager/src/model_info.rs).
    slug: "gpt-6",
    display_name: "gpt-6",
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: "default",
    visibility: "none",
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: claudexIdentity(prompt.text),
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: 272_000,
    max_context_window: 272_000,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null,
    // The one change.
    apply_patch_tool_type: "freeform",
  };
  const baseModels = [...models.filter((model) => model.slug !== "gpt-6"), gpt6];
  const effortsByModel = new Map(modelEfforts.map(({ model, efforts }) => [model, efforts]));
  for (const model of reviewModels) {
    if (model && !effortsByModel.has(model)) effortsByModel.set(model, []);
  }
  const replacements = [...effortsByModel].map(([model, efforts]) => {
    const base = matchingCodexModel(baseModels, model) ?? {
      ...gpt6,
      apply_patch_tool_type: null,
    };
    const alias = {
      ...base, slug: model, display_name: base.slug === model ? base.display_name : model,
      // The runtime's default reviewer may be outside the provider's model catalog.
      ...(reviewModels.includes(model) ? { auto_review_model_override: model } : {}),
    };
    if (!efforts.length) return alias;
    const supportsSummaries = base.supports_reasoning_summaries === true;
    return {
      ...alias,
      supported_reasoning_levels: efforts.map((effort) => ({ effort, description: "" })),
      default_reasoning_level: typeof base.default_reasoning_level === "string" &&
        efforts.includes(base.default_reasoning_level) ? base.default_reasoning_level : null,
      // This SDK flag also controls whether the Responses reasoning object is sent.
      supports_reasoning_summaries: true,
      default_reasoning_summary: supportsSummaries ? base.default_reasoning_summary : "none",
    };
  });
  return withPreloadedTwins([
    ...baseModels.filter((entry) => !replacements.some(({ slug }) => slug === entry.slug)),
    ...replacements,
  ]);
}

/** SDK prefix matching must not give a sibling alias an undeclared effort menu. */
export function codexCatalogEfforts(models: readonly string[], published: readonly GatewayModelEfforts[] = []) {
  const declared = published.filter(({ efforts }) => efforts.length > 0);
  const siblings = [...new Set(models)].filter((model) =>
    !declared.some((entry) => entry.model === model) &&
    declared.some((entry) => model.startsWith(entry.model)));
  return [...declared, ...siblings.map((model) => ({ model, efforts: [] }))];
}

function matchingCodexModel(models: readonly Record<string, unknown>[], model: string) {
  let best: Record<string, unknown> | undefined, length = 0;
  for (const entry of models) {
    const slug = entry.slug;
    if (typeof slug === "string" && slug.length > length && model.startsWith(slug)) {
      best = entry;
      length = slug.length;
    }
  }
  return best;
}

/** The published effort contract does not enable model summaries. */
export function codexModelSupportsSummaries(model: string) {
  const entry = matchingCodexModel(bundled.models, model);
  return entry?.supports_reasoning_summaries === true &&
    (!model.startsWith("gpt-6") || String(entry.slug).length > "gpt-6".length);
}

/**
 * Each model's twin that sends connector tools from the start (Tool access →
 * Tools already loaded for one conversation: shared/tool-search-mode.ts).
 * Hidden from Codex's own pickers; the gateway sends the real slug upstream.
 */
function withPreloadedTwins<T extends Record<string, unknown>>(models: T[]) {
  return {
    models: [
      ...models,
      ...models.map((model): T => ({
        ...model,
        slug: `${model.slug}${preloadedModelSuffix}`,
        visibility: "none",
        supports_search_tool: false,
      })),
    ],
  };
}

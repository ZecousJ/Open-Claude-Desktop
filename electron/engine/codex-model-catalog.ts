import bundled from "./codex-models.json";
import prompt from "./codex-prompt.json";
import { preloadedModelSuffix } from "../../shared/tool-search-mode";

/**
 * The model catalog Codex starts with (`-c model_catalog_json=…`).
 *
 * `codex-models.json` is the catalog bundled with the pinned Codex (`codex
 * debug models --bundled`, @openai/codex 0.144.1; the runner image pins the
 * same version). It knows GPT-5.x only, so the GPT-6 models the service sells
 * run on Codex's fallback metadata (`model_info_from_slug`), which has no
 * apply_patch tool: the model wrote files with `apply_patch <<'PATCH'` inside a
 * shell command and nothing showed until the whole file was written.
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
 * OpenAI's Codex CLI. In Claudex it is Claudex. Only those
 * identity sentences change; everything else in the prompts, including Codex as
 * the name of tools and settings, is kept.
 */
const identity: [RegExp, string][] = [
  [
    /You are Codex, a coding agent based on GPT-5\./g,
    "You are Claudex, a coding agent.",
  ],
  [/You are Codex, an agent based on GPT-5\./g, "You are Claudex, an agent."],
  [
    /You are GPT-[\d.]+ running in the Codex CLI, a terminal-based coding assistant\./g,
    "You are Claudex, an assistant running in the Claudex app.",
  ],
  [
    /You are a coding agent running in the Codex CLI, a terminal-based coding assistant\./g,
    "You are Claudex, a coding agent running in the Claudex app.",
  ],
  [
    /Codex CLI is an open source project led by OpenAI\./g,
    "Claudex is an open-source project.",
  ],
  [
    /Within this context, Codex refers to the open-source agentic coding interface \(not the old Codex language model built by OpenAI\)\./g,
    "Within this context, Claudex refers to the app you are running in.",
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
export function codexModelCatalog({ preloadTools = false } = {}) {
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
  return withPreloadedTwins([
    ...models.filter((model) => model.slug !== "gpt-6"),
    gpt6,
  ]);
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

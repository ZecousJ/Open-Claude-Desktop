/**
 * CLAUDEX: admin API for the client policy (/admin/claudex/policy), stored in
 * the settings key claudex_client_policy (backend: internal/claudex/policy).
 *
 * A policy patch lists only the fields it sets; a missing field inherits
 * (built-in defaults -> defaults -> plan override -> user override).
 * Bypass permissions is not policy-controlled (owner decision 3): no field or
 * mode value here can turn it off, and the server rejects "bypass".
 */

import { apiClient } from '../../client'

/** Permission modes an administrator may restrict (never Bypass). */
export type PolicyMode = 'auto' | 'manual' | 'acceptEdits' | 'plan'

/** Platforms the desktop app reports in X-Claudex-Platform. */
export type PolicyPlatform = 'darwin' | 'win32' | 'linux'

/** One list for every platform, or a list per platform (`default` for any other). */
export type PermissionModesValue = PolicyMode[] | Partial<Record<PolicyPlatform | 'default', PolicyMode[]>>

/** An MCP server (connector) the desktop app may run. */
export interface ConnectorRule {
  name: string
  url_prefix?: string
  command?: string
  /**
   * Arguments of a local command. The desktop app matches the program and
   * its argument list exactly; no args means the server takes no arguments.
   */
  args?: string[]
}

export interface PolicyLearnMoreLink {
  label: string
  url: string
}

/** Links shown in the desktop app; null means none (the server falls back where it can). */
export interface PolicyLinksPatch {
  help?: string | null
  plans?: string | null
  apps?: string | null
  get_more_usage?: string | null
  usage_learn_more?: string | null
  learn_more?: PolicyLearnMoreLink[]
}

export interface PolicyAttachmentsPatch {
  /** Per-file ceiling in MB, (0, 20]; null keeps the built-in ceilings. */
  max_megabytes?: number | null
  /** Allowed extensions; empty turns attachments off. */
  types?: string[]
}

/** Every field is optional: a missing field inherits. */
export interface PolicyPatch {
  permission_modes?: PermissionModesValue
  incognito?: boolean
  web_search?: boolean
  web_search_default?: boolean
  voice?: boolean
  local_mcp_editing?: boolean
  developer_mode_enabled?: boolean
  remote_images?: boolean
  /** null allows any domain. */
  remote_image_domains?: string[] | null
  external_links?: boolean
  trusted_link_domains?: string[]
  /** null: no restriction; []: none; otherwise only these (a string is a bare name). */
  connectors?: Array<ConnectorRule | string> | null
  attachments?: PolicyAttachmentsPatch
  links?: PolicyLinksPatch
  usage_banner?: { warn_percent?: number }
  /** null: no label (hides an inherited one). */
  plan_label?: string | null
  scheduled_tasks?: { enabled?: boolean; max_tasks?: number | null; approval_lifetime_days?: number | null }
  approvals_always_allow?: boolean
  /** Memory in Chat and Cowork; each field inherits on its own. */
  memory?: PolicyMemoryPatch
  /** Research mode; needs web search. */
  research?: PolicyResearchPatch
  /** The desktop app's built-in browser tools (Code). */
  browser?: PolicyBrowserPatch
  /** SSH remote environments. */
  ssh_remote?: boolean
  /** Dynamic workflows may run (Claude Code). */
  workflows?: boolean
  /** Every workflow run is approved, also when permissions are bypassed. */
  workflow_approval_required?: boolean
  /** https mirror for the Codex runtime on SSH hosts; null for the npm registry. */
  codex_runtime_mirror?: string | null
  /** Computer use (off unless turned on). */
  computer_use?: PolicyComputerUsePatch
}

export interface PolicyMemoryPatch {
  enabled?: boolean
  search_chats?: boolean
  generate?: boolean
  /** The user's switches start on until the user chooses. */
  default_on?: boolean
  /** Summary model; null for the plan's default model. */
  model?: string | null
}

export interface PolicyResearchPatch {
  enabled?: boolean
  x_search?: boolean
  /** 1–200. */
  max_searches_per_turn?: number
}

export interface PolicyBrowserPatch {
  enabled?: boolean
  external_sites?: boolean
  allow_script?: boolean
  dev_servers?: boolean
  /** Added to the domains the layers below block (a union; never unblocks). */
  blocked_domains?: string[]
}

export interface PolicyComputerUsePatch {
  enabled?: boolean
  allow_full_control?: boolean
  /** Added to the apps the layers below deny (a union; never allows again). */
  denied_apps?: string[]
  /** 1–1000; null keeps the app's own cap. */
  max_actions_per_turn?: number | null
}

export interface PolicyGroupOverride {
  group_id: number
  group_name?: string
  patch: PolicyPatch
}

export interface PolicyUserOverride {
  user_id: number
  email?: string
  patch: PolicyPatch
}

/** The policy as the desktop app receives it (GET /claudex/policy, bootstrap `policy`). */
export interface ResolvedPolicy {
  revision?: number
  group_id?: number | null
  permission_modes: PolicyMode[]
  incognito: boolean
  web_search: boolean
  web_search_default: boolean
  voice: boolean
  local_mcp_editing: boolean
  developer_mode_enabled: boolean
  remote_images: boolean
  remote_image_domains: string[] | null
  external_links: boolean
  trusted_link_domains: string[]
  connectors: ConnectorRule[] | null
  attachments: { max_bytes: number | null; types: string[] }
  links: {
    help: string | null
    plans: string | null
    apps: string | null
    get_more_usage: string | null
    usage_learn_more: string | null
    learn_more: PolicyLearnMoreLink[]
  }
  usage_banner: { warn_percent: number }
  plan_label: string | null
  scheduled_tasks: { enabled: boolean; max_tasks: number | null; approval_lifetime_days?: number }
  approvals_always_allow: boolean
  memory?: { enabled: boolean; search_chats: boolean; generate: boolean; default_on: boolean; model: string | null }
  research?: { enabled: boolean; x_search: boolean; max_searches_per_turn: number }
  browser?: {
    enabled: boolean
    external_sites: boolean
    allow_script: boolean
    dev_servers: boolean
    blocked_domains: string[]
  }
  ssh_remote?: boolean
  workflows?: boolean
  workflow_approval_required?: boolean
  codex_runtime_mirror?: string | null
  computer_use?: {
    enabled: boolean
    allow_full_control: boolean
    denied_apps: string[]
    max_actions_per_turn: number | null
  }
}

/** GET /admin/claudex/policy */
export interface AdminClientPolicy {
  revision: number
  updated_at?: string | null
  updated_by?: number | null
  defaults: PolicyPatch
  group_overrides: PolicyGroupOverride[]
  user_overrides: PolicyUserOverride[]
  /** Built-in defaults in resolved form. */
  builtin?: Partial<ResolvedPolicy> | null
  /** Where empty links fall back to (help -> doc_url, plans and get more usage -> purchase_subscription_url). */
  fallbacks?: { doc_url?: string | null; purchase_subscription_url?: string | null } | null
}

/** PUT /admin/claudex/policy body. `revision` is the one the edit started from. */
export interface UpdateClientPolicyRequest {
  revision: number
  defaults: PolicyPatch
  group_overrides: Array<{ group_id: number; patch: PolicyPatch }>
  user_overrides: Array<{ user_id: number; patch: PolicyPatch }>
}

export interface PreviewClientPolicyRequest {
  group_id: number | null
  user_id: number | null
  platform: PolicyPlatform
  /** An unsaved PUT body to preview instead of the saved policy. */
  draft: UpdateClientPolicyRequest | null
}

export interface PreviewClientPolicyResponse {
  policy: ResolvedPolicy
}

/** GET /admin/claudex/policy */
export async function get(): Promise<AdminClientPolicy> {
  const { data } = await apiClient.get<AdminClientPolicy>('/admin/claudex/policy')
  return data
}

/**
 * PUT /admin/claudex/policy (step-up protected). Fails with 409
 * CLAUDEX_POLICY_REVISION_CONFLICT when someone saved in between.
 */
export async function update(body: UpdateClientPolicyRequest): Promise<AdminClientPolicy> {
  const { data } = await apiClient.put<AdminClientPolicy>('/admin/claudex/policy', body)
  return data
}

/** POST /admin/claudex/policy/preview: what a user of a plan gets on a platform. */
export async function preview(body: PreviewClientPolicyRequest): Promise<PreviewClientPolicyResponse> {
  const { data } = await apiClient.post<PreviewClientPolicyResponse>('/admin/claudex/policy/preview', body)
  return data
}

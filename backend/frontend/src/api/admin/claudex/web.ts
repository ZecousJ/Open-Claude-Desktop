/**
 * CLAUDEX: admin API for the Claudex web app (/admin/claudex/web, W-ADMIN1).
 * Reached as adminAPI.claudex.web.
 *
 * Backend: internal/claudex/web (setting claudex_web), web/usage (setting
 * claudex_web_usage) and webhost (runner tokens, claudex_web_runners).
 * Every write is a step-up call. The two settings carry a revision: a PUT
 * with an old revision answers CLAUDEX_WEB_SETTINGS_CONFLICT or
 * CLAUDEX_WEB_USAGE_SETTINGS_CONFLICT. A runner token is returned once, by
 * createRunner, and never again.
 */

import { apiClient } from '../../client'

/** Who may use the web app while it is on. Administrators are always let in. */
export type WebAccessMode = 'allowlist' | 'everyone'

/** GET and PUT /admin/claudex/web/settings answer. */
export interface WebSettings {
  enabled: boolean
  mode: WebAccessMode
  /** Read while mode is allowlist. */
  allowlist_user_ids: number[]
  allowlist_emails: string[]
  /** Active web sessions one user may have (1 to 50). */
  max_web_sessions_per_user: number
  revision: number
  updated_at?: string | null
  updated_by?: number | null
}

/** PUT body: the whole setting plus the revision it was read at. */
export interface WebSettingsUpdate {
  enabled: boolean
  mode: WebAccessMode
  allowlist_user_ids: number[]
  allowlist_emails: string[]
  max_web_sessions_per_user: number
  revision: number
}

/** GET and PUT /admin/claudex/web/usage/settings answer. */
export interface WebUsageSettings {
  max_concurrent_sessions_per_user: number
  max_concurrent_sessions: number
  max_session_minutes: number
  /** Informational: runner time is recorded, never charged. */
  runner_minute_price_usd: number
  revision: number
  updated_at?: string | null
  updated_by?: number | null
}

export interface WebUsageSettingsUpdate {
  max_concurrent_sessions_per_user: number
  max_concurrent_sessions: number
  max_session_minutes: number
  runner_minute_price_usd: number
  revision: number
}

/** What a runner reports it can serve. */
export interface RunnerCapacity {
  engines: number
  users: number
}

/** The runner's last reported load (only while it is connected). */
export interface RunnerLoad {
  engines: number
  users: number
  rss_mb: number
  at: string
}

/** One row of the runner list: the local runner and the stored ones. */
export interface WebRunner {
  /** Link id: "local" or "r<record id>". */
  id: string
  /** claudex_web_runners.id; absent for the local runner. */
  record_id?: number
  name: string
  local: boolean
  /** Online: linked to the server right now. */
  connected: boolean
  draining: boolean
  disabled: boolean
  version: string
  methods: number
  capacity: RunnerCapacity | null
  load: RunnerLoad | null
  assigned_users: number
  connected_at: string | null
  created_at: string | null
  revoked_at: string | null
  disabled_at: string | null
  last_seen_at: string | null
  labels: Record<string, string> | null
}

export interface WebRunnersView {
  items: WebRunner[]
  local_token_configured: boolean
  active_runs: number
  dropped_frames: number
  users_with_open_tabs: number
}

/** POST /admin/claudex/web/runners answer: the token appears only here. */
export interface CreatedRunner {
  runner: { id: number; name: string; created_at: string }
  token: string
}

export interface RunnerPatch {
  name?: string
  disabled?: boolean
}

export async function getWebSettings(): Promise<WebSettings> {
  const { data } = await apiClient.get<WebSettings>('/admin/claudex/web/settings')
  return data
}

/** PUT /admin/claudex/web/settings (step-up). */
export async function updateWebSettings(body: WebSettingsUpdate): Promise<WebSettings> {
  const { data } = await apiClient.put<WebSettings>('/admin/claudex/web/settings', body)
  return data
}

export async function getWebUsageSettings(): Promise<WebUsageSettings> {
  const { data } = await apiClient.get<WebUsageSettings>('/admin/claudex/web/usage/settings')
  return data
}

/** PUT /admin/claudex/web/usage/settings (step-up). */
export async function updateWebUsageSettings(body: WebUsageSettingsUpdate): Promise<WebUsageSettings> {
  const { data } = await apiClient.put<WebUsageSettings>('/admin/claudex/web/usage/settings', body)
  return data
}

export async function listRunners(): Promise<WebRunnersView> {
  const { data } = await apiClient.get<WebRunnersView>('/admin/claudex/web/runners')
  return data
}

/** POST /admin/claudex/web/runners (step-up). The token is in the answer only. */
export async function createRunner(name: string): Promise<CreatedRunner> {
  const { data } = await apiClient.post<CreatedRunner>('/admin/claudex/web/runners', { name })
  return data
}

/** PATCH /admin/claudex/web/runners/:id (step-up): rename, switch off or on. */
export async function updateRunner(
  recordId: number,
  patch: RunnerPatch
): Promise<{ id: number; name: string; disabled: boolean }> {
  const { data } = await apiClient.patch<{ id: number; name: string; disabled: boolean }>(
    `/admin/claudex/web/runners/${recordId}`,
    patch
  )
  return data
}

/** DELETE /admin/claudex/web/runners/:id (step-up): the token never links again. */
export async function revokeRunner(recordId: number): Promise<void> {
  await apiClient.delete(`/admin/claudex/web/runners/${recordId}`)
}

/** POST /admin/claudex/web/runners/:id/drain (step-up); "local" drains the local runner. */
export async function drainRunner(id: string | number): Promise<void> {
  await apiClient.post(`/admin/claudex/web/runners/${id}/drain`)
}

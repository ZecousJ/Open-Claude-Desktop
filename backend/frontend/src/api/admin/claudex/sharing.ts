/**
 * CLAUDEX: admin API for hosted shares (/admin/claudex/sharing/*, design R1
 * 3.4). Reached as adminAPI.claudex.sharing.
 *
 * Sharing is off until an administrator turns it on. Every write here
 * (settings, take down, restore, delete, resolve a report, block a user,
 * take down all of a user's shares) needs step-up on the server.
 *
 * The bottom half has the pure helpers of the Sharing page's settings form
 * (units, ranges, the same URL rules as the server), so they can be tested
 * without mounting the page.
 */

import { apiClient } from '../../client'
import type { PaginatedResponse } from '@/types'

export type ShareKind = 'conversation' | 'artifact'
/** revoked = deleted by the author or an administrator (listed on request). */
export type ShareStatus = 'active' | 'disabled' | 'revoked'
export type ReportStatus = 'open' | 'resolved' | 'dismissed'
export type ReportReason = 'illegal' | 'harmful' | 'privacy' | 'spam' | 'other'

/** The claudex_sharing setting document. */
export interface SharingSettings {
  /** Master switch; off by default. While off every public page answers 404. */
  enabled: boolean
  conversations: boolean
  artifacts: boolean
  /** "" = the server's frontend URL, then a path the desktop app completes. */
  public_base_url: string
  /** Optional separate host for artifact documents (needs public_base_url). */
  content_base_url: string
  /** "" = the server's own usage-policy document when it has content. */
  usage_policy_url: string
  max_snapshot_bytes: number
  max_artifact_bytes: number
  max_active_per_user: number
  /** 0 = links never expire. */
  default_ttl_days: number
  allow_reports: boolean
}

export type PublicBaseSource = 'setting' | 'frontend_url' | 'none'

/** What the saved settings resolve to on the server. */
export interface SharingEffective {
  /** "" = links are paths (/s/<token>) the desktop app completes. */
  public_base_url: string
  public_base_url_source: PublicBaseSource | string
  usage_policy_url: string
  usage_policy_path: string
  /** false when the server has no database for shares. */
  storage_available: boolean
}

export interface SharingSettingsResponse {
  settings: SharingSettings
  effective: SharingEffective
}

export interface AdminShare {
  id: number
  kind: ShareKind
  source_key: string
  title: string
  status: ShareStatus
  disabled_reason: string
  /** /s/<token> */
  path: string
  /** Absolute link, or "" when the server has no public base URL. */
  url: string
  created_at: string
  snapshot_at: string
  updated_at: string
  expires_at: string | null
  view_count: number
  content_bytes: number
  user_id: number
  user_email: string
  open_reports: number
  disabled_by: number | null
  disabled_at: string | null
  last_viewed_at: string | null
  expired: boolean
}

export interface ShareSnapshotMessage {
  role: 'user' | 'assistant' | string
  text: string
  activity?: string[]
  artifacts?: number[]
}

export interface ShareSnapshotArtifact {
  title: string
  language: string
  code_language?: string
  content: string
}

export interface ShareSnapshot {
  kind: ShareKind
  title: string
  mode?: string
  model_label?: string
  messages?: ShareSnapshotMessage[]
  artifacts?: ShareSnapshotArtifact[]
}

export interface ShareContent {
  id: number
  schema: number
  snapshot: ShareSnapshot
}

export interface SharePreview {
  url: string
  path: string
  status: ShareStatus
}

export interface ShareReport {
  id: number
  share_id: number
  share_title: string
  share_kind: ShareKind
  share_status: ShareStatus
  share_user_id: number
  share_path: string
  share_url: string
  reason: ReportReason | string
  detail: string
  status: ReportStatus
  created_at: string
  resolved_at: string | null
  resolved_by: number | null
  /**
   * From the app's Report chat (empty or false from the public page, and on
   * servers before it): the report form's category, the reporter's optional
   * name and e-mail, the signed-in account that sent it, and "Opt out of
   * training on this report".
   */
  category?: string
  reporter_name?: string
  reporter_email?: string
  reporter_user_id?: number | null
  opt_out_of_training?: boolean
}

/**
 * A report sent from the app's Report artifact. The artifact lives on the
 * reporter's computer, so the report keeps a copy of it (fetched with
 * getArtifactReport); the list leaves the copy out.
 */
export interface ArtifactReport {
  id: number
  user_id: number
  user_email: string
  title: string
  language: string
  /** The artifact's whole size; content_truncated when the copy is shorter. */
  content_bytes: number
  content_truncated: boolean
  reason: ReportReason | string
  category: string
  notes: string
  reporter_name: string
  reporter_email: string
  opt_out_of_training: boolean
  status: ReportStatus
  created_at: string
  resolved_at: string | null
  resolved_by: number | null
}

export interface ArtifactReportContent extends ArtifactReport {
  content: string
}

export type ArtifactResolveAction = 'dismiss' | 'resolve'

export interface ShareBlock {
  user_id: number
  user_email: string
  reason: string
  created_by: number | null
  created_at: string
}

export interface SharesQuery {
  /** "" = active and taken-down shares. */
  status?: ShareStatus
  kind?: ShareKind
  user_id?: number
  /** Title or author e-mail. */
  q?: string
  page?: number
  page_size?: number
}

export interface ReportsQuery {
  status?: ReportStatus
  share_id?: number
  page?: number
  page_size?: number
}

export interface PageQuery {
  page?: number
  page_size?: number
}

export type ResolveAction = 'dismiss' | 'disable'

const BASE = '/admin/claudex/sharing'

/** GET /admin/claudex/sharing/settings */
export async function getSettings(): Promise<SharingSettingsResponse> {
  const { data } = await apiClient.get<SharingSettingsResponse>(`${BASE}/settings`)
  return data
}

/** PUT /admin/claudex/sharing/settings (step-up). */
export async function updateSettings(body: SharingSettings): Promise<SharingSettingsResponse> {
  const { data } = await apiClient.put<SharingSettingsResponse>(`${BASE}/settings`, body)
  return data
}

/** GET /admin/claudex/sharing/shares */
export async function listShares(query: SharesQuery = {}): Promise<PaginatedResponse<AdminShare>> {
  const { data } = await apiClient.get<PaginatedResponse<AdminShare>>(`${BASE}/shares`, { params: query })
  return data
}

/** GET /admin/claudex/sharing/shares/:id */
export async function getShare(id: number): Promise<AdminShare> {
  const { data } = await apiClient.get<AdminShare>(`${BASE}/shares/${id}`)
  return data
}

/** GET /admin/claudex/sharing/shares/:id/content: the stored snapshot, for review. */
export async function getShareContent(id: number): Promise<ShareContent> {
  const { data } = await apiClient.get<ShareContent>(`${BASE}/shares/${id}/content`)
  return data
}

/** GET /admin/claudex/sharing/shares/:id/preview: the public page address. */
export async function getSharePreview(id: number): Promise<SharePreview> {
  const { data } = await apiClient.get<SharePreview>(`${BASE}/shares/${id}/preview`)
  return data
}

/** POST /admin/claudex/sharing/shares/:id/disable {reason} (step-up): take the share down. */
export async function disableShare(id: number, reason = ''): Promise<AdminShare> {
  const { data } = await apiClient.post<AdminShare>(`${BASE}/shares/${id}/disable`, { reason })
  return data
}

/** POST /admin/claudex/sharing/shares/:id/enable (step-up): put a taken-down share back online. */
export async function enableShare(id: number): Promise<AdminShare> {
  const { data } = await apiClient.post<AdminShare>(`${BASE}/shares/${id}/enable`, {})
  return data
}

/** DELETE /admin/claudex/sharing/shares/:id (step-up): delete the content for good. */
export async function deleteShare(id: number): Promise<{ deleted: boolean }> {
  const { data } = await apiClient.delete<{ deleted: boolean }>(`${BASE}/shares/${id}`)
  return data
}

/** GET /admin/claudex/sharing/reports */
export async function listReports(query: ReportsQuery = {}): Promise<PaginatedResponse<ShareReport>> {
  const { data } = await apiClient.get<PaginatedResponse<ShareReport>>(`${BASE}/reports`, { params: query })
  return data
}

/**
 * POST /admin/claudex/sharing/reports/:id/resolve (step-up). "disable" also
 * takes the share down (with `reason`) and closes its other open reports.
 */
export async function resolveReport(id: number, action: ResolveAction, reason = ''): Promise<ShareReport> {
  const { data } = await apiClient.post<ShareReport>(`${BASE}/reports/${id}/resolve`, { action, reason })
  return data
}

/** GET /admin/claudex/sharing/artifact-reports (newest first, without the copies) */
export async function listArtifactReports(
  query: Omit<ReportsQuery, 'share_id'> = {}
): Promise<PaginatedResponse<ArtifactReport>> {
  const { data } = await apiClient.get<PaginatedResponse<ArtifactReport>>(`${BASE}/artifact-reports`, { params: query })
  return data
}

/** GET /admin/claudex/sharing/artifact-reports/:id: one report with the artifact copy. */
export async function getArtifactReport(id: number): Promise<ArtifactReportContent> {
  const { data } = await apiClient.get<ArtifactReportContent>(`${BASE}/artifact-reports/${id}`)
  return data
}

/**
 * POST /admin/claudex/sharing/artifact-reports/:id/resolve (step-up). The
 * artifact is not on the server, so nothing is taken down: "resolve" records
 * that the administrator acted on it.
 */
export async function resolveArtifactReport(id: number, action: ArtifactResolveAction): Promise<ArtifactReport> {
  const { data } = await apiClient.post<ArtifactReport>(`${BASE}/artifact-reports/${id}/resolve`, { action })
  return data
}

/** GET /admin/claudex/sharing/blocks */
export async function listBlocks(query: PageQuery = {}): Promise<PaginatedResponse<ShareBlock>> {
  const { data } = await apiClient.get<PaginatedResponse<ShareBlock>>(`${BASE}/blocks`, { params: query })
  return data
}

/**
 * PUT /admin/claudex/sharing/blocks/:user_id {reason} (step-up): the user can
 * no longer create or update shares; existing shares stay online.
 */
export async function blockUser(userId: number, reason = ''): Promise<ShareBlock> {
  const { data } = await apiClient.put<ShareBlock>(`${BASE}/blocks/${userId}`, { reason })
  return data
}

/** DELETE /admin/claudex/sharing/blocks/:user_id (step-up) */
export async function unblockUser(userId: number): Promise<{ deleted: boolean }> {
  const { data } = await apiClient.delete<{ deleted: boolean }>(`${BASE}/blocks/${userId}`)
  return data
}

/** POST /admin/claudex/sharing/users/:user_id/disable-all {reason} (step-up) */
export async function disableAllOfUser(userId: number, reason = ''): Promise<{ disabled: number }> {
  const { data } = await apiClient.post<{ disabled: number }>(`${BASE}/users/${userId}/disable-all`, { reason })
  return data
}

// ---------------------------------------------------------------------------
// Settings form helpers (the server validates again and is authoritative).

/** Limits of the settings, the same as the server (sharing/settings.go). */
export const SHARING_LIMITS = {
  minSnapshotKiB: 64,
  maxSnapshotKiB: 32 * 1024,
  minArtifactKiB: 16,
  maxActivePerUser: 100000,
  maxTTLDays: 3650,
  maxReasonLength: 500,
  maxUrlLength: 2048
} as const

export const SHARING_DEFAULTS: SharingSettings = {
  enabled: false,
  conversations: true,
  artifacts: true,
  public_base_url: '',
  content_base_url: '',
  usage_policy_url: '',
  max_snapshot_bytes: 8 << 20,
  max_artifact_bytes: 2 << 20,
  max_active_per_user: 200,
  default_ttl_days: 0,
  allow_reports: true
}

/** The Sharing page's form; sizes are whole KiB. */
export interface SharingForm {
  enabled: boolean
  conversations: boolean
  artifacts: boolean
  publicBaseUrl: string
  contentBaseUrl: string
  usagePolicyUrl: string
  maxSnapshotKiB: number | string
  maxArtifactKiB: number | string
  maxActivePerUser: number | string
  defaultTtlDays: number | string
  allowReports: boolean
}

export type SharingFormField =
  | 'public_base_url'
  | 'content_base_url'
  | 'usage_policy_url'
  | 'max_snapshot_bytes'
  | 'max_artifact_bytes'
  | 'max_active_per_user'
  | 'default_ttl_days'

export type SharingFormProblem =
  | 'baseUrl'
  | 'httpsUrl'
  | 'requiresPublicBase'
  | 'sameHost'
  | 'snapshotSize'
  | 'artifactSize'
  | 'activePerUser'
  | 'ttlDays'

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Fills missing or malformed fields with the server defaults. */
export function normalizeSharingSettings(raw: Partial<SharingSettings> | null | undefined): SharingSettings {
  const s = (raw ?? {}) as Partial<SharingSettings>
  const d = SHARING_DEFAULTS
  return {
    enabled: bool(s.enabled, d.enabled),
    conversations: bool(s.conversations, d.conversations),
    artifacts: bool(s.artifacts, d.artifacts),
    public_base_url: str(s.public_base_url),
    content_base_url: str(s.content_base_url),
    usage_policy_url: str(s.usage_policy_url),
    max_snapshot_bytes: num(s.max_snapshot_bytes, d.max_snapshot_bytes),
    max_artifact_bytes: num(s.max_artifact_bytes, d.max_artifact_bytes),
    max_active_per_user: num(s.max_active_per_user, d.max_active_per_user),
    default_ttl_days: num(s.default_ttl_days, d.default_ttl_days),
    allow_reports: bool(s.allow_reports, d.allow_reports)
  }
}

export function sharingFormFromSettings(raw: Partial<SharingSettings> | null | undefined): SharingForm {
  const s = normalizeSharingSettings(raw)
  return {
    enabled: s.enabled,
    conversations: s.conversations,
    artifacts: s.artifacts,
    publicBaseUrl: s.public_base_url,
    contentBaseUrl: s.content_base_url,
    usagePolicyUrl: s.usage_policy_url,
    maxSnapshotKiB: Math.round(s.max_snapshot_bytes / 1024),
    maxArtifactKiB: Math.round(s.max_artifact_bytes / 1024),
    maxActivePerUser: s.max_active_per_user,
    defaultTtlDays: s.default_ttl_days,
    allowReports: s.allow_reports
  }
}

function whole(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) ? n : null
}

function trimBase(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** The settings body a form saves (the page validates first, so unparsable numbers never reach the server). */
export function sharingSettingsFromForm(form: SharingForm): SharingSettings {
  return {
    enabled: form.enabled,
    conversations: form.conversations,
    artifacts: form.artifacts,
    public_base_url: trimBase(form.publicBaseUrl),
    content_base_url: trimBase(form.contentBaseUrl),
    usage_policy_url: form.usagePolicyUrl.trim(),
    max_snapshot_bytes: (whole(form.maxSnapshotKiB) ?? 0) * 1024,
    max_artifact_bytes: (whole(form.maxArtifactKiB) ?? 0) * 1024,
    max_active_per_user: whole(form.maxActivePerUser) ?? 0,
    default_ttl_days: whole(form.defaultTtlDays) ?? 0,
    allow_reports: form.allowReports
  }
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  return /^127(\.\d{1,3}){3}$/.test(h)
}

function hasSpaceOrControl(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f || /\s/.test(ch)) return true
  }
  return false
}

/**
 * Parses a public or content base URL the way the server does: https (http
 * only for a loopback host), no user info, query or fragment. Returns the
 * host name, or null when the value is not acceptable.
 */
export function parseBaseUrl(value: string): string | null {
  const text = value.trim()
  if (!text || text.length > SHARING_LIMITS.maxUrlLength || hasSpaceOrControl(text)) return null
  if (text.includes('#') || text.includes('?')) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (!url.hostname || url.username || url.password) return null
  if (url.protocol === 'https:') return url.hostname.toLowerCase()
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.hostname.toLowerCase()
  return null
}

function isHttpsUrl(value: string): boolean {
  const text = value.trim()
  if (text.length > SHARING_LIMITS.maxUrlLength || /\s/.test(text)) return false
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
  } catch {
    return false
  }
}

function inRange(value: unknown, min: number, max: number): boolean {
  const n = whole(value)
  return n !== null && n >= min && n <= max
}

/** Problems of a form, keyed by the server's field names (empty = fine). */
export function validateSharingForm(form: SharingForm): Partial<Record<SharingFormField, SharingFormProblem>> {
  const problems: Partial<Record<SharingFormField, SharingFormProblem>> = {}
  const publicHost = form.publicBaseUrl.trim() ? parseBaseUrl(form.publicBaseUrl) : ''
  if (publicHost === null) problems.public_base_url = 'baseUrl'
  if (form.contentBaseUrl.trim()) {
    const contentHost = parseBaseUrl(form.contentBaseUrl)
    if (contentHost === null) problems.content_base_url = 'baseUrl'
    else if (!form.publicBaseUrl.trim()) problems.content_base_url = 'requiresPublicBase'
    else if (publicHost && publicHost === contentHost) problems.content_base_url = 'sameHost'
  }
  if (form.usagePolicyUrl.trim() && !isHttpsUrl(form.usagePolicyUrl)) problems.usage_policy_url = 'httpsUrl'
  const L = SHARING_LIMITS
  if (!inRange(form.maxSnapshotKiB, L.minSnapshotKiB, L.maxSnapshotKiB)) problems.max_snapshot_bytes = 'snapshotSize'
  const snapshotKiB = whole(form.maxSnapshotKiB)
  const artifactMax = snapshotKiB !== null && problems.max_snapshot_bytes === undefined ? snapshotKiB : L.maxSnapshotKiB
  if (!inRange(form.maxArtifactKiB, L.minArtifactKiB, artifactMax)) problems.max_artifact_bytes = 'artifactSize'
  if (!inRange(form.maxActivePerUser, 1, L.maxActivePerUser)) problems.max_active_per_user = 'activePerUser'
  if (!inRange(form.defaultTtlDays, 0, L.maxTTLDays)) problems.default_ttl_days = 'ttlDays'
  return problems
}

/**
 * Length of a take-down or block reason the way the server counts it
 * (cleanLabel, then characters): runs of spaces and control characters become
 * one space, and an emoji counts once.
 */
export function reasonLength(reason: string): number {
  let count = 0
  let space = false
  for (const ch of reason) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f || code === 0xa0 || code === 0x2028 || code === 0x2029 || code === 0x3000) {
      space = true
      continue
    }
    if (space && count > 0) count++
    space = false
    count++
  }
  return count
}

/** Link to open a share's public page: the absolute URL, else the path on this console's host. */
export function shareLink(url: string | null | undefined, path: string | null | undefined, origin: string): string {
  if (url) return url
  if (!path) return ''
  return `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
}

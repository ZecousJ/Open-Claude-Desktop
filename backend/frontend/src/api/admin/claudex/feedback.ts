/**
 * CLAUDEX: admin API for diagnostics and reply feedback from the desktop app
 * (design 2.9). Reached as adminAPI.claudex.feedback.
 *
 * Nothing is collected until an admin turns a kind on here, and the desktop
 * app only sends reports from users who agreed in its settings.
 */

import { apiClient } from '../../client'
import type { PaginatedResponse } from '@/types'

export interface DiagnosticsSettings {
  enabled: boolean
  /** 1 to 365 */
  retention_days: number
  /** 1 to 1000 */
  max_per_user_per_day: number
}

export interface ReplyFeedbackSettings {
  enabled: boolean
  /** 1 to 730 */
  retention_days: number
  /** Keep the conversation excerpt a user chose to include. */
  allow_conversation_excerpt: boolean
  /** 1 to 1000 */
  max_per_user_per_day: number
}

export interface FeedbackSettings {
  diagnostics: DiagnosticsSettings
  feedback: ReplyFeedbackSettings
}

export const DIAGNOSTIC_KINDS = [
  'turn_error',
  'gateway_refusal',
  'crash',
  'update_failed',
  'mcp_start_failed',
  'provision_failed'
] as const

export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number]

export interface DiagnosticReport {
  id: number
  report_uuid: string
  user_id: number
  user_email?: string | null
  device_id?: number | null
  kind: string
  code: string
  message: string
  request_id: string
  model: string
  app_version: string
  codex_version: string
  platform: string
  arch: string
  os_version: string
  context?: Record<string, unknown> | null
  occurred_at: string
  created_at: string
}

export type FeedbackRating = 'up' | 'down'

export interface FeedbackEntry {
  id: number
  feedback_uuid: string
  user_id: number
  user_email?: string | null
  rating: FeedbackRating
  categories: string[] | null
  comment?: string | null
  model: string
  request_id: string
  /** Only present when the user chose to include it and excerpts are allowed. */
  conversation_excerpt?: string | null
  app_version: string
  platform: string
  created_at: string
}

export interface DiagnosticsQuery {
  user_id?: number
  code?: string
  kind?: string
  app_version?: string
  /** RFC 3339 */
  from?: string
  /** RFC 3339, exclusive (created_at < to) */
  to?: string
  page?: number
  page_size?: number
}

export interface FeedbackQuery {
  rating?: FeedbackRating
  user_id?: number
  /** RFC 3339 */
  from?: string
  /** RFC 3339, exclusive (created_at < to) */
  to?: string
  page?: number
  page_size?: number
}

/** GET /admin/claudex/feedback-settings */
export async function getSettings(): Promise<FeedbackSettings> {
  const { data } = await apiClient.get<FeedbackSettings>('/admin/claudex/feedback-settings')
  return data
}

/** PUT /admin/claudex/feedback-settings (step-up). */
export async function updateSettings(body: FeedbackSettings): Promise<FeedbackSettings> {
  const { data } = await apiClient.put<FeedbackSettings>('/admin/claudex/feedback-settings', body)
  return data
}

/** GET /admin/claudex/diagnostics */
export async function listDiagnostics(query: DiagnosticsQuery = {}): Promise<PaginatedResponse<DiagnosticReport>> {
  const { data } = await apiClient.get<PaginatedResponse<DiagnosticReport>>('/admin/claudex/diagnostics', {
    params: query
  })
  return data
}

/** GET /admin/claudex/diagnostics/:id */
export async function getDiagnostic(id: number): Promise<DiagnosticReport> {
  const { data } = await apiClient.get<DiagnosticReport>(`/admin/claudex/diagnostics/${id}`)
  return data
}

/** DELETE /admin/claudex/diagnostics/:id */
export async function deleteDiagnostic(id: number): Promise<void> {
  await apiClient.delete(`/admin/claudex/diagnostics/${id}`)
}

/** GET /admin/claudex/feedback */
export async function listFeedback(query: FeedbackQuery = {}): Promise<PaginatedResponse<FeedbackEntry>> {
  const { data } = await apiClient.get<PaginatedResponse<FeedbackEntry>>('/admin/claudex/feedback', {
    params: query
  })
  return data
}

/** GET /admin/claudex/feedback/:id */
export async function getFeedback(id: number): Promise<FeedbackEntry> {
  const { data } = await apiClient.get<FeedbackEntry>(`/admin/claudex/feedback/${id}`)
  return data
}

/** DELETE /admin/claudex/feedback/:id */
export async function deleteFeedback(id: number): Promise<void> {
  await apiClient.delete(`/admin/claudex/feedback/${id}`)
}

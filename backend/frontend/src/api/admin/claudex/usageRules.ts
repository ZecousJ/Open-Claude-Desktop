/**
 * CLAUDEX: admin API for the Claudex usage rules (backend B5,
 * internal/claudex/usage; reached as adminAPI.claudex.usageRules).
 *
 *   GET/POST        /admin/claudex/usage-rules            (POST needs step-up)
 *   PUT/DELETE      /admin/claudex/usage-rules/:id        (step-up)
 *   GET             /admin/claudex/usage-rules/:id/counters
 *   POST            /admin/claudex/usage-rules/:id/reset  (step-up)
 *   GET             /admin/claudex/users/:user_id/usage-status
 *
 * Rules apply to every key of the request's group, device keys and keys the
 * user created alike (owner decision 8).
 */

import { apiClient } from '../../client'
import type { PaginatedResponse } from '@/types'

/** session: the 5-hour "Current session"; all_models / models: weekly-style limits. */
export type UsageRuleKind = 'session' | 'all_models' | 'models'

export interface UsageRule {
  id: number
  /** null = all groups. */
  group_id: number | null
  group_name?: string
  /** The rule's group was deleted: the rule no longer applies (design 1.3). */
  group_deleted?: boolean
  kind: UsageRuleKind
  label: string
  /** ["*"] for session and all_models; exact names or a trailing * otherwise. */
  model_patterns: string[]
  /** 3600-2592000. */
  window_seconds: number
  limit_usd: number
  enabled: boolean
  show_in_client: boolean
  sort_order: number
  created_by?: number | null
  created_at?: string
  updated_at?: string
}

/** Body of POST /usage-rules and PUT /usage-rules/:id. */
export interface UsageRuleInput {
  group_id: number | null
  kind: UsageRuleKind
  label: string
  model_patterns: string[]
  window_seconds: number
  limit_usd: number
  enabled: boolean
  show_in_client: boolean
  sort_order: number
}

export interface UsageCounter {
  user_id: number
  user_email: string
  window_start: string
  window_end: string
  used_usd: number
  request_count: number
  updated_at: string
}

export interface UsageStatusWindow {
  id: string
  source: 'rule' | 'subscription' | 'key' | string
  kind: string
  label: string
  window: string
  window_seconds: number
  used_usd: number
  limit_usd: number
  percent: number
  active: boolean
  window_start: string | null
  resets_at: string | null
  models: string[] | null
  exceeded: boolean
}

/** Same shape as the user's GET /api/v1/claudex/usage-status. */
export interface UsageStatus {
  plan: {
    group_id: number
    group_name: string
    subscription_id?: number | null
    billing_mode?: string
  } | null
  windows: UsageStatusWindow[]
  balance?: { balance_usd: number } | null
  blocked?: {
    blocked: boolean
    window_id: string | null
    reason: string | null
    resets_at: string | null
  } | null
  updated_at?: string
}

/** GET /admin/claudex/usage-rules (every rule when groupId is omitted). */
export async function listRules(groupId?: number | null): Promise<UsageRule[]> {
  const { data } = await apiClient.get<{ items: UsageRule[] } | UsageRule[]>('/admin/claudex/usage-rules', {
    params: groupId ? { group_id: groupId } : undefined
  })
  if (Array.isArray(data)) return data
  return data?.items ?? []
}

/** POST /admin/claudex/usage-rules (step-up). */
export async function createRule(input: UsageRuleInput): Promise<UsageRule> {
  const { data } = await apiClient.post<UsageRule>('/admin/claudex/usage-rules', input)
  return data
}

/** PUT /admin/claudex/usage-rules/:id (step-up). */
export async function updateRule(id: number, input: UsageRuleInput): Promise<UsageRule> {
  const { data } = await apiClient.put<UsageRule>(`/admin/claudex/usage-rules/${id}`, input)
  return data
}

/** DELETE /admin/claudex/usage-rules/:id (step-up); its counters go with it. */
export async function deleteRule(id: number): Promise<{ deleted: boolean }> {
  const { data } = await apiClient.delete<{ deleted: boolean }>(`/admin/claudex/usage-rules/${id}`)
  return data
}

/** GET /admin/claudex/usage-rules/:id/counters */
export async function listCounters(
  ruleId: number,
  query: { user_id?: number | null; page?: number; page_size?: number } = {}
): Promise<PaginatedResponse<UsageCounter>> {
  const params: Record<string, number> = { page: query.page ?? 1, page_size: query.page_size ?? 20 }
  if (query.user_id) params.user_id = query.user_id
  const { data } = await apiClient.get<PaginatedResponse<UsageCounter>>(
    `/admin/claudex/usage-rules/${ruleId}/counters`,
    { params }
  )
  return data
}

/** POST /admin/claudex/usage-rules/:id/reset (step-up): clears one user's counter. */
export async function resetCounter(ruleId: number, userId: number): Promise<{ reset: boolean }> {
  const { data } = await apiClient.post<{ reset: boolean }>(`/admin/claudex/usage-rules/${ruleId}/reset`, {
    user_id: userId
  })
  return data
}

/** GET /admin/claudex/users/:user_id/usage-status (what the user sees in Claudex). */
export async function getUserUsageStatus(userId: number, groupId?: number | null): Promise<UsageStatus> {
  const { data } = await apiClient.get<UsageStatus>(`/admin/claudex/users/${userId}/usage-status`, {
    params: groupId ? { group_id: groupId } : undefined
  })
  return data
}

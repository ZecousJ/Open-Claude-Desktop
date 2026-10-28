/**
 * CLAUDEX: admin API for the model catalog (/admin/claudex/models), reached
 * as adminAPI.claudex.models. The server side is the catalog component
 * (internal/claudex/catalog, design §2.4): one row per model and scope, where
 * the scope is either global (group_id null) or one group whose row replaces
 * the global row of the same model for that group's users.
 */

import { apiClient } from '../../client'
import type { PaginatedResponse } from '@/types'

/** Reasoning effort levels, lowest first (the same words as a group's max_reasoning_effort). */
export const CLAUDEX_MODEL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ClaudexModelEffort = (typeof CLAUDEX_MODEL_EFFORTS)[number]

/** Body of POST /admin/claudex/models and PUT /admin/claudex/models/:id. */
export interface ClaudexModelMetaInput {
  model_id: string
  /** null = every group (global); otherwise the group this row applies to. */
  group_id: number | null
  display_name: string
  description: string
  badges: string[]
  sort_order: number
  /** Still sent to the desktop app, which lists it under More models. */
  hidden: boolean
  /** Default model of this scope; saving clears the previous default of the scope. */
  is_default: boolean
  /** null = not known (the app shows no effort choice). */
  supported_efforts: ClaudexModelEffort[] | null
  /** '' = none set. */
  default_effort: ClaudexModelEffort | ''
  context_window: number | null
  auto_compact_tokens: number | null
  /** null = not known. */
  fast_tier: boolean | null
  usage_hint: string
  minimum_desktop_version?: string
}

/** A catalog row as the admin endpoints return it. */
export interface ClaudexModelMeta extends ClaudexModelMetaInput {
  id: number
  /** Name of the row's group ('' for global rows and deleted groups). */
  group_name?: string
  /** The row's group was deleted; the catalog ignores the row. */
  group_deleted?: boolean
  created_by: number | null
  created_at: string
  updated_at: string
}

/**
 * Scope filter of the list: 'all' sends no group_id, 'global' sends
 * group_id=0 (global rows only), a number sends that group's rows only.
 */
export type ClaudexModelScopeFilter = 'all' | 'global' | number

export interface ClaudexModelListQuery {
  scope?: ClaudexModelScopeFilter
  q?: string
  page?: number
  page_size?: number
}

/**
 * Where a candidate model name was found: 'allowlist', 'default_mapped_model',
 * 'channel_pricing', 'channel_mapping' or 'group_pricing' (other values are
 * shown as they are).
 */
export type ClaudexModelCandidateSource = string

export interface ClaudexModelCandidates {
  models: string[]
  sources: Record<string, ClaudexModelCandidateSource[]>
}

/** Query parameters for a scope filter (see ClaudexModelScopeFilter). */
export function scopeParams(scope: ClaudexModelScopeFilter | undefined): { group_id?: number } {
  if (scope === undefined || scope === 'all') return {}
  if (scope === 'global') return { group_id: 0 }
  return { group_id: scope }
}

/** GET /admin/claudex/models?group_id=&q=&page=&page_size= */
export async function list(
  query: ClaudexModelListQuery = {},
  options?: { signal?: AbortSignal }
): Promise<PaginatedResponse<ClaudexModelMeta>> {
  const q = query.q?.trim()
  const { data } = await apiClient.get<PaginatedResponse<ClaudexModelMeta>>('/admin/claudex/models', {
    params: {
      ...scopeParams(query.scope),
      ...(q ? { q } : {}),
      page: query.page ?? 1,
      page_size: query.page_size ?? 50
    },
    signal: options?.signal
  })
  return data
}

/** POST /admin/claudex/models */
export async function create(body: ClaudexModelMetaInput): Promise<ClaudexModelMeta> {
  const { data } = await apiClient.post<ClaudexModelMeta>('/admin/claudex/models', body)
  return data
}

/** PUT /admin/claudex/models/:id (model_id and group_id cannot change). */
export async function update(id: number, body: ClaudexModelMetaInput): Promise<ClaudexModelMeta> {
  const { data } = await apiClient.put<ClaudexModelMeta>(`/admin/claudex/models/${id}`, body)
  return data
}

/** DELETE /admin/claudex/models/:id */
export async function remove(id: number): Promise<{ deleted: boolean }> {
  const { data } = await apiClient.delete<{ deleted: boolean }>(`/admin/claudex/models/${id}`)
  return data
}

/**
 * GET /admin/claudex/models/candidates?group_id= — model names from the
 * group's allowlist, its default mapped model and channel pricing. Without a
 * group (the global scope) the server answers for every group.
 */
export async function candidates(
  groupId: number | null,
  options?: { signal?: AbortSignal }
): Promise<ClaudexModelCandidates> {
  const { data } = await apiClient.get<ClaudexModelCandidates>('/admin/claudex/models/candidates', {
    params: groupId === null ? undefined : { group_id: groupId },
    signal: options?.signal
  })
  return {
    models: Array.isArray(data?.models) ? data.models : [],
    sources: data?.sources && typeof data.sources === 'object' ? data.sources : {}
  }
}

/** Body for a row as it is, e.g. to change one field and save it again. */
export function inputFromRow(row: ClaudexModelMeta): ClaudexModelMetaInput {
  return {
    model_id: row.model_id,
    group_id: row.group_id ?? null,
    display_name: row.display_name ?? '',
    description: row.description ?? '',
    badges: [...(row.badges ?? [])],
    sort_order: row.sort_order ?? 0,
    hidden: !!row.hidden,
    is_default: !!row.is_default,
    supported_efforts: row.supported_efforts ? [...row.supported_efforts] : null,
    default_effort: row.default_effort ?? '',
    context_window: row.context_window ?? null,
    auto_compact_tokens: row.auto_compact_tokens ?? null,
    fast_tier: row.fast_tier ?? null,
    usage_hint: row.usage_hint ?? '',
    minimum_desktop_version: row.minimum_desktop_version ?? ''
  }
}

/** Where a group shows a model in the desktop app's model menu. */
export type ClaudexModelPlacement = 'main' | 'more' | 'hidden'

/** One model of a group (GET /admin/claudex/models/groups). */
export interface ClaudexGroupModel {
  model_id: string
  /** Where the group shows it ('main' when not configured). */
  placement: ClaudexModelPlacement
  /** The group has a placement row for it. */
  configured: boolean
  /** The placement's own order (null: the description's). */
  sort_order: number | null
  /** The effective order the menus use. */
  order: number
  /** The group's key gets the model; a placement of a model it no longer gets shows nowhere. */
  listed: boolean
  /** The group chose it as its default model. */
  is_default: boolean
  /** The shared description's id (0: not described). */
  meta_id: number
  display_name: string
}

export interface ClaudexGroupModels {
  id: number
  name: string
  platform: string
  models: ClaudexGroupModel[]
}

export interface ClaudexPlacementInput {
  model_id: string
  placement: ClaudexModelPlacement
  sort_order: number | null
  /** The group's default model (at most one; never a hidden one). */
  is_default: boolean
}

/** GET /admin/claudex/models/groups — every active group with its models and where it shows them. */
export async function groups(options?: { signal?: AbortSignal }): Promise<ClaudexGroupModels[]> {
  const { data } = await apiClient.get<{ groups: ClaudexGroupModels[] }>('/admin/claudex/models/groups', {
    signal: options?.signal
  })
  return Array.isArray(data?.groups) ? data.groups : []
}

/** PUT /admin/claudex/models/groups/:id/placements — replaces the group's placements. */
export async function setPlacements(groupId: number, items: ClaudexPlacementInput[]): Promise<ClaudexGroupModels> {
  const { data } = await apiClient.put<ClaudexGroupModels>(`/admin/claudex/models/groups/${groupId}/placements`, {
    items
  })
  return data
}

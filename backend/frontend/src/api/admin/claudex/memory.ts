/**
 * CLAUDEX: admin API for user memory (backend R3-S1, internal/claudex/memory;
 * reached as adminAPI.claudex.memory).
 *
 *   GET    /admin/claudex/memory/stats
 *   GET    /admin/claudex/memory/users/:id
 *   DELETE /admin/claudex/memory/users/:id   (step-up)
 *
 * Administrators see metadata only (sizes, revisions, sources, dates, the
 * user's switches) and can clear a user's memory; the server never returns
 * memory text to this console. The memory policy (on/off, which switches
 * users may turn on, their default) lives on the client policy page.
 */

import { apiClient } from '../../client'

/** GET /admin/claudex/memory/stats */
export interface MemoryStats {
  /** Users who turned at least one memory switch on themselves. */
  users_opted_in: number
  /** Users with at least one stored document or edit. */
  users_with_memory: number
  documents: number
  edits: number
  /** Size of every stored document and edit (plaintext bytes). */
  total_bytes: number
  /** False: the server has no fixed secret key (TOTP_ENCRYPTION_KEY), so memory can't be stored. */
  encryption_key_ready: boolean
}

/** A user's stored switches; null fields were never set (the policy default applies). */
export interface MemoryUserPrefs {
  set: boolean
  search_chats: boolean | null
  generate: boolean | null
  updated_at: string | null
}

export type MemorySource = 'user' | 'import' | 'generated'

/** One memory scope: "global" or "project:<uuid>". */
export interface MemoryScopeMeta {
  scope: string
  has_document: boolean
  content_bytes: number
  revision: number
  source: MemorySource | null
  generated_at: string | null
  updated_at: string | null
  edits: number
  edit_bytes: number
}

/** GET /admin/claudex/memory/users/:id: metadata only, never memory text. */
export interface MemoryUserMeta {
  user_id: number
  prefs: MemoryUserPrefs
  scopes: MemoryScopeMeta[]
  documents: number
  edits: number
  total_bytes: number
}

/** DELETE /admin/claudex/memory/users/:id */
export interface MemoryClearResult {
  deleted_docs: number
  deleted_edits: number
}

/** GET /admin/claudex/memory/stats */
export async function getStats(): Promise<MemoryStats> {
  const { data } = await apiClient.get<MemoryStats>('/admin/claudex/memory/stats')
  return data
}

/** GET /admin/claudex/memory/users/:id (404 CLAUDEX_MEMORY_USER_NOT_FOUND for an unknown user). */
export async function getUser(userId: number): Promise<MemoryUserMeta> {
  const { data } = await apiClient.get<MemoryUserMeta>(`/admin/claudex/memory/users/${userId}`)
  return { ...data, scopes: data?.scopes ?? [] }
}

/**
 * DELETE /admin/claudex/memory/users/:id (step-up): deletes every memory
 * document and edit of the user. Their switches stay as they are.
 */
export async function clearUser(userId: number): Promise<MemoryClearResult> {
  const { data } = await apiClient.delete<MemoryClearResult>(`/admin/claudex/memory/users/${userId}`)
  return data
}

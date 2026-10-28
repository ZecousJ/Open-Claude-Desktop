/**
 * CLAUDEX: public Claudex endpoints (backend: internal/claudex, /api/v1/claudex/*).
 * Both need no sign-in and carry no user data.
 */

import { apiClient } from './client'

/** GET /claudex/web-console: whether the web console is for administrators only. */
export interface ClaudexWebConsoleSetting {
  admin_only?: boolean
}

export interface ClaudexServerBuild {
  version: string
  build_type: string
}

/**
 * GET /claudex/release. The server always returns api_version and server; the
 * client release fields are present once the release feature is configured
 * on the server.
 */
export interface ClaudexClientRelease {
  api_version: number
  server: ClaudexServerBuild
  channel?: string
  latest_version?: string
  minimum_version?: string
  state?: 'current' | 'available' | 'required' | 'unknown'
  enforced?: boolean
  download_url?: string | null
  sha256?: string
  release_notes_url?: string
  release_notes_md?: string
  published_at?: string
}

export interface ClaudexReleaseQuery {
  platform?: string
  arch?: string
  channel?: string
  version?: string
}

/** How long the router waits for the web console setting before failing closed. */
export const WEB_CONSOLE_SETTING_TIMEOUT_MS = 3000

export async function getWebConsoleSetting(): Promise<ClaudexWebConsoleSetting> {
  const { data } = await apiClient.get<ClaudexWebConsoleSetting>('/claudex/web-console', {
    timeout: WEB_CONSOLE_SETTING_TIMEOUT_MS
  })
  return data
}

export async function getClientRelease(query: ClaudexReleaseQuery = {}): Promise<ClaudexClientRelease> {
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value) params[key] = value
  }
  const { data } = await apiClient.get<ClaudexClientRelease>('/claudex/release', { params })
  return data
}

export const claudexPublicAPI = {
  getWebConsoleSetting,
  getClientRelease
}

export default claudexPublicAPI

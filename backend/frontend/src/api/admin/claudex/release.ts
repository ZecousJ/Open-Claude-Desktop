/**
 * CLAUDEX: admin API for the desktop release information
 * (/admin/claudex/release, setting claudex_client_release, design 2.2).
 * Reached as adminAPI.claudex.release.
 *
 * The PUT body is the whole setting and replaces what is stored; the server
 * validates it again (CLAUDEX_RELEASE_INVALID with metadata.field).
 */

import { apiClient } from '../../client'

/** Platform keys the server accepts under `downloads`. */
export const RELEASE_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'darwin-universal',
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64'
] as const

export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number]

export interface ReleaseDownload {
  url: string
  /** Empty or 64 lowercase hex characters. */
  sha256: string
}

export interface ReleaseChannel {
  desktop_updater_config?: {
    check_interval_ticks?: number
    staged_peek_min_interval_minutes?: number
  }
  latest_version: string
  minimum_version: string
  /** RFC 3339 time, or null when not set. */
  published_at: string | null
  release_notes_url: string
  /** Markdown; rendered without raw HTML or remote images. */
  release_notes_md: string
  downloads: Partial<Record<ReleasePlatform, ReleaseDownload | null>>
}

export interface ClientReleaseSetting {
  /** Only the `stable` channel exists. */
  channels: { stable?: ReleaseChannel | null }
  /** Refuse device keys of older desktop versions on the gateway (426). Off by default. */
  enforce_minimum_on_gateway: boolean
}

export interface ClientReleaseResponse extends ClientReleaseSetting {
  updated_at?: string | null
}

/** GET /admin/claudex/release */
export async function getRelease(): Promise<ClientReleaseResponse> {
  const { data } = await apiClient.get<ClientReleaseResponse>('/admin/claudex/release')
  return data
}

/** PUT /admin/claudex/release (step-up). Replaces the whole setting; answers with the GET shape. */
export async function updateRelease(body: ClientReleaseSetting): Promise<ClientReleaseResponse> {
  const { data } = await apiClient.put<ClientReleaseResponse>('/admin/claudex/release', body)
  return data
}

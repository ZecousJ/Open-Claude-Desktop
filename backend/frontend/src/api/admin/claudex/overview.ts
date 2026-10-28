/**
 * CLAUDEX: GET /admin/claudex/overview, the Claudex server status.
 */

import { apiClient } from '../../client'

export interface ClaudexServerInfo {
  version: string
  build_type: string
}

export interface ClaudexUpstreamInfo {
  repository: string
  commit: string
}

export interface ClaudexFeatureInfo {
  name: string
  setting_keys: string[]
}

export interface ClaudexOverview {
  api_version: number
  server: ClaudexServerInfo
  upstream: ClaudexUpstreamInfo
  self_update_disabled: boolean
  features: ClaudexFeatureInfo[]
}

/** GET /admin/claudex/overview */
export async function getOverview(): Promise<ClaudexOverview> {
  const { data } = await apiClient.get<ClaudexOverview>('/admin/claudex/overview')
  return data
}

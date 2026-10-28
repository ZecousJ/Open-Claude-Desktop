/**
 * CLAUDEX: admin API for the GitHub connection of Code on the web
 * (/admin/claudex/github, setting claudex_github). Reached as
 * adminAPI.claudex.github.
 *
 * An administrator stores a GitHub OAuth App or GitHub App; users then
 * connect their own GitHub account from the web app and pick repositories
 * for Code sessions. The client secret is write-only: responses only say
 * whether one is stored and show it masked.
 */

import { apiClient } from '../../client'

export type GitHubAppKind = 'oauth_app' | 'github_app'

/** GET and PUT /admin/claudex/github answer. */
export interface GitHubSettingResponse {
  enabled: boolean
  kind: GitHubAppKind
  client_id: string
  client_secret_configured: boolean
  /** "********" plus the last 4 characters of long secrets; "" when none is stored. */
  client_secret_masked: string
  /** Where users reach this service; "" falls back to the frontend URL. */
  public_base_url: string
  /** What to register with GitHub as the authorization callback URL; "" until the address is known. */
  callback_url: string
  /** False while the server has no fixed secret encryption key: a secret can't be stored then. */
  can_store_secret: boolean
  warnings?: string[] | null
}

/**
 * PUT /admin/claudex/github body. Fields left out keep their stored values.
 * client_secret replaces the stored secret; clear_client_secret removes it
 * (and turns GitHub off). Never send both.
 */
export interface GitHubUpdate {
  enabled?: boolean
  kind?: GitHubAppKind
  client_id?: string
  client_secret?: string
  clear_client_secret?: boolean
  public_base_url?: string
}

/** GET /admin/claudex/github */
export async function getGitHub(): Promise<GitHubSettingResponse> {
  const { data } = await apiClient.get<GitHubSettingResponse>('/admin/claudex/github')
  return data
}

/** PUT /admin/claudex/github. Answers with the GET shape (including fresh warnings). */
export async function updateGitHub(body: GitHubUpdate): Promise<GitHubSettingResponse> {
  const { data } = await apiClient.put<GitHubSettingResponse>('/admin/claudex/github', body)
  return data
}

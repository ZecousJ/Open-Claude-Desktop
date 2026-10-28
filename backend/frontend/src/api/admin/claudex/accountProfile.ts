/**
 * CLAUDEX: admin API for the sign-up profile (backend:
 * internal/claudex/profile). Reached as adminAPI.claudex.accountProfile.
 *
 * What a user gave in the step after sign-up: the name Claudex calls them,
 * their birthday and the Terms of Service version they accepted. `profile`
 * is null until they finish the step.
 */

import { apiClient } from '../../client'

export interface AccountProfile {
  display_name: string
  /** YYYY-MM-DD. */
  birthdate: string
  terms_version: string
  /** RFC 3339. */
  terms_accepted_at: string | null
  current_terms_version: string
  minimum_age: number
  complete: boolean
  updated_at?: string | null
}

/** GET /admin/claudex/account-profiles/:user_id */
export async function getAccountProfile(userId: number): Promise<AccountProfile | null> {
  const { data } = await apiClient.get<{ profile: AccountProfile | null }>(
    `/admin/claudex/account-profiles/${userId}`
  )
  return data?.profile ?? null
}

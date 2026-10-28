/**
 * CLAUDEX: admin API for the first-run onboarding answers (backend
 * internal/claudex/onboarding; reached as adminAPI.claudex.onboarding).
 *
 *   GET /admin/claudex/onboarding/users/:id
 *
 * Read only: what a user answered after sign-up (work type, how they heard
 * of the service, connectors connected, the place they chose to code, the
 * first task). Accounts made before the onboarding have none (found false).
 */

import { apiClient } from '../../client'

export interface OnboardingAnswers {
  work_function: string
  hear_about: string
  hear_about_platform: string
  hear_about_other: string
  code_setup: string
  connected_tools: string[]
  first_task: string
}

export interface UserOnboarding {
  found: boolean
  answers: OnboardingAnswers
  started_at: string | null
  finished_at: string | null
}

/** GET /admin/claudex/onboarding/users/:id */
export async function getUser(id: number): Promise<UserOnboarding> {
  const { data } = await apiClient.get<UserOnboarding>(`/admin/claudex/onboarding/users/${id}`)
  return data
}

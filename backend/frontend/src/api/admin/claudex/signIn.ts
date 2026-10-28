/**
 * CLAUDEX: admin API for the sign-in setting claudex_sign_in
 * (/admin/claudex/sign-in, package LOGIN). Reached as adminAPI.claudex.signIn.
 *
 * `email_code_login_enabled` offers "sign in with an email code" on the
 * desktop and web sign-in pages; it only works while SMTP is configured and
 * Backend mode is off (`email_code_login_available` is what the sign-in page
 * gets). `privacy_policy_url` is linked from the sign-in page: empty, an
 * https:// address or a path on this site starting with "/".
 */

import { apiClient } from '../../client'

export interface SignInSetting {
  email_code_login_enabled: boolean
  privacy_policy_url: string
  smtp_configured: boolean
  backend_mode_enabled: boolean
  email_code_login_available: boolean
}

export interface SignInUpdate {
  email_code_login_enabled?: boolean
  privacy_policy_url?: string
}

/** GET /admin/claudex/sign-in */
export async function getSignIn(): Promise<SignInSetting> {
  const { data } = await apiClient.get<SignInSetting>('/admin/claudex/sign-in')
  return data
}

/** PUT /admin/claudex/sign-in (step-up). Fields left out keep their values. */
export async function updateSignIn(body: SignInUpdate): Promise<SignInSetting> {
  const { data } = await apiClient.put<SignInSetting>('/admin/claudex/sign-in', body)
  return data
}

/** Mirrors the server check of privacy_policy_url. */
export function validPrivacyPolicyURL(value: string): boolean {
  const s = value.trim()
  if (s === '') return true
  if (s.length > 2000 || /\s/.test(s)) return false
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  if (s.startsWith('/')) return !s.startsWith('//') && !s.includes('\\')
  try {
    const url = new URL(s)
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

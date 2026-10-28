/**
 * CLAUDEX: form model of the GitHub connection page (/admin/claudex/github).
 * Pure functions so the page stays thin and the rules are testable.
 */

import type { GitHubAppKind, GitHubSettingResponse, GitHubUpdate } from '@/api/admin/claudex/github'

export const CLIENT_ID_MAX_LENGTH = 100
export const CLIENT_SECRET_MAX_LENGTH = 512
const CLIENT_SECRET_MIN_LENGTH = 8
const BASE_URL_MAX_LENGTH = 2048

export interface GitHubForm {
  enabled: boolean
  kind: GitHubAppKind
  clientId: string
  /** The secret being entered; never filled from the server. */
  clientSecret: string
  secretConfigured: boolean
  secretMasked: string
  /** Remove the stored secret on save. */
  clearSecret: boolean
  publicBaseUrl: string
}

export function githubFormFromSetting(setting: GitHubSettingResponse | null): GitHubForm {
  return {
    enabled: setting?.enabled === true,
    kind: setting?.kind === 'github_app' ? 'github_app' : 'oauth_app',
    clientId: setting?.client_id ?? '',
    clientSecret: '',
    secretConfigured: setting?.client_secret_configured === true,
    secretMasked: setting?.client_secret_masked ?? '',
    clearSecret: false,
    publicBaseUrl: setting?.public_base_url ?? ''
  }
}

/** The PUT body: what the form would save. Empty secret fields are left out. */
export function githubUpdateFromForm(form: GitHubForm): GitHubUpdate {
  const body: GitHubUpdate = {
    enabled: form.enabled,
    kind: form.kind,
    client_id: form.clientId.trim(),
    public_base_url: form.publicBaseUrl.trim()
  }
  const secret = form.clientSecret.trim()
  if (form.clearSecret) body.clear_client_secret = true
  else if (secret) body.client_secret = secret
  return body
}

/** Field name (as the server names it) to problem code (admin.claudexGitHub.problems.<code>). */
export function validateGitHubForm(form: GitHubForm): Record<string, string> {
  const problems: Record<string, string> = {}
  const id = form.clientId.trim()
  if (id.length > CLIENT_ID_MAX_LENGTH || /\s/.test(id)) problems.client_id = 'clientIdFormat'
  const secret = form.clientSecret.trim()
  if (secret) {
    if (secret.length < CLIENT_SECRET_MIN_LENGTH || secret.length > CLIENT_SECRET_MAX_LENGTH) {
      problems.client_secret = 'secretLength'
    } else if (/\s/.test(secret)) {
      problems.client_secret = 'secretFormat'
    }
  }
  const base = form.publicBaseUrl.trim()
  if (base) {
    if (base.length > BASE_URL_MAX_LENGTH || !isBaseUrl(base)) problems.public_base_url = 'baseUrl'
  }
  if (form.enabled) {
    if (!id) problems.client_id = 'clientIdRequired'
    const hasSecret = !form.clearSecret && (form.secretConfigured || secret !== '')
    if (!hasSecret) problems.client_secret = 'secretRequired'
  }
  return problems
}

function isBaseUrl(value: string): boolean {
  try {
    const u = new URL(value)
    if (u.username || u.password || u.search || u.hash) return false
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

/**
 * CLAUDEX: form models and checks for the Web app page (W-ADMIN1). The rules
 * follow the server (internal/claudex/web/settings.go, web/usage/settings.go),
 * which checks again and is authoritative.
 *
 * The server stores "who may use the web app" as `enabled` plus `mode`. The
 * page shows one choice with three values: off, administrators (and the
 * users on the list, which may be empty), everyone.
 */

import type {
  WebSettings,
  WebSettingsUpdate,
  WebUsageSettings,
  WebUsageSettingsUpdate
} from '@/api/admin/claudex/web'
import { integerInRange, toInteger, toNumber } from '../general/pageSupport'

export type WebAccessChoice = 'off' | 'allowlist' | 'everyone'

export const MAX_SESSIONS_PER_USER_LIMIT = 50
export const MAX_ALLOWLIST = 1000
export const MAX_EMAIL_LENGTH = 254
export const MAX_CONCURRENT_PER_USER_LIMIT = 20
export const MAX_CONCURRENT_LIMIT = 500
export const MAX_SESSION_MINUTES_LIMIT = 24 * 60
export const MAX_MINUTE_PRICE_USD = 100
export const RUNNER_NAME_MAX_LENGTH = 100

type NumberField = number | string | null

export interface WebAccessForm {
  access: WebAccessChoice
  emails: string[]
  userIds: string[]
  maxSessionsPerUser: NumberField
}

export function accessFromSettings(s: WebSettings | null): WebAccessForm {
  const access: WebAccessChoice = !s || !s.enabled ? 'off' : s.mode === 'everyone' ? 'everyone' : 'allowlist'
  return {
    access,
    emails: [...(s?.allowlist_emails ?? [])],
    userIds: (s?.allowlist_user_ids ?? []).map(String),
    maxSessionsPerUser: s?.max_web_sessions_per_user ?? 10
  }
}

/** Ids the form holds as text, as whole positive numbers (junk drops out; see accessProblems). */
function userIdNumbers(form: WebAccessForm): number[] {
  return form.userIds.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0)
}

export function accessUpdateFromForm(form: WebAccessForm, revision: number): WebSettingsUpdate {
  return {
    enabled: form.access !== 'off',
    mode: form.access === 'everyone' ? 'everyone' : 'allowlist',
    allowlist_user_ids: userIdNumbers(form),
    allowlist_emails: form.emails.map((e) => e.trim().toLowerCase()).filter(Boolean),
    max_web_sessions_per_user: toInteger(form.maxSessionsPerUser) ?? 0,
    revision
  }
}

/** An i18n key (under admin.claudexWeb.problems) when the email is not acceptable. */
export function validateEmail(value: string): string | null {
  const e = value.trim().toLowerCase()
  const at = e.indexOf('@')
  if (e.length > MAX_EMAIL_LENGTH || at <= 0 || at === e.length - 1 || /\s/.test(e)) {
    return 'admin.claudexWeb.problems.email'
  }
  return null
}

export function validateUserId(value: string): string | null {
  return /^[1-9]\d{0,17}$/.test(value.trim()) ? null : 'admin.claudexWeb.problems.userId'
}

/** Problem keys (under admin.claudexWeb.problems) by field. */
export function accessProblems(form: WebAccessForm): Record<string, string> {
  const out: Record<string, string> = {}
  if (!integerInRange(form.maxSessionsPerUser, 1, MAX_SESSIONS_PER_USER_LIMIT)) out.maxSessionsPerUser = 'sessionsPerUser'
  if (form.emails.length > MAX_ALLOWLIST) out.emails = 'listTooLong'
  if (form.userIds.length > MAX_ALLOWLIST) out.userIds = 'listTooLong'
  return out
}

export interface WebLimitsForm {
  maxConcurrentPerUser: NumberField
  maxConcurrent: NumberField
  maxSessionMinutes: NumberField
  minutePriceUsd: NumberField
}

export function limitsFromSettings(s: WebUsageSettings | null): WebLimitsForm {
  return {
    maxConcurrentPerUser: s?.max_concurrent_sessions_per_user ?? 1,
    maxConcurrent: s?.max_concurrent_sessions ?? 2,
    maxSessionMinutes: s?.max_session_minutes ?? 30,
    minutePriceUsd: s?.runner_minute_price_usd ?? 0
  }
}

export function limitsUpdateFromForm(form: WebLimitsForm, revision: number): WebUsageSettingsUpdate {
  return {
    max_concurrent_sessions_per_user: toInteger(form.maxConcurrentPerUser) ?? 0,
    max_concurrent_sessions: toInteger(form.maxConcurrent) ?? 0,
    max_session_minutes: toInteger(form.maxSessionMinutes) ?? 0,
    runner_minute_price_usd: toNumber(form.minutePriceUsd) ?? 0,
    revision
  }
}

export function limitsProblems(form: WebLimitsForm): Record<string, string> {
  const out: Record<string, string> = {}
  if (!integerInRange(form.maxConcurrentPerUser, 1, MAX_CONCURRENT_PER_USER_LIMIT)) out.maxConcurrentPerUser = 'perUser'
  if (!integerInRange(form.maxConcurrent, 1, MAX_CONCURRENT_LIMIT)) out.maxConcurrent = 'concurrent'
  if (
    !out.maxConcurrentPerUser &&
    !out.maxConcurrent &&
    (toInteger(form.maxConcurrentPerUser) ?? 0) > (toInteger(form.maxConcurrent) ?? 0)
  ) {
    out.maxConcurrentPerUser = 'perUserOverTotal'
  }
  if (!integerInRange(form.maxSessionMinutes, 1, MAX_SESSION_MINUTES_LIMIT)) out.maxSessionMinutes = 'minutes'
  const price = toNumber(form.minutePriceUsd)
  if (price === null || price < 0 || price > MAX_MINUTE_PRICE_USD) out.minutePriceUsd = 'price'
  return out
}

/** The runner name as the server keeps it (trimmed, no control characters), '' when unusable. */
export function cleanRunnerName(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

export function runnerNameProblem(value: string): string | null {
  const name = cleanRunnerName(value)
  if (!name) return 'admin.claudexWeb.problems.runnerName'
  // The server counts bytes; a name of 100 characters in a wide script would be cut there.
  if (new TextEncoder().encode(name).length > RUNNER_NAME_MAX_LENGTH) return 'admin.claudexWeb.problems.runnerName'
  return null
}

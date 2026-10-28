/**
 * CLAUDEX: helpers shared by the K4 console pages (general, release, voice,
 * feedback).
 */

import { isStepUpBlocked, stepUpBlockReason, type StepUpController } from '@/composables/useStepUp'

type Translate = (key: string) => string

/**
 * Runs a write through the step-up (TOTP) prompt. A cancelled prompt is
 * rethrown as is (useClaudexSave treats it as "not saved, no error"); a
 * step-up that can't be completed (TOTP not set up, admin API key) becomes an
 * error whose message says why, so the save bar shows it.
 */
export async function runWithStepUp<T>(stepUp: StepUpController, action: () => Promise<T>, t: Translate): Promise<T> {
  try {
    return await stepUp.run(action)
  } catch (err) {
    if (isStepUpBlocked(err)) {
      const reason = stepUpBlockReason(err)
      throw {
        status: 403,
        code: reason,
        message: reason === 'STEP_UP_ADMIN_API_KEY_FORBIDDEN' ? t('stepUp.adminApiKeyForbidden') : t('stepUp.notEnabled')
      }
    }
    throw err
  }
}

/**
 * True when a console endpoint answered 404 without a Claudex reason: the
 * server this console talks to doesn't have that Claudex feature, so the page
 * says so instead of showing a form that can't be saved.
 */
export function isMissingEndpoint(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; reason?: unknown; code?: unknown }
  if (e.status !== 404) return false
  const marker = [e.reason, e.code].find((value) => typeof value === 'string' && value.startsWith('CLAUDEX_'))
  return !marker
}

/** Stable JSON used to tell whether a form differs from what was loaded or saved. */
export function snapshot(value: unknown): string {
  return JSON.stringify(value)
}

/** Parses a whole number from a number input; null when empty or not a whole number. */
export function toInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) ? n : null
}

/** Parses a number from a number input; null when empty or not finite. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** True when `value` is a whole number in [min, max]. */
export function integerInRange(value: unknown, min: number, max: number): boolean {
  const n = toInteger(value)
  return n !== null && n >= min && n <= max
}

/**
 * RFC 3339 (UTC, whole seconds) bound of a local calendar day given as
 * YYYY-MM-DD: 'start' is that day's midnight, 'end' is the next day's
 * midnight, because the report filters treat `to` as exclusive
 * (created_at < to), so a whole day stays in the range up to its last
 * instant. Empty when the value is empty, malformed or not a real date.
 */
export function dayBoundary(day: string, edge: 'start' | 'end'): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (!match) return ''
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  const start = new Date(year, month, date, 0, 0, 0, 0)
  // new Date() rolls 2026-02-30 over into March; refuse days that don't exist.
  const real = start.getFullYear() === year && start.getMonth() === month && start.getDate() === date
  if (Number.isNaN(start.getTime()) || !real) return ''
  const at = edge === 'start' ? start : new Date(year, month, date + 1, 0, 0, 0, 0)
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

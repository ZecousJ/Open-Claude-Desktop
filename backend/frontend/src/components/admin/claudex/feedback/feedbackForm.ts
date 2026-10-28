/**
 * CLAUDEX: form model and checks for the diagnostics and feedback settings
 * (design 2.9, setting claudex_feedback). Both kinds are off by default:
 * nothing is collected until an admin turns one on, and each user must also
 * agree in the Claudex app.
 */

import type { FeedbackSettings } from '@/api/admin/claudex/feedback'
import { integerInRange, toInteger } from '../general/pageSupport'

export const DIAGNOSTICS_RETENTION_MAX = 365
export const FEEDBACK_RETENTION_MAX = 730
export const PER_DAY_MAX = 1000

/** Server defaults (design 2.9), used when a value is missing. */
export const FEEDBACK_DEFAULTS: FeedbackSettings = {
  diagnostics: { enabled: false, retention_days: 30, max_per_user_per_day: 200 },
  feedback: { enabled: false, retention_days: 180, allow_conversation_excerpt: false, max_per_user_per_day: 100 }
}

export interface FeedbackSettingsForm {
  diagnostics: {
    enabled: boolean
    retentionDays: number | string | null
    maxPerUserPerDay: number | string | null
  }
  feedback: {
    enabled: boolean
    retentionDays: number | string | null
    allowConversationExcerpt: boolean
    maxPerUserPerDay: number | string | null
  }
}

export type FeedbackProblem = 'diagnosticsRetention' | 'feedbackRetention' | 'perDay'

export type FeedbackProblems = Record<string, FeedbackProblem>

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function feedbackFormFromSettings(settings: Partial<FeedbackSettings> | null | undefined): FeedbackSettingsForm {
  const d = { ...FEEDBACK_DEFAULTS.diagnostics, ...(settings?.diagnostics ?? {}) }
  const f = { ...FEEDBACK_DEFAULTS.feedback, ...(settings?.feedback ?? {}) }
  return {
    diagnostics: {
      enabled: d.enabled === true,
      retentionDays: numberOr(d.retention_days, FEEDBACK_DEFAULTS.diagnostics.retention_days),
      maxPerUserPerDay: numberOr(d.max_per_user_per_day, FEEDBACK_DEFAULTS.diagnostics.max_per_user_per_day)
    },
    feedback: {
      enabled: f.enabled === true,
      retentionDays: numberOr(f.retention_days, FEEDBACK_DEFAULTS.feedback.retention_days),
      allowConversationExcerpt: f.allow_conversation_excerpt === true,
      maxPerUserPerDay: numberOr(f.max_per_user_per_day, FEEDBACK_DEFAULTS.feedback.max_per_user_per_day)
    }
  }
}

/** The PUT body for a form (call after validateFeedbackForm found no problems). */
export function feedbackSettingsFromForm(form: FeedbackSettingsForm): FeedbackSettings {
  return {
    diagnostics: {
      enabled: form.diagnostics.enabled,
      retention_days: toInteger(form.diagnostics.retentionDays) ?? 0,
      max_per_user_per_day: toInteger(form.diagnostics.maxPerUserPerDay) ?? 0
    },
    feedback: {
      enabled: form.feedback.enabled,
      retention_days: toInteger(form.feedback.retentionDays) ?? 0,
      allow_conversation_excerpt: form.feedback.allowConversationExcerpt,
      max_per_user_per_day: toInteger(form.feedback.maxPerUserPerDay) ?? 0
    }
  }
}

export function validateFeedbackForm(form: FeedbackSettingsForm): FeedbackProblems {
  const problems: FeedbackProblems = {}
  if (!integerInRange(form.diagnostics.retentionDays, 1, DIAGNOSTICS_RETENTION_MAX)) {
    problems['diagnostics.retention_days'] = 'diagnosticsRetention'
  }
  if (!integerInRange(form.diagnostics.maxPerUserPerDay, 1, PER_DAY_MAX)) {
    problems['diagnostics.max_per_user_per_day'] = 'perDay'
  }
  if (!integerInRange(form.feedback.retentionDays, 1, FEEDBACK_RETENTION_MAX)) {
    problems['feedback.retention_days'] = 'feedbackRetention'
  }
  if (!integerInRange(form.feedback.maxPerUserPerDay, 1, PER_DAY_MAX)) {
    problems['feedback.max_per_user_per_day'] = 'perDay'
  }
  return problems
}

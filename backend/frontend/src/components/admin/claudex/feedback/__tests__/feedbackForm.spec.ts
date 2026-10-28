// CLAUDEX: tests for the diagnostics and feedback settings form (K4).
import { describe, expect, it } from 'vitest'

import { FEEDBACK_DEFAULTS, feedbackFormFromSettings, feedbackSettingsFromForm, validateFeedbackForm } from '../feedbackForm'

describe('feedback settings form', () => {
  it('starts with both kinds off, like the server default', () => {
    expect(FEEDBACK_DEFAULTS.diagnostics.enabled).toBe(false)
    expect(FEEDBACK_DEFAULTS.feedback.enabled).toBe(false)
    expect(FEEDBACK_DEFAULTS.feedback.allow_conversation_excerpt).toBe(false)
    const form = feedbackFormFromSettings(null)
    expect(feedbackSettingsFromForm(form)).toEqual(FEEDBACK_DEFAULTS)
    expect(validateFeedbackForm(form)).toEqual({})
  })

  it('round-trips a stored setting', () => {
    const stored = {
      diagnostics: { enabled: true, retention_days: 7, max_per_user_per_day: 50 },
      feedback: { enabled: true, retention_days: 730, allow_conversation_excerpt: true, max_per_user_per_day: 1000 }
    }
    expect(feedbackSettingsFromForm(feedbackFormFromSettings(stored))).toEqual(stored)
  })

  it('treats anything but an explicit true as off', () => {
    const form = feedbackFormFromSettings({
      diagnostics: { enabled: 'yes' as never, retention_days: 30, max_per_user_per_day: 200 },
      feedback: { enabled: 1 as never, retention_days: 180, allow_conversation_excerpt: 'true' as never, max_per_user_per_day: 100 }
    })
    expect(form.diagnostics.enabled).toBe(false)
    expect(form.feedback.enabled).toBe(false)
    expect(form.feedback.allowConversationExcerpt).toBe(false)
  })

  it('checks the ranges the server checks', () => {
    const form = feedbackFormFromSettings(null)
    form.diagnostics.retentionDays = 366
    form.diagnostics.maxPerUserPerDay = 0
    form.feedback.retentionDays = 731
    form.feedback.maxPerUserPerDay = 1001
    expect(validateFeedbackForm(form)).toEqual({
      'diagnostics.retention_days': 'diagnosticsRetention',
      'diagnostics.max_per_user_per_day': 'perDay',
      'feedback.retention_days': 'feedbackRetention',
      'feedback.max_per_user_per_day': 'perDay'
    })

    form.diagnostics.retentionDays = 365
    form.diagnostics.maxPerUserPerDay = 1
    form.feedback.retentionDays = 1.5
    form.feedback.maxPerUserPerDay = ''
    expect(validateFeedbackForm(form)).toEqual({
      'feedback.retention_days': 'feedbackRetention',
      'feedback.max_per_user_per_day': 'perDay'
    })
  })
})

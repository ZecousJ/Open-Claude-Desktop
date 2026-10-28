// CLAUDEX W-ADMIN1: the Web app page's form rules follow the server's checks.
import { describe, expect, it } from 'vitest'
import {
  accessFromSettings,
  accessProblems,
  accessUpdateFromForm,
  cleanRunnerName,
  limitsFromSettings,
  limitsProblems,
  limitsUpdateFromForm,
  runnerNameProblem,
  validateEmail,
  validateUserId
} from '../webForm'

const settings = {
  enabled: true,
  mode: 'allowlist' as const,
  allowlist_user_ids: [3, 1],
  allowlist_emails: ['a@b.co'],
  max_web_sessions_per_user: 10,
  revision: 2
}

describe('access form', () => {
  it('maps enabled and mode to one of off, allowlist and everyone, and back', () => {
    expect(accessFromSettings(null).access).toBe('off')
    expect(accessFromSettings({ ...settings, enabled: false, mode: 'everyone' }).access).toBe('off')
    expect(accessFromSettings(settings).access).toBe('allowlist')
    expect(accessFromSettings({ ...settings, mode: 'everyone' }).access).toBe('everyone')

    const form = accessFromSettings(settings)
    expect(accessUpdateFromForm(form, 2)).toEqual({
      enabled: true,
      mode: 'allowlist',
      allowlist_user_ids: [3, 1],
      allowlist_emails: ['a@b.co'],
      max_web_sessions_per_user: 10,
      revision: 2
    })
    expect(accessUpdateFromForm({ ...form, access: 'off' }, 2)).toMatchObject({ enabled: false, mode: 'allowlist' })
    expect(accessUpdateFromForm({ ...form, access: 'everyone' }, 2)).toMatchObject({ enabled: true, mode: 'everyone' })
  })

  it('lowercases emails and drops values that are not user ids', () => {
    const form = { ...accessFromSettings(settings), emails: [' Ann@Example.com '], userIds: ['12', 'x', '-1', '0'] }
    expect(accessUpdateFromForm(form, 1)).toMatchObject({ allowlist_emails: ['ann@example.com'], allowlist_user_ids: [12] })
  })

  it('checks the sessions per user and the list sizes', () => {
    const form = accessFromSettings(settings)
    expect(accessProblems(form)).toEqual({})
    for (const bad of [0, 51, 1.5, '', null]) {
      expect(accessProblems({ ...form, maxSessionsPerUser: bad })).toHaveProperty('maxSessionsPerUser')
    }
    expect(accessProblems({ ...form, emails: Array(1001).fill('a@b.co') })).toHaveProperty('emails')
  })

  it('validates emails and user ids', () => {
    expect(validateEmail('a@b.co')).toBeNull()
    for (const bad of ['a', '@b.co', 'a@', 'a b@c.co']) expect(validateEmail(bad)).not.toBeNull()
    expect(validateUserId('42')).toBeNull()
    for (const bad of ['0', '-1', '1.5', 'x', '']) expect(validateUserId(bad)).not.toBeNull()
  })
})

describe('limits form', () => {
  const usage = {
    max_concurrent_sessions_per_user: 1,
    max_concurrent_sessions: 2,
    max_session_minutes: 30,
    runner_minute_price_usd: 0.5,
    revision: 4
  }

  it('round-trips the setting', () => {
    expect(limitsUpdateFromForm(limitsFromSettings(usage), 4)).toEqual(usage)
  })

  it('applies the server ranges', () => {
    const form = limitsFromSettings(usage)
    expect(limitsProblems(form)).toEqual({})
    expect(limitsProblems({ ...form, maxConcurrentPerUser: 21, maxConcurrent: 100 })).toHaveProperty('maxConcurrentPerUser')
    expect(limitsProblems({ ...form, maxConcurrent: 501 })).toHaveProperty('maxConcurrent')
    expect(limitsProblems({ ...form, maxConcurrentPerUser: 3, maxConcurrent: 2 }).maxConcurrentPerUser).toBe('perUserOverTotal')
    expect(limitsProblems({ ...form, maxSessionMinutes: 1441 })).toHaveProperty('maxSessionMinutes')
    expect(limitsProblems({ ...form, maxSessionMinutes: 0 })).toHaveProperty('maxSessionMinutes')
    expect(limitsProblems({ ...form, minutePriceUsd: 100.01 })).toHaveProperty('minutePriceUsd')
    expect(limitsProblems({ ...form, minutePriceUsd: -1 })).toHaveProperty('minutePriceUsd')
    expect(limitsProblems({ ...form, minutePriceUsd: '' })).toHaveProperty('minutePriceUsd')
  })
})

describe('runner name', () => {
  it('trims and drops control characters like the server', () => {
    expect(cleanRunnerName('  lab\u0001 ')).toBe('lab')
    expect(runnerNameProblem('   ')).not.toBeNull()
    expect(runnerNameProblem('lab')).toBeNull()
    expect(runnerNameProblem('x'.repeat(100))).toBeNull()
    expect(runnerNameProblem('x'.repeat(101))).not.toBeNull()
  })
})

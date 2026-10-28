// CLAUDEX K3: provisioning form logic of the devices page.
import { describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { DEFAULT_PROVISIONING, type ProvisioningSettings } from '@/api/admin/claudex/devices'
import {
  formToSettings,
  grantsAtSignup,
  normalizeProvisioning,
  provisioningChanges,
  settingsToForm,
  validMaxDevices,
  validateProvisioning,
  type ProvisioningForm
} from '../provisioning'

function lookup(messages: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
}

function defaults(): ProvisioningSettings {
  return normalizeProvisioning(null)
}

function formWith(overrides: Partial<ProvisioningForm> = {}): ProvisioningForm {
  return { ...settingsToForm(defaults()), ...overrides }
}

describe('normalizeProvisioning', () => {
  it('fills the designed defaults (5 devices, sign-up grant off, user API keys off)', () => {
    expect(defaults()).toEqual({
      enabled: true,
      strategy: 'subscription_then_default',
      default_group_id: null,
      allowed_group_ids: [],
      on_signup: { grant_default_group: false },
      key_defaults: { quota_usd: 0, expires_in_days: null, rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0 },
      max_devices_per_user: 5,
      user_api_keys_enabled: false
    })
    expect(defaults()).toEqual({ ...DEFAULT_PROVISIONING })
  })

  it('has no setting that keeps device keys on for revoke-all', () => {
    expect(Object.keys(defaults())).not.toContain('revoke_devices_on_revoke_all')
  })

  it('keeps fields it does not know and sends them back unchanged', () => {
    const loaded = normalizeProvisioning({
      ...DEFAULT_PROVISIONING,
      future_flag: 'x',
      key_defaults: { ...DEFAULT_PROVISIONING.key_defaults, extra: 1 }
    } as never)
    const saved = formToSettings(formWith({ maxDevicesPerUser: 8 }), loaded) as unknown as Record<string, unknown>
    expect(saved.future_flag).toBe('x')
    expect((saved.key_defaults as Record<string, unknown>).extra).toBe(1)
    expect(saved.max_devices_per_user).toBe(8)
  })

  it('ignores values of the wrong type', () => {
    const settings = normalizeProvisioning({
      enabled: 'yes',
      strategy: 'random',
      default_group_id: '3',
      allowed_group_ids: [1, '2', 3],
      max_devices_per_user: Number.NaN
    } as never)
    expect(settings.enabled).toBe(true)
    expect(settings.strategy).toBe('subscription_then_default')
    expect(settings.default_group_id).toBeNull()
    expect(settings.allowed_group_ids).toEqual([1, 3])
    expect(settings.max_devices_per_user).toBe(5)
  })
})

describe('validateProvisioning', () => {
  it('accepts the defaults', () => {
    expect(validateProvisioning(formWith())).toEqual({})
  })

  it.each([
    [1, true],
    [50, true],
    ['8', true],
    [0, false],
    [51, false],
    [2.5, false],
    ['', false],
    [null, false]
  ])('max devices %j valid=%s', (value, ok) => {
    expect(validMaxDevices(value as never)).toBe(ok)
    expect(!validateProvisioning(formWith({ maxDevicesPerUser: value as never })).maxDevicesPerUser).toBe(ok)
  })

  it('needs a default group for the fixed strategy and for the sign-up grant', () => {
    expect(validateProvisioning(formWith({ strategy: 'fixed' })).defaultGroup).toBe(
      'admin.claudexDevices.validation.defaultGroupFixed'
    )
    expect(validateProvisioning(formWith({ strategy: 'fixed', defaultGroupId: 3 }))).toEqual({})
    expect(validateProvisioning(formWith({ grantDefaultGroup: true })).grantDefaultGroup).toBe(
      'admin.claudexDevices.validation.defaultGroupSignup'
    )
  })

  it('needs the default group to be one of the allowed groups when any are chosen (B4 not_in_allowed_groups)', () => {
    expect(validateProvisioning(formWith({ defaultGroupId: 3, allowedGroupIds: [4, 5] })).defaultGroup).toBe(
      'admin.claudexDevices.validation.defaultGroupNotAllowed'
    )
    expect(validateProvisioning(formWith({ defaultGroupId: 3, allowedGroupIds: [3, 4] }))).toEqual({})
    // No allowed groups = every group, so any default group is fine.
    expect(validateProvisioning(formWith({ defaultGroupId: 3, allowedGroupIds: [] }))).toEqual({})
    expect(validateProvisioning(formWith({ defaultGroupId: null, allowedGroupIds: [4] }))).toEqual({})
  })

  it('checks key defaults', () => {
    const errors = validateProvisioning(
      formWith({ quotaUsd: -1, rateLimit5h: 'abc', rateLimit1d: Number.POSITIVE_INFINITY, rateLimit7d: '', expiresInDays: 0 })
    )
    expect(errors).toEqual({
      quotaUsd: 'admin.claudexDevices.validation.usd',
      rateLimit5h: 'admin.claudexDevices.validation.usd',
      rateLimit1d: 'admin.claudexDevices.validation.usd',
      expiresInDays: 'admin.claudexDevices.validation.expiresInDays'
    })
    expect(validateProvisioning(formWith({ expiresInDays: 3650 }))).toEqual({})
    expect(validateProvisioning(formWith({ expiresInDays: 3651 })).expiresInDays).toBeTruthy()
    expect(validateProvisioning(formWith({ expiresInDays: 1.5 })).expiresInDays).toBeTruthy()
  })
})

describe('formToSettings', () => {
  it('turns empty amounts into 0 and an empty expiry into never', () => {
    const settings = formToSettings(
      formWith({ quotaUsd: '', rateLimit5h: '2.5', rateLimit1d: '', rateLimit7d: 10, expiresInDays: '' }),
      defaults()
    )
    expect(settings.key_defaults).toEqual({
      quota_usd: 0,
      expires_in_days: null,
      rate_limit_5h: 2.5,
      rate_limit_1d: 0,
      rate_limit_7d: 10
    })
  })

  it('writes every edited field', () => {
    const settings = formToSettings(
      formWith({
        enabled: false,
        strategy: 'fixed',
        defaultGroupId: 3,
        allowedGroupIds: [3, 4],
        grantDefaultGroup: true,
        expiresInDays: '30',
        maxDevicesPerUser: '8',
        userApiKeysEnabled: true
      }),
      defaults()
    )
    expect(settings).toMatchObject({
      enabled: false,
      strategy: 'fixed',
      default_group_id: 3,
      allowed_group_ids: [3, 4],
      on_signup: { grant_default_group: true },
      key_defaults: { expires_in_days: 30 },
      max_devices_per_user: 8,
      user_api_keys_enabled: true
    })
  })
})

describe('provisioningChanges', () => {
  it('lists what differs', () => {
    const before = defaults()
    expect(provisioningChanges(before, before)).toEqual([])
    const after = formToSettings(
      formWith({ allowedGroupIds: [2], grantDefaultGroup: true, defaultGroupId: 2, rateLimit7d: 5, userApiKeysEnabled: true }),
      before
    )
    expect(provisioningChanges(before, after)).toEqual([
      'defaultGroup',
      'allowedGroups',
      'grantDefaultGroup',
      'keyDefaults',
      'userApiKeys'
    ])
    const reordered = { ...before, allowed_group_ids: [2, 1] }
    expect(provisioningChanges({ ...before, allowed_group_ids: [1, 2] }, reordered)).toEqual([])
  })
})

describe('grantsAtSignup', () => {
  it('only an exclusive standard group is granted at sign-up', () => {
    expect(grantsAtSignup({ id: 1, name: 'a', is_exclusive: true, subscription_type: 'standard' })).toBe(true)
    expect(grantsAtSignup({ id: 1, name: 'a', is_exclusive: false, subscription_type: 'standard' })).toBe(false)
    expect(grantsAtSignup({ id: 1, name: 'a', is_exclusive: true, subscription_type: 'subscription' })).toBe(false)
    expect(grantsAtSignup(undefined)).toBe(false)
  })
})

describe('message keys used by the provisioning form', () => {
  it('exist in English and Chinese', () => {
    const keys = [
      'strategy',
      'defaultGroupFixed',
      'defaultGroupSignup',
      'defaultGroupNotAllowed',
      'usd',
      'expiresInDays',
      'maxDevices'
    ].map((k) => `admin.claudexDevices.validation.${k}`)
    keys.push(
      ...['darwin', 'win32', 'linux'].map((p) => `admin.claudexDevices.platforms.${p}`),
      ...['active', 'inactive', 'disabled', 'expired', 'quota_exhausted', 'deleted'].map((s) => `admin.claudexDevices.keyStatus.${s}`),
      ...['user', 'admin', 'revoke_all', 'unknown'].map((r) => `admin.claudexDevices.revokedReason.${r}`)
    )
    for (const key of keys) {
      expect(typeof lookup(en, key), `en ${key}`).toBe('string')
      expect(typeof lookup(zh, key), `zh ${key}`).toBe('string')
    }
  })

  it('states the revoke-all rule as a fixed note in both languages', () => {
    expect(lookup(en, 'admin.claudexDevices.provisioning.revokeAllNote')).toBe(
      'Signing out of all devices always turns off that user’s Claudex device keys. Keys the user created themselves are not affected.'
    )
    expect(lookup(zh, 'admin.claudexDevices.provisioning.revokeAllNote')).toBeTruthy()
    expect(lookup(en, 'admin.claudexDevices.provisioning.grantWarning')).toBe('Anyone who can register gets this group.')
  })
})

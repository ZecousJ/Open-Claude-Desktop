/**
 * CLAUDEX: form logic of the provisioning card on /admin/claudex/devices and
 * of the per-user device limit. The server (B4) validates again and is
 * authoritative; these checks mirror design 2.5.
 */

import {
  DEFAULT_PROVISIONING,
  type ProvisioningSettings,
  type ProvisioningStrategy
} from '@/api/admin/claudex/devices'

export const MAX_DEVICES_MIN = 1
export const MAX_DEVICES_MAX = 50
export const EXPIRES_DAYS_MIN = 1
export const EXPIRES_DAYS_MAX = 3650
/** Upper bound for USD amounts in the form (the server only needs >= 0 and finite). */
export const USD_MAX = 1_000_000_000

export type NumberInput = number | string | null

export interface ProvisioningForm {
  enabled: boolean
  strategy: ProvisioningStrategy
  defaultGroupId: number | null
  allowedGroupIds: number[]
  grantDefaultGroup: boolean
  quotaUsd: NumberInput
  expiresInDays: NumberInput
  rateLimit5h: NumberInput
  rateLimit1d: NumberInput
  rateLimit7d: NumberInput
  maxDevicesPerUser: NumberInput
  userApiKeysEnabled: boolean
}

export type ProvisioningField =
  | 'strategy'
  | 'defaultGroup'
  | 'grantDefaultGroup'
  | 'quotaUsd'
  | 'expiresInDays'
  | 'rateLimit5h'
  | 'rateLimit1d'
  | 'rateLimit7d'
  | 'maxDevicesPerUser'

export type ProvisioningErrors = Partial<Record<ProvisioningField, string>>

/** A group as far as these checks need it. */
export interface GroupLike {
  id: number
  name: string
  is_exclusive?: boolean
  subscription_type?: string
  status?: string
}

function finiteOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Fills whatever the server left out with the built-in defaults, keeping any
 * fields this console does not know (they are sent back unchanged on save).
 */
export function normalizeProvisioning(raw: Partial<ProvisioningSettings> | null | undefined): ProvisioningSettings {
  const src = (raw ?? {}) as Partial<ProvisioningSettings>
  const keyDefaults: Partial<ProvisioningSettings['key_defaults']> = src.key_defaults ?? {}
  const base = DEFAULT_PROVISIONING
  return {
    ...src,
    enabled: typeof src.enabled === 'boolean' ? src.enabled : base.enabled,
    strategy: src.strategy === 'fixed' || src.strategy === 'subscription_then_default' ? src.strategy : base.strategy,
    default_group_id: typeof src.default_group_id === 'number' ? src.default_group_id : null,
    allowed_group_ids: Array.isArray(src.allowed_group_ids)
      ? src.allowed_group_ids.filter((id): id is number => typeof id === 'number')
      : [],
    on_signup: {
      ...(src.on_signup ?? {}),
      grant_default_group: src.on_signup?.grant_default_group === true
    },
    key_defaults: {
      ...keyDefaults,
      quota_usd: finiteOr(keyDefaults.quota_usd, base.key_defaults.quota_usd),
      expires_in_days: finiteOr(keyDefaults.expires_in_days, null),
      rate_limit_5h: finiteOr(keyDefaults.rate_limit_5h, base.key_defaults.rate_limit_5h),
      rate_limit_1d: finiteOr(keyDefaults.rate_limit_1d, base.key_defaults.rate_limit_1d),
      rate_limit_7d: finiteOr(keyDefaults.rate_limit_7d, base.key_defaults.rate_limit_7d)
    },
    max_devices_per_user: finiteOr(src.max_devices_per_user, base.max_devices_per_user),
    user_api_keys_enabled: src.user_api_keys_enabled === true
  }
}

export function settingsToForm(settings: ProvisioningSettings): ProvisioningForm {
  return {
    enabled: settings.enabled,
    strategy: settings.strategy,
    defaultGroupId: settings.default_group_id,
    allowedGroupIds: [...settings.allowed_group_ids],
    grantDefaultGroup: settings.on_signup.grant_default_group,
    quotaUsd: settings.key_defaults.quota_usd,
    expiresInDays: settings.key_defaults.expires_in_days,
    rateLimit5h: settings.key_defaults.rate_limit_5h,
    rateLimit1d: settings.key_defaults.rate_limit_1d,
    rateLimit7d: settings.key_defaults.rate_limit_7d,
    maxDevicesPerUser: settings.max_devices_per_user,
    userApiKeysEnabled: settings.user_api_keys_enabled
  }
}

/** '' and null are "empty"; anything else becomes a number (NaN when not one). */
export function parseNumber(value: NumberInput | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '' ? null : Number(text)
  }
  return value
}

function usdProblem(value: NumberInput): boolean {
  const n = parseNumber(value)
  if (n === null) return false // empty = 0 (no limit)
  return !Number.isFinite(n) || n < 0 || n > USD_MAX
}

/** Whether new users can actually get the default group at sign-up (an exclusive standard group). */
export function grantsAtSignup(group: GroupLike | undefined): boolean {
  return !!group && group.is_exclusive === true && (group.subscription_type ?? 'standard') === 'standard'
}

/** Checks one per-user or default device limit (whole number 1-50). */
export function validMaxDevices(value: NumberInput): boolean {
  const n = parseNumber(value)
  return n !== null && Number.isInteger(n) && n >= MAX_DEVICES_MIN && n <= MAX_DEVICES_MAX
}

/** Field problems as i18n keys (empty object = valid). */
export function validateProvisioning(form: ProvisioningForm): ProvisioningErrors {
  const errors: ProvisioningErrors = {}
  if (form.strategy !== 'subscription_then_default' && form.strategy !== 'fixed') {
    errors.strategy = 'admin.claudexDevices.validation.strategy'
  }
  if (form.strategy === 'fixed' && form.defaultGroupId === null) {
    errors.defaultGroup = 'admin.claudexDevices.validation.defaultGroupFixed'
  }
  // B4 refuses a default group outside a non-empty allowed list (rule not_in_allowed_groups).
  if (
    form.defaultGroupId !== null &&
    form.allowedGroupIds.length > 0 &&
    !form.allowedGroupIds.includes(form.defaultGroupId)
  ) {
    errors.defaultGroup = 'admin.claudexDevices.validation.defaultGroupNotAllowed'
  }
  if (form.grantDefaultGroup && form.defaultGroupId === null) {
    errors.grantDefaultGroup = 'admin.claudexDevices.validation.defaultGroupSignup'
  }
  if (usdProblem(form.quotaUsd)) errors.quotaUsd = 'admin.claudexDevices.validation.usd'
  if (usdProblem(form.rateLimit5h)) errors.rateLimit5h = 'admin.claudexDevices.validation.usd'
  if (usdProblem(form.rateLimit1d)) errors.rateLimit1d = 'admin.claudexDevices.validation.usd'
  if (usdProblem(form.rateLimit7d)) errors.rateLimit7d = 'admin.claudexDevices.validation.usd'
  const days = parseNumber(form.expiresInDays)
  if (days !== null && (!Number.isInteger(days) || days < EXPIRES_DAYS_MIN || days > EXPIRES_DAYS_MAX)) {
    errors.expiresInDays = 'admin.claudexDevices.validation.expiresInDays'
  }
  if (!validMaxDevices(form.maxDevicesPerUser)) {
    errors.maxDevicesPerUser = 'admin.claudexDevices.validation.maxDevices'
  }
  return errors
}

/**
 * The settings to save for a valid form. `base` is what was loaded; fields
 * this console does not edit are kept as they were.
 */
export function formToSettings(form: ProvisioningForm, base: ProvisioningSettings): ProvisioningSettings {
  return {
    ...base,
    enabled: form.enabled,
    strategy: form.strategy,
    default_group_id: form.defaultGroupId,
    allowed_group_ids: [...form.allowedGroupIds],
    on_signup: { ...base.on_signup, grant_default_group: form.grantDefaultGroup },
    key_defaults: {
      ...base.key_defaults,
      quota_usd: parseNumber(form.quotaUsd) ?? 0,
      expires_in_days: parseNumber(form.expiresInDays),
      rate_limit_5h: parseNumber(form.rateLimit5h) ?? 0,
      rate_limit_1d: parseNumber(form.rateLimit1d) ?? 0,
      rate_limit_7d: parseNumber(form.rateLimit7d) ?? 0
    },
    max_devices_per_user: parseNumber(form.maxDevicesPerUser) ?? DEFAULT_PROVISIONING.max_devices_per_user,
    user_api_keys_enabled: form.userApiKeysEnabled
  }
}

/** Setting names that differ between two saved shapes, for the save confirmation. */
export type ProvisioningChange =
  | 'enabled'
  | 'strategy'
  | 'defaultGroup'
  | 'allowedGroups'
  | 'grantDefaultGroup'
  | 'keyDefaults'
  | 'maxDevicesPerUser'
  | 'userApiKeys'

export function provisioningChanges(before: ProvisioningSettings, after: ProvisioningSettings): ProvisioningChange[] {
  const changes: ProvisioningChange[] = []
  const sorted = (ids: number[]) => [...ids].sort((x, y) => x - y).join(',')
  const sameIds = (a: number[], b: number[]) => sorted(a) === sorted(b)
  if (before.enabled !== after.enabled) changes.push('enabled')
  if (before.strategy !== after.strategy) changes.push('strategy')
  if (before.default_group_id !== after.default_group_id) changes.push('defaultGroup')
  if (!sameIds(before.allowed_group_ids, after.allowed_group_ids)) changes.push('allowedGroups')
  if (before.on_signup.grant_default_group !== after.on_signup.grant_default_group) changes.push('grantDefaultGroup')
  const kd = (s: ProvisioningSettings) =>
    [
      s.key_defaults.quota_usd,
      s.key_defaults.expires_in_days,
      s.key_defaults.rate_limit_5h,
      s.key_defaults.rate_limit_1d,
      s.key_defaults.rate_limit_7d
    ].join('|')
  if (kd(before) !== kd(after)) changes.push('keyDefaults')
  if (before.max_devices_per_user !== after.max_devices_per_user) changes.push('maxDevicesPerUser')
  if (before.user_api_keys_enabled !== after.user_api_keys_enabled) changes.push('userApiKeys')
  return changes
}

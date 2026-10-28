/**
 * CLAUDEX: admin API for Claudex devices and device key provisioning
 * (backend B4, internal/claudex/devices; reached as adminAPI.claudex.devices).
 *
 *   GET/PUT  /admin/claudex/provisioning                      (PUT needs step-up)
 *   GET      /admin/claudex/devices
 *   POST     /admin/claudex/devices/:id/revoke                 (step-up)
 *   POST     /admin/claudex/users/:user_id/devices/revoke-all  (step-up)
 *   GET/PUT/DELETE /admin/claudex/users/:user_id/device-limit  (PUT/DELETE need step-up)
 *   GET/POST /admin/claudex/users/:user_id/api-keys            (POST needs step-up)
 *   DELETE   /admin/claudex/users/:user_id/api-keys/:key_id     (step-up)
 *
 * Signing a user out of all devices always turns off that user's device keys
 * and never touches the API keys the user created (owner decision 13); there
 * is no setting for it. Keys an administrator creates for a user (createUserKey)
 * are user API keys: user_api_keys_enabled does not apply to them and signing
 * out of all devices never touches them.
 */

import { apiClient } from '../../client'
import type { PaginatedResponse } from '@/types'

export type ProvisioningStrategy = 'subscription_then_default' | 'fixed'

export interface ProvisioningKeyDefaults {
  /** USD; 0 = no quota. */
  quota_usd: number
  /** null = the key never expires. */
  expires_in_days: number | null
  /** USD per window; 0 = no limit. */
  rate_limit_5h: number
  rate_limit_1d: number
  rate_limit_7d: number
}

/** The claudex_provisioning setting. */
export interface ProvisioningSettings {
  enabled: boolean
  strategy: ProvisioningStrategy
  default_group_id: number | null
  /** Empty = every group. */
  allowed_group_ids: number[]
  on_signup: { grant_default_group: boolean }
  key_defaults: ProvisioningKeyDefaults
  /** 1-50; a user's own limit (device-limit) overrides it. */
  max_devices_per_user: number
  /** Owner decision 17: regular users may create keys through /api/v1/keys. */
  user_api_keys_enabled: boolean
}

/** The server's built-in defaults (design 2.5 and owner decisions 9 and 17). */
export const DEFAULT_PROVISIONING: Readonly<ProvisioningSettings> = Object.freeze({
  enabled: true,
  strategy: 'subscription_then_default',
  default_group_id: null,
  allowed_group_ids: [],
  on_signup: { grant_default_group: false },
  key_defaults: { quota_usd: 0, expires_in_days: null, rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0 },
  max_devices_per_user: 5,
  user_api_keys_enabled: false
})

export type DeviceRevokedReason = '' | 'user' | 'admin' | 'revoke_all'

export interface AdminDevice {
  id: number
  user_id: number
  user_email: string
  device_name: string
  platform: string
  arch: string
  app_version: string
  group_id: number | null
  group_name: string
  api_key_id: number | null
  /** Prefix and last 4 characters only. */
  api_key_hint: string
  /** active, disabled, expired, quota_exhausted, deleted (soft-deleted key) or '' (no key). */
  api_key_status: string
  api_key_last_used_at: string | null
  last_seen_at: string | null
  last_ip: string
  revoked_at: string | null
  revoked_reason: DeviceRevokedReason
  created_at: string
}

export type DeviceStatusFilter = 'active' | 'revoked' | 'all'

export interface DeviceListQuery {
  user_id?: number | null
  q?: string
  status?: DeviceStatusFilter
  page?: number
  page_size?: number
}

export interface DeviceLimit {
  user_id: number
  max_devices: number
  /** The provisioning default (max_devices_per_user). */
  default: number
  source: 'user' | 'default'
  active_devices: number
}

/** GET /admin/claudex/provisioning */
export async function getProvisioning(): Promise<ProvisioningSettings> {
  const { data } = await apiClient.get<ProvisioningSettings>('/admin/claudex/provisioning')
  return data
}

/** PUT /admin/claudex/provisioning (step-up). */
export async function updateProvisioning(settings: ProvisioningSettings): Promise<ProvisioningSettings> {
  const { data } = await apiClient.put<ProvisioningSettings>('/admin/claudex/provisioning', settings)
  return data
}

/** GET /admin/claudex/devices */
export async function listDevices(query: DeviceListQuery = {}): Promise<PaginatedResponse<AdminDevice>> {
  const params: Record<string, string | number> = {
    status: query.status ?? 'active',
    page: query.page ?? 1,
    page_size: query.page_size ?? 20
  }
  if (query.user_id) params.user_id = query.user_id
  const q = query.q?.trim()
  if (q) params.q = q
  const { data } = await apiClient.get<PaginatedResponse<AdminDevice>>('/admin/claudex/devices', { params })
  return data
}

/** POST /admin/claudex/devices/:id/revoke (step-up). */
export async function revokeDevice(id: number): Promise<{ revoked: boolean }> {
  const { data } = await apiClient.post<{ revoked: boolean }>(`/admin/claudex/devices/${id}/revoke`)
  return data
}

/**
 * POST /admin/claudex/users/:user_id/devices/revoke-all (step-up): signs the
 * user out everywhere and turns off every device key of that user. Returns
 * how many devices were revoked.
 */
export async function revokeAllDevices(userId: number): Promise<{ revoked: number }> {
  const { data } = await apiClient.post<{ revoked: number }>(`/admin/claudex/users/${userId}/devices/revoke-all`)
  return data
}

/** GET /admin/claudex/users/:user_id/device-limit */
export async function getDeviceLimit(userId: number): Promise<DeviceLimit> {
  const { data } = await apiClient.get<DeviceLimit>(`/admin/claudex/users/${userId}/device-limit`)
  return data
}

/** PUT /admin/claudex/users/:user_id/device-limit (step-up). */
export async function setDeviceLimit(userId: number, maxDevices: number): Promise<DeviceLimit> {
  const { data } = await apiClient.put<DeviceLimit>(`/admin/claudex/users/${userId}/device-limit`, {
    max_devices: maxDevices
  })
  return data
}

/** DELETE /admin/claudex/users/:user_id/device-limit (step-up): back to the default. */
export async function resetDeviceLimit(userId: number): Promise<DeviceLimit> {
  const { data } = await apiClient.delete<DeviceLimit>(`/admin/claudex/users/${userId}/device-limit`)
  return data
}

/** One of a user's API keys (device keys are not listed). */
export interface UserApiKey {
  id: number
  name: string
  /** Prefix and last 4 characters only. */
  key_hint: string
  group_id: number | null
  group_name: string
  /** active, inactive, disabled, expired or quota_exhausted. */
  status: string
  /** USD; 0 = no quota. */
  quota: number
  quota_used: number
  expires_at: string | null
  last_used_at: string | null
  created_at: string
}

/** Body of POST /admin/claudex/users/:user_id/api-keys. */
export interface CreateUserKeyInput {
  name: string
  group_id: number | null
  /** USD; 0 = no quota. */
  quota: number
  /** null = never expires. */
  expires_in_days: number | null
  ip_whitelist: string[]
}

/** The created key: `key` is the plaintext, shown only in this answer. */
export interface CreatedUserKey {
  id: number
  name: string
  key: string
  group_id: number | null
  status: string
  quota: number
  expires_at: string | null
  created_at: string
}

/** GET /admin/claudex/users/:user_id/api-keys (newest first, at most 200). */
export async function listUserKeys(userId: number): Promise<UserApiKey[]> {
  const { data } = await apiClient.get<{ items: UserApiKey[] }>(`/admin/claudex/users/${userId}/api-keys`)
  return data?.items ?? []
}

/** POST /admin/claudex/users/:user_id/api-keys (step-up). */
export async function createUserKey(userId: number, input: CreateUserKeyInput): Promise<CreatedUserKey> {
  const { data } = await apiClient.post<CreatedUserKey>(`/admin/claudex/users/${userId}/api-keys`, input)
  return data
}

/** DELETE /admin/claudex/users/:user_id/api-keys/:key_id (step-up). Device keys are refused. */
export async function deleteUserKey(userId: number, keyId: number): Promise<{ deleted: boolean }> {
  const { data } = await apiClient.delete<{ deleted: boolean }>(`/admin/claudex/users/${userId}/api-keys/${keyId}`)
  return data
}

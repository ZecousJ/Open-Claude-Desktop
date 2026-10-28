// CLAUDEX K3: the devices and usage rules admin API calls (paths, methods, bodies).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, put, post, del } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  del: vi.fn()
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, put, post, delete: del }
}))

import * as devices from '@/api/admin/claudex/devices'
import * as usageRules from '@/api/admin/claudex/usageRules'
import * as claudex from '@/api/admin/claudex'

beforeEach(() => {
  for (const fn of [get, put, post, del]) {
    fn.mockReset()
    fn.mockResolvedValue({ data: { ok: true } })
  }
})

describe('devices API', () => {
  it('is reachable as adminAPI.claudex.devices and .usageRules', () => {
    expect(claudex.devices.listDevices).toBe(devices.listDevices)
    expect(claudex.usageRules.listRules).toBe(usageRules.listRules)
  })

  it('reads and writes the provisioning setting', async () => {
    await devices.getProvisioning()
    expect(get).toHaveBeenCalledWith('/admin/claudex/provisioning')
    const body = { ...devices.DEFAULT_PROVISIONING, max_devices_per_user: 8 }
    await devices.updateProvisioning(body)
    expect(put).toHaveBeenCalledWith('/admin/claudex/provisioning', body)
  })

  it('lists devices with only the filters that are set', async () => {
    get.mockResolvedValue({ data: { items: [], total: 0, page: 1, page_size: 20, pages: 0 } })
    await devices.listDevices()
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/devices', {
      params: { status: 'active', page: 1, page_size: 20 }
    })
    await devices.listDevices({ user_id: 123, q: '  mac ', status: 'all', page: 2, page_size: 50 })
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/devices', {
      params: { status: 'all', page: 2, page_size: 50, user_id: 123, q: 'mac' }
    })
  })

  it('revokes one device and all devices of a user', async () => {
    await devices.revokeDevice(51)
    expect(post).toHaveBeenLastCalledWith('/admin/claudex/devices/51/revoke')
    await devices.revokeAllDevices(123)
    expect(post).toHaveBeenLastCalledWith('/admin/claudex/users/123/devices/revoke-all')
  })

  it('reads, sets and resets a user device limit', async () => {
    await devices.getDeviceLimit(123)
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/users/123/device-limit')
    await devices.setDeviceLimit(123, 8)
    expect(put).toHaveBeenLastCalledWith('/admin/claudex/users/123/device-limit', { max_devices: 8 })
    await devices.resetDeviceLimit(123)
    expect(del).toHaveBeenLastCalledWith('/admin/claudex/users/123/device-limit')
  })
})

describe('usage rules API', () => {
  const input: usageRules.UsageRuleInput = {
    group_id: 4,
    kind: 'models',
    label: 'Opus',
    model_patterns: ['claude-opus-*'],
    window_seconds: 604800,
    limit_usd: 20,
    enabled: true,
    show_in_client: true,
    sort_order: 10
  }

  it('lists rules (all, or one group)', async () => {
    get.mockResolvedValue({ data: { items: [{ id: 1 }] } })
    expect(await usageRules.listRules()).toEqual([{ id: 1 }])
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/usage-rules', { params: undefined })
    await usageRules.listRules(4)
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/usage-rules', { params: { group_id: 4 } })
    get.mockResolvedValue({ data: {} })
    expect(await usageRules.listRules()).toEqual([])
  })

  it('creates, updates and deletes rules', async () => {
    await usageRules.createRule(input)
    expect(post).toHaveBeenLastCalledWith('/admin/claudex/usage-rules', input)
    await usageRules.updateRule(5, input)
    expect(put).toHaveBeenLastCalledWith('/admin/claudex/usage-rules/5', input)
    await usageRules.deleteRule(5)
    expect(del).toHaveBeenLastCalledWith('/admin/claudex/usage-rules/5')
  })

  it('lists and resets counters', async () => {
    await usageRules.listCounters(5)
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/usage-rules/5/counters', {
      params: { page: 1, page_size: 20 }
    })
    await usageRules.listCounters(5, { user_id: 123, page: 3 })
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/usage-rules/5/counters', {
      params: { page: 3, page_size: 20, user_id: 123 }
    })
    await usageRules.resetCounter(5, 123)
    expect(post).toHaveBeenLastCalledWith('/admin/claudex/usage-rules/5/reset', { user_id: 123 })
  })

  it('reads a user usage status', async () => {
    await usageRules.getUserUsageStatus(123)
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/users/123/usage-status', { params: undefined })
    await usageRules.getUserUsageStatus(123, 4)
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/users/123/usage-status', { params: { group_id: 4 } })
  })
})

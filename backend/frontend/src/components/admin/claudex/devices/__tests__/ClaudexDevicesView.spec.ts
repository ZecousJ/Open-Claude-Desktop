// CLAUDEX K3: /admin/claudex/devices: provisioning save, revoke, revoke-all and
// per-user device limits, each confirmed first and sent through step-up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils'

import en from '@/i18n/locales/en'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import ClaudexDevicesView from '@/views/admin/claudex/ClaudexDevicesView.vue'
import UserSearchSelect from '../UserSearchSelect.vue'
import DeviceLimitDialog from '../DeviceLimitDialog.vue'

const api = vi.hoisted(() => ({
  getProvisioning: vi.fn(),
  updateProvisioning: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  revokeAllDevices: vi.fn(),
  getDeviceLimit: vi.fn(),
  setDeviceLimit: vi.fn(),
  resetDeviceLimit: vi.fn(),
  listUserKeys: vi.fn(),
  createUserKey: vi.fn(),
  deleteUserKey: vi.fn()
}))
const getAllGroups = vi.hoisted(() => vi.fn())
const listUsers = vi.hoisted(() => vi.fn())
const stepUpRun = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ showSuccess: vi.fn(), showError: vi.fn() }))

vi.mock('@/api/admin/claudex/devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin/claudex/devices')>()),
  ...api
}))
vi.mock('@/api/admin/groups', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/admin/groups')>()
  return { ...actual, getAll: getAllGroups, default: { ...actual.default, getAll: getAllGroups } }
})
vi.mock('@/api/admin/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/admin/users')>()
  return { ...actual, list: listUsers, default: { ...actual.default, list: listUsers } }
})
vi.mock('@/stores', () => ({ useAppStore: () => toast }))
vi.mock('@/composables/useClipboard', async () => {
  const vue = await import('vue')
  return { useClipboard: () => ({ copied: vue.ref(false), copyToClipboard: vi.fn() }) }
})
vi.mock('@/utils/format', () => ({
  formatDateTime: (value: unknown) => (value ? `date:${String(value)}` : ''),
  formatRelativeTime: (value: unknown) => `ago:${String(value)}`
}))
vi.mock('@/composables/useStepUp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useStepUp')>()
  return {
    ...actual,
    useStepUp: () => ({ visible: { value: false }, blockedReason: { value: '' }, run: stepUpRun })
  }
})

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en)
}

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: (key: string) => typeof lookup(key) === 'string'
  })
}))

vi.mock('@/components/layout/AppLayout.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'AppLayout',
      setup(_, { slots }) {
        return () => vue.h('div', { 'data-testid': 'app-layout' }, slots.default?.())
      }
    })
  }
})

const defaults = {
  enabled: true,
  strategy: 'subscription_then_default',
  default_group_id: null,
  allowed_group_ids: [],
  on_signup: { grant_default_group: false },
  key_defaults: { quota_usd: 0, expires_in_days: null, rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0 },
  max_devices_per_user: 5,
  user_api_keys_enabled: false
}

const device = {
  id: 51,
  user_id: 123,
  user_email: 'a@example.com',
  device_name: 'Ada’s MacBook Pro',
  platform: 'darwin',
  arch: 'arm64',
  app_version: '1.3.2',
  group_id: 4,
  group_name: 'claudex-pro',
  api_key_id: 812,
  api_key_hint: 'sk-…a1b2',
  api_key_status: 'active',
  api_key_last_used_at: null,
  last_seen_at: '2026-01-05T02:10:00Z',
  last_ip: '203.0.113.9',
  revoked_at: null,
  revoked_reason: '',
  created_at: '2026-01-05T02:10:00Z'
}

const userKey = {
  id: 9,
  name: 'CI deploy',
  key_hint: 'sk-…c4a1',
  group_id: 4,
  group_name: 'claudex-pro',
  status: 'active',
  quota: 25,
  quota_used: 1.5,
  expires_at: null,
  last_used_at: null,
  created_at: '2026-09-26T04:00:00Z'
}

const wrappers: VueWrapper[] = []

async function mountView() {
  const wrapper = mount(ClaudexDevicesView, {
    attachTo: document.body,
    global: {
      stubs: {
        teleport: true,
        Icon: true,
        GroupBadge: { props: ['name'], template: '<span>{{ name }}</span>' },
        TotpStepUpDialog: true,
        RouterLink: RouterLinkStub
      }
    }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function confirmDialog(wrapper: VueWrapper) {
  return wrapper.findComponent(ConfirmDialog)
}

async function accept(wrapper: VueWrapper) {
  expect(confirmDialog(wrapper).props('show')).toBe(true)
  confirmDialog(wrapper).vm.$emit('confirm')
  await flushPromises()
}

async function decline(wrapper: VueWrapper) {
  expect(confirmDialog(wrapper).props('show')).toBe(true)
  confirmDialog(wrapper).vm.$emit('cancel')
  await flushPromises()
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  getAllGroups.mockReset()
  listUsers.mockReset()
  stepUpRun.mockReset()
  toast.showSuccess.mockReset()
  toast.showError.mockReset()
  stepUpRun.mockImplementation((action: () => Promise<unknown>) => action())
  api.getProvisioning.mockResolvedValue(structuredClone(defaults))
  api.updateProvisioning.mockImplementation(async (body: unknown) => body)
  api.listDevices.mockResolvedValue({ items: [device], total: 1, page: 1, page_size: 20, pages: 1 })
  api.revokeDevice.mockResolvedValue({ revoked: true })
  api.revokeAllDevices.mockResolvedValue({ revoked: 3 })
  api.getDeviceLimit.mockResolvedValue({ user_id: 123, max_devices: 5, default: 5, source: 'default', active_devices: 2 })
  api.setDeviceLimit.mockResolvedValue({ user_id: 123, max_devices: 8, default: 5, source: 'user', active_devices: 2 })
  api.resetDeviceLimit.mockResolvedValue({ user_id: 123, max_devices: 5, default: 5, source: 'default', active_devices: 2 })
  api.listUserKeys.mockResolvedValue([userKey])
  api.deleteUserKey.mockResolvedValue({ deleted: true })
  getAllGroups.mockResolvedValue([
    { id: 3, name: 'claudex-basic', platform: 'openai', is_exclusive: true, subscription_type: 'standard', status: 'active' },
    { id: 4, name: 'claudex-pro', platform: 'openai', is_exclusive: false, subscription_type: 'subscription', status: 'active' }
  ])
  listUsers.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 8, pages: 0 })
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

describe('ClaudexDevicesView provisioning', () => {
  it('shows the defaults and the fixed revoke-all note, with no switch for it', async () => {
    const wrapper = await mountView()
    expect(api.getProvisioning).toHaveBeenCalledTimes(1)
    const card = wrapper.find('[data-testid="claudex-provisioning-card"]')
    expect((card.find('[data-testid="claudex-max-devices"]').element as HTMLInputElement).value).toBe('5')
    expect(card.find('[data-testid="claudex-grant-default-group"]').attributes('aria-checked')).toBe('false')
    expect(card.find('[data-testid="claudex-user-api-keys"]').attributes('aria-checked')).toBe('false')
    expect(card.find('[data-testid="claudex-revoke-all-note"]').text()).toContain(
      'admin.claudexDevices.provisioning.revokeAllNote'
    )
    // Only enabled, sign-up grant and user API keys are switches.
    expect(card.findAll('[role="switch"]')).toHaveLength(3)
    expect(card.find('[data-testid="claudex-save-button"]').attributes('disabled')).toBeDefined()
  })

  it('confirms, then saves through step-up with the whole setting', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-max-devices"]').setValue('8')
    await wrapper.find('[data-testid="claudex-user-api-keys"]').trigger('click')
    await wrapper.find('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()

    expect(api.updateProvisioning).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="claudex-confirm-details"]').text()).toContain(
      'admin.claudexDevices.provisioning.changes.maxDevices'
    )
    await accept(wrapper)

    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.updateProvisioning).toHaveBeenCalledWith({
      ...defaults,
      max_devices_per_user: 8,
      user_api_keys_enabled: true
    })
    expect(wrapper.find('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.saved')
  })

  it('does nothing when the confirmation is declined', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-max-devices"]').setValue('8')
    await wrapper.find('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    await decline(wrapper)
    expect(stepUpRun).not.toHaveBeenCalled()
    expect(api.updateProvisioning).not.toHaveBeenCalled()
  })

  it('checks the form before asking', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-max-devices"]').setValue('51')
    await wrapper.find('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    expect(confirmDialog(wrapper).props('show')).toBe(false)
    expect(wrapper.text()).toContain('admin.claudexDevices.validation.maxDevices')
    expect(api.updateProvisioning).not.toHaveBeenCalled()
  })

  it('refuses a default group outside the allowed groups before asking', async () => {
    const wrapper = await mountView()
    const options = wrapper.findAll('[data-testid="claudex-group-option"] input[type="checkbox"]')
    await options[1].setValue(true) // allow only claudex-pro (4)
    await wrapper.find('[data-testid="claudex-default-group"]').setValue('3')
    await wrapper.find('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    expect(confirmDialog(wrapper).props('show')).toBe(false)
    expect(wrapper.text()).toContain('admin.claudexDevices.validation.defaultGroupNotAllowed')
    expect(api.updateProvisioning).not.toHaveBeenCalled()

    await options[0].setValue(true) // also allow claudex-basic (3)
    await wrapper.find('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    await accept(wrapper)
    expect(api.updateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ default_group_id: 3, allowed_group_ids: [4, 3] })
    )
  })

  it('warns when the sign-up grant is on and needs a default group', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-grant-default-group"]').trigger('click')
    const warning = wrapper.find('[data-testid="claudex-grant-warning"]')
    expect(warning.text()).toContain('admin.claudexDevices.provisioning.grantWarning')
    expect(warning.text()).toContain('admin.claudexDevices.validation.defaultGroupSignup')

    await wrapper.find('[data-testid="claudex-default-group"]').setValue('4')
    // claudex-pro is a subscription group: the grant has no effect for it.
    expect(wrapper.find('[data-testid="claudex-grant-no-effect"]').exists()).toBe(true)
    await wrapper.find('[data-testid="claudex-default-group"]').setValue('3')
    expect(wrapper.find('[data-testid="claudex-grant-no-effect"]').exists()).toBe(false)

    await wrapper.find('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    await accept(wrapper)
    expect(api.updateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ default_group_id: 3, on_signup: { grant_default_group: true } })
    )
  })

  it('does not report a cancelled step-up as an error', async () => {
    const { StepUpCancelledError } = await import('@/composables/useStepUp')
    stepUpRun.mockRejectedValueOnce(new StepUpCancelledError())
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-max-devices"]').setValue('8')
    await wrapper.find('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    await accept(wrapper)
    expect(wrapper.find('[data-testid="claudex-save-error"]').exists()).toBe(false)
  })

  it('shows the page text for a CLAUDEX_* error', async () => {
    api.updateProvisioning.mockRejectedValueOnce({ status: 400, reason: 'CLAUDEX_PROVISIONING_INVALID', message: 'bad' })
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-max-devices"]').setValue('8')
    await wrapper.find('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    await accept(wrapper)
    expect(wrapper.find('[data-testid="claudex-save-error"]').text()).toBe(
      'admin.claudexDevices.errors.CLAUDEX_PROVISIONING_INVALID'
    )
  })

  it('shows a load error with retry', async () => {
    api.getProvisioning.mockRejectedValueOnce({ status: 500, message: 'down' })
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="claudex-page-load-error"]').text()).toContain('down')
    await wrapper.find('[data-testid="claudex-page-load-error"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-provisioning-card"]').exists()).toBe(true)
  })
})

describe('ClaudexDevicesView device list', () => {
  it('lists devices with a masked key only', async () => {
    const wrapper = await mountView()
    expect(api.listDevices).toHaveBeenCalledWith({ user_id: null, q: '', status: 'active', page: 1, page_size: 20 })
    const row = wrapper.find('[data-testid="claudex-device-row"]')
    expect(row.text()).toContain('a@example.com')
    expect(row.text()).toContain('sk-…a1b2')
    expect(row.text()).toContain('admin.claudexDevices.platforms.darwin')
    expect(row.findComponent(RouterLinkStub).props('to')).toBe('/admin/users')
  })

  it('filters by status and user', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-device-status"]').setValue('revoked')
    await flushPromises()
    expect(api.listDevices).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'revoked', page: 1 }))
    await wrapper.find('[data-testid="claudex-device-show-user"]').trigger('click')
    await flushPromises()
    expect(api.listDevices).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 123 }))
    expect(wrapper.find('[data-testid="claudex-device-user-bar"]').exists()).toBe(true)
  })

  it('revokes a device after confirmation and step-up', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-device-revoke"]').trigger('click')
    await flushPromises()
    expect(api.revokeDevice).not.toHaveBeenCalled()
    expect(confirmDialog(wrapper).props('danger')).toBe(true)
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.revokeDevice).toHaveBeenCalledWith(51)
    expect(api.listDevices).toHaveBeenCalledTimes(2)
    expect(toast.showSuccess).toHaveBeenCalledWith('admin.claudexDevices.confirm.revoked')
  })

  it('does not revoke when declined', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-device-revoke"]').trigger('click')
    await flushPromises()
    await decline(wrapper)
    expect(stepUpRun).not.toHaveBeenCalled()
    expect(api.revokeDevice).not.toHaveBeenCalled()
  })

  it('signs a user out of all devices after confirmation and step-up', async () => {
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-device-revoke-all"]').trigger('click')
    await flushPromises()
    expect(confirmDialog(wrapper).props('message')).toBe('admin.claudexDevices.confirm.revokeAllMessage')
    // The message the admin confirms says user-created keys keep working.
    expect(String(lookup('admin.claudexDevices.confirm.revokeAllMessage'))).toContain(
      'API keys the user created themselves keep working'
    )
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.revokeAllDevices).toHaveBeenCalledWith(123)
    expect(toast.showSuccess).toHaveBeenCalledWith('admin.claudexDevices.confirm.revokedAll{"count":3}')
  })

  it('reports a failed revoke', async () => {
    api.revokeDevice.mockRejectedValueOnce({ status: 404, reason: 'CLAUDEX_DEVICE_NOT_FOUND', message: 'gone' })
    const wrapper = await mountView()
    await wrapper.find('[data-testid="claudex-device-revoke"]').trigger('click')
    await flushPromises()
    await accept(wrapper)
    expect(toast.showError).toHaveBeenCalledWith('admin.claudexDevices.errors.CLAUDEX_DEVICE_NOT_FOUND')
  })
})

describe('ClaudexDevicesView per-user device limit', () => {
  async function openLimit(wrapper: VueWrapper) {
    await wrapper.find('[data-testid="claudex-device-limit"]').trigger('click')
    await flushPromises()
    expect(api.getDeviceLimit).toHaveBeenCalledWith(123)
    return wrapper.findComponent(DeviceLimitDialog)
  }

  it('shows the current limit and where it comes from', async () => {
    const wrapper = await mountView()
    const dialog = await openLimit(wrapper)
    expect(dialog.find('[data-testid="claudex-device-limit-current"]').text()).toContain('5')
    expect(dialog.find('[data-testid="claudex-device-limit-current"]').text()).toContain(
      'admin.claudexDevices.limit.sourceDefault'
    )
    // Already on the default: nothing to reset.
    expect(dialog.find('[data-testid="claudex-device-limit-reset"]').attributes('disabled')).toBeDefined()
  })

  it('sets a limit after confirmation and step-up', async () => {
    const wrapper = await mountView()
    const dialog = await openLimit(wrapper)
    await dialog.find('[data-testid="claudex-device-limit-input"]').setValue('8')
    await dialog.find('[data-testid="claudex-device-limit-save"]').trigger('click')
    await flushPromises()
    expect(api.setDeviceLimit).not.toHaveBeenCalled()
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.setDeviceLimit).toHaveBeenCalledWith(123, 8)
    expect(toast.showSuccess).toHaveBeenCalledWith('admin.claudexDevices.limit.saved{"count":8}')
  })

  it('refuses values outside 1-50', async () => {
    const wrapper = await mountView()
    const dialog = await openLimit(wrapper)
    for (const bad of ['0', '51', '2.5', '']) {
      await dialog.find('[data-testid="claudex-device-limit-input"]').setValue(bad)
      await dialog.find('[data-testid="claudex-device-limit-save"]').trigger('click')
      await flushPromises()
      expect(confirmDialog(wrapper).props('show')).toBe(false)
    }
    expect(dialog.text()).toContain('admin.claudexDevices.validation.maxDevices')
    expect(api.setDeviceLimit).not.toHaveBeenCalled()
  })

  it('goes back to the default after confirmation and step-up', async () => {
    api.getDeviceLimit.mockResolvedValue({ user_id: 123, max_devices: 8, default: 5, source: 'user', active_devices: 2 })
    const wrapper = await mountView()
    const dialog = await openLimit(wrapper)
    expect(dialog.find('[data-testid="claudex-device-limit-current"]').text()).toContain(
      'admin.claudexDevices.limit.sourceUser'
    )
    await dialog.find('[data-testid="claudex-device-limit-reset"]').trigger('click')
    await flushPromises()
    expect(api.resetDeviceLimit).not.toHaveBeenCalled()
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.resetDeviceLimit).toHaveBeenCalledWith(123)
  })

  it('shows the page text when a user picked by ID does not exist', async () => {
    api.listDevices.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20, pages: 0 })
    api.getDeviceLimit.mockRejectedValueOnce({ status: 400, reason: 'CLAUDEX_USER_NOT_FOUND', message: 'User not found.' })
    const wrapper = await mountView()
    wrapper.findComponent(UserSearchSelect).vm.$emit('update:modelValue', { id: 999999, email: '' })
    await flushPromises()
    await wrapper.find('[data-testid="claudex-device-user-limit"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.findComponent(DeviceLimitDialog)
    expect(dialog.find('[data-testid="claudex-device-limit-load-error"]').text()).toContain(
      'admin.claudexDevices.errors.CLAUDEX_USER_NOT_FOUND'
    )
    expect(dialog.find('[data-testid="claudex-device-limit-save"]').attributes('disabled')).toBeDefined()
  })

  it('is reachable for a user picked in the filter, even without devices', async () => {
    api.listDevices.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20, pages: 0 })
    const wrapper = await mountView()
    wrapper.findComponent(UserSearchSelect).vm.$emit('update:modelValue', { id: 77, email: 'b@example.com' })
    await flushPromises()
    await wrapper.find('[data-testid="claudex-device-user-limit"]').trigger('click')
    await flushPromises()
    expect(api.getDeviceLimit).toHaveBeenCalledWith(77)
  })
})

describe('ClaudexDevicesView user API keys (R13)', () => {
  function keyPicker(wrapper: VueWrapper) {
    const pickers = wrapper.findAllComponents(UserSearchSelect)
    return pickers[pickers.length - 1]
  }

  it('asks for a user first, then lists that user’s keys without device keys', async () => {
    const wrapper = await mountView()
    const card = wrapper.find('[data-testid="claudex-user-keys-card"]')
    expect(card.find('[data-testid="claudex-user-keys-pick"]').exists()).toBe(true)
    expect(card.find('[data-testid="claudex-user-keys-create"]').attributes('disabled')).toBeDefined()
    expect(api.listUserKeys).not.toHaveBeenCalled()

    keyPicker(wrapper).vm.$emit('update:modelValue', { id: 123, email: 'a@example.com' })
    await flushPromises()
    expect(api.listUserKeys).toHaveBeenCalledWith(123)
    const rows = card.findAll('[data-testid="claudex-user-key-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('CI deploy')
    expect(rows[0].text()).toContain('sk-…c4a1')
    expect(rows[0].text()).toContain('claudex-pro')
    expect(card.find('[data-testid="claudex-user-keys-create"]').attributes('disabled')).toBeUndefined()
  })

  it('deletes a key after confirmation, through step-up', async () => {
    const wrapper = await mountView()
    keyPicker(wrapper).vm.$emit('update:modelValue', { id: 123, email: 'a@example.com' })
    await flushPromises()
    await wrapper.find('[data-testid="claudex-user-key-delete"]').trigger('click')
    await flushPromises()
    expect(api.deleteUserKey).not.toHaveBeenCalled()
    await decline(wrapper)
    expect(api.deleteUserKey).not.toHaveBeenCalled()

    await wrapper.find('[data-testid="claudex-user-key-delete"]').trigger('click')
    await flushPromises()
    api.listUserKeys.mockResolvedValueOnce([])
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.deleteUserKey).toHaveBeenCalledWith(123, 9)
    expect(toast.showSuccess).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="claudex-user-keys-empty"]').exists()).toBe(true)
  })

  it('drops the previous user’s keys as soon as another user is picked', async () => {
    const wrapper = await mountView()
    keyPicker(wrapper).vm.$emit('update:modelValue', { id: 123, email: 'a@example.com' })
    await flushPromises()
    expect(wrapper.findAll('[data-testid="claudex-user-key-row"]')).toHaveLength(1)

    let resolveNext: (items: unknown[]) => void = () => {}
    api.listUserKeys.mockReturnValueOnce(new Promise((resolve) => (resolveNext = resolve)))
    keyPicker(wrapper).vm.$emit('update:modelValue', { id: 456, email: 'b@example.com' })
    await flushPromises()
    expect(api.listUserKeys).toHaveBeenLastCalledWith(456)
    expect(wrapper.findAll('[data-testid="claudex-user-key-row"]')).toHaveLength(0)

    resolveNext([])
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-user-keys-empty"]').exists()).toBe(true)
  })

  it('shows a refused delete of a device key', async () => {
    api.deleteUserKey.mockRejectedValueOnce({ status: 403, reason: 'CLAUDEX_DEVICE_KEY_MANAGED', message: 'device key' })
    const wrapper = await mountView()
    keyPicker(wrapper).vm.$emit('update:modelValue', { id: 123, email: 'a@example.com' })
    await flushPromises()
    await wrapper.find('[data-testid="claudex-user-key-delete"]').trigger('click')
    await flushPromises()
    await accept(wrapper)
    expect(toast.showError).toHaveBeenCalledWith('admin.claudexDevices.errors.CLAUDEX_DEVICE_KEY_MANAGED')
  })
})

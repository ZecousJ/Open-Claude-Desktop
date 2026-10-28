// CLAUDEX: tests for the Claudex console General page (K4).
import { defineComponent, h } from 'vue'
import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ClaudexGeneralView from '../ClaudexGeneralView.vue'
import { useWebConsoleStore } from '@/stores/webConsole'
import type { StepUpController } from '@/composables/useStepUp'

const { getWebConsole, updateWebConsole } = vi.hoisted(() => ({ getWebConsole: vi.fn(), updateWebConsole: vi.fn() }))

vi.mock('@/api/admin/claudex/general', () => ({ getWebConsole, updateWebConsole }))
// The Sign-in card has its own spec (SignInSettingsCard.spec.ts); here the
// server has no such endpoint, so the card stays hidden.
vi.mock('@/api/admin/claudex/signIn', () => ({
  getSignIn: vi.fn().mockRejectedValue({ status: 404, message: '404 page not found' }),
  updateSignIn: vi.fn(),
  validPrivacyPolicyURL: () => true
}))
vi.mock('@/api/claudexPublic', () => ({ getWebConsoleSetting: vi.fn(), getClientRelease: vi.fn() }))

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: () => false
  })
}))

vi.mock('@/components/layout/AppLayout.vue', () => ({
  default: defineComponent({
    name: 'AppLayout',
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    }
  })
}))

vi.mock('@/components/auth/TotpStepUpDialog.vue', () => ({
  default: defineComponent({
    name: 'TotpStepUpDialog',
    props: { controller: { type: Object, required: true } },
    setup() {
      return () => h('div', { 'data-testid': 'step-up-dialog' })
    }
  })
}))

function mountView() {
  return mount(ClaudexGeneralView, {
    global: { stubs: { Icon: true, RouterLink: RouterLinkStub } }
  })
}

function stepUpOf(wrapper: ReturnType<typeof mountView>): StepUpController {
  return wrapper.findComponent({ name: 'TotpStepUpDialog' }).props('controller') as StepUpController
}

describe('ClaudexGeneralView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getWebConsole.mockReset()
    updateWebConsole.mockReset()
  })

  it('shows the admin-only switch, Backend mode off and the online update note', async () => {
    getWebConsole.mockResolvedValue({ admin_only: true, backend_mode_enabled: false })
    const wrapper = mountView()
    await flushPromises()

    const toggle = wrapper.get('[data-testid="claudex-general-admin-only"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(wrapper.text()).toContain('admin.claudexGeneral.webConsole.adminOnlyHint')
    expect(wrapper.get('[data-testid="claudex-general-backend-mode-status"]').text()).toBe('admin.claudexGeneral.backendMode.off')
    expect(wrapper.find('[data-testid="claudex-general-backend-mode-warning"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="claudex-general-online-update"]').text()).toContain(
      'admin.claudexGeneral.onlineUpdate.disabled'
    )
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/admin/settings')
    // Nothing changed yet: saving is not offered.
    expect(wrapper.get('[data-testid="claudex-save-button"]').attributes('disabled')).toBeDefined()
  })

  it('warns in red when Backend mode is on and links to the system settings', async () => {
    getWebConsole.mockResolvedValue({ admin_only: true, backend_mode_enabled: true })
    const wrapper = mountView()
    await flushPromises()

    const warning = wrapper.get('[data-testid="claudex-general-backend-mode-warning"]')
    expect(warning.attributes('role')).toBe('alert')
    expect(warning.classes()).toContain('bg-red-50')
    expect(warning.text()).toContain('admin.claudexGeneral.backendMode.warning')
    expect(wrapper.get('[data-testid="claudex-general-backend-mode-status"]').text()).toBe('admin.claudexGeneral.backendMode.on')
    // Backend mode is read-only here: there is no switch for it on this page.
    expect(wrapper.findAll('[role="switch"]')).toHaveLength(1)
  })

  it('treats a missing admin_only as on (fails closed)', async () => {
    getWebConsole.mockResolvedValue({ backend_mode_enabled: false })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-general-admin-only"]').attributes('aria-checked')).toBe('true')
  })

  it('saves through step-up and applies the new value to the route guard at once', async () => {
    getWebConsole.mockResolvedValue({ admin_only: true, backend_mode_enabled: false })
    updateWebConsole
      .mockRejectedValueOnce({ status: 403, code: 'STEP_UP_REQUIRED', message: 'step-up required' })
      .mockResolvedValueOnce({ admin_only: false, backend_mode_enabled: false })
    const wrapper = mountView()
    await flushPromises()
    const store = useWebConsoleStore()
    expect(store.adminOnly).toBe(true)

    await wrapper.get('[data-testid="claudex-general-admin-only"]').trigger('click')
    expect(wrapper.find('[data-testid="claudex-general-open-note"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.unsavedChanges')

    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    const stepUp = stepUpOf(wrapper)
    expect(stepUp.visible.value).toBe(true)
    stepUp.onVerified()
    await flushPromises()

    expect(updateWebConsole).toHaveBeenCalledTimes(2)
    expect(updateWebConsole).toHaveBeenLastCalledWith({ admin_only: false })
    expect(store.adminOnly).toBe(false)
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.saved')
  })

  it('keeps the form when the admin cancels the step-up prompt', async () => {
    getWebConsole.mockResolvedValue({ admin_only: true, backend_mode_enabled: false })
    updateWebConsole.mockRejectedValue({ status: 403, code: 'STEP_UP_REQUIRED' })
    const wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-testid="claudex-general-admin-only"]').trigger('click')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    stepUpOf(wrapper).onCancel()
    await flushPromises()

    expect(updateWebConsole).toHaveBeenCalledTimes(1)
    expect(useWebConsoleStore().adminOnly).toBe(true)
    expect(wrapper.find('[data-testid="claudex-save-error"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.unsavedChanges')
  })

  it('says why saving is impossible when two-factor authentication is not set up', async () => {
    getWebConsole.mockResolvedValue({ admin_only: true, backend_mode_enabled: false })
    updateWebConsole.mockRejectedValue({ status: 403, code: 'STEP_UP_TOTP_NOT_ENABLED', message: 'raw' })
    const wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-testid="claudex-general-admin-only"]').trigger('click')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe('stepUp.notEnabled')
  })

  it('shows the server message for other save errors', async () => {
    getWebConsole.mockResolvedValue({ admin_only: true, backend_mode_enabled: false })
    updateWebConsole.mockRejectedValue({ status: 500, message: 'database is down' })
    const wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-testid="claudex-general-admin-only"]').trigger('click')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe('database is down')
  })

  it('says the page is not in this build when the server has no such endpoint', async () => {
    getWebConsole.mockRejectedValue({ status: 404, message: '404 page not found' })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[role="switch"]').exists()).toBe(false)
  })

  it('offers a retry when loading fails', async () => {
    getWebConsole.mockRejectedValueOnce({ status: 500, message: 'boom' })
    getWebConsole.mockResolvedValueOnce({ admin_only: false, backend_mode_enabled: false })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-page-load-error"]').text()).toContain('boom')
    await wrapper.get('[data-testid="claudex-page-load-error"] button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-general-admin-only"]').attributes('aria-checked')).toBe('false')
  })
})

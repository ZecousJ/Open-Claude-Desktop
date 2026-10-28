// CLAUDEX: tests for the Claudex console diagnostics and feedback page (K4).
import { defineComponent, h } from 'vue'
import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ClaudexFeedbackView from '../ClaudexFeedbackView.vue'
import type { StepUpController } from '@/composables/useStepUp'

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listDiagnostics: vi.fn(),
  getDiagnostic: vi.fn(),
  deleteDiagnostic: vi.fn(),
  listFeedback: vi.fn(),
  getFeedback: vi.fn(),
  deleteFeedback: vi.fn()
}))

vi.mock('@/api/admin/claudex/feedback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin/claudex/feedback')>()),
  ...api
}))

vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }))
vi.mock('@/composables/useClipboard', () => ({ useClipboard: () => ({ copyToClipboard: vi.fn() }) }))

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
      return () => h('div')
    }
  })
}))

const DEFAULTS = {
  diagnostics: { enabled: false, retention_days: 30, max_per_user_per_day: 200 },
  feedback: { enabled: false, retention_days: 180, allow_conversation_excerpt: false, max_per_user_per_day: 100 }
}

const empty = { items: [], total: 0, page: 1, page_size: 20, pages: 0 }

function mountView() {
  return mount(ClaudexFeedbackView, {
    global: { stubs: { Icon: true, RouterLink: RouterLinkStub, teleport: true } }
  })
}

async function loaded(settings: unknown = DEFAULTS) {
  api.getSettings.mockResolvedValue(settings)
  api.listDiagnostics.mockResolvedValue(empty)
  api.listFeedback.mockResolvedValue(empty)
  const wrapper = mountView()
  await flushPromises()
  return wrapper
}

describe('ClaudexFeedbackView', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
  })

  it('shows both kinds off by default and explains that users must also agree', async () => {
    const wrapper = await loaded()
    const note = wrapper.get('[data-testid="claudex-feedback-consent-note"]').text()
    expect(note).toContain('admin.claudexFeedback.consentNote')
    expect(note).toContain('admin.claudexFeedback.notCollecting')
    expect(wrapper.get('[data-testid="claudex-feedback-diagnostics-enabled"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.get('[data-testid="claudex-feedback-feedback-enabled"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.get('[data-testid="claudex-feedback-allow-excerpt"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.find('[data-testid="claudex-unavailable"]').exists()).toBe(false)
  })

  it('treats a missing or partial setting as off', async () => {
    const wrapper = await loaded({})
    expect(wrapper.get('[data-testid="claudex-feedback-diagnostics-enabled"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.get('[data-testid="claudex-feedback-feedback-enabled"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.get('[data-testid="claudex-feedback-consent-note"]').text()).toContain('admin.claudexFeedback.notCollecting')
  })

  it('shows the settings and both inboxes', async () => {
    const wrapper = await loaded()
    expect(wrapper.find('[data-testid="claudex-diagnostics-inbox"]').exists()).toBe(true)
    expect(api.listDiagnostics).toHaveBeenCalledWith({ page: 1, page_size: 20 })
    await wrapper.get('[data-testid="claudex-feedback-tab-feedback"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-feedback-inbox"]').exists()).toBe(true)
    expect(api.listFeedback).toHaveBeenCalledWith({ page: 1, page_size: 20 })
  })

  it('turns collection on only through step-up', async () => {
    const wrapper = await loaded()
    api.updateSettings
      .mockRejectedValueOnce({ status: 403, reason: 'STEP_UP_REQUIRED' })
      .mockImplementationOnce(async (body) => body)
    await wrapper.get('[data-testid="claudex-feedback-diagnostics-enabled"]').trigger('click')
    await wrapper.get('[data-testid="claudex-diag-retention"]').setValue('14')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()

    const stepUp = wrapper.findComponent({ name: 'TotpStepUpDialog' }).props('controller') as StepUpController
    expect(stepUp.visible.value).toBe(true)
    stepUp.onVerified()
    await flushPromises()

    expect(api.updateSettings).toHaveBeenCalledTimes(2)
    expect(api.updateSettings).toHaveBeenLastCalledWith({
      diagnostics: { enabled: true, retention_days: 14, max_per_user_per_day: 200 },
      feedback: { enabled: false, retention_days: 180, allow_conversation_excerpt: false, max_per_user_per_day: 100 }
    })
    expect(wrapper.get('[data-testid="claudex-feedback-consent-note"]').text()).toContain('admin.claudexFeedback.collecting')
  })

  it('does not turn anything on when the step-up prompt is cancelled', async () => {
    const wrapper = await loaded()
    api.updateSettings.mockRejectedValue({ status: 403, reason: 'STEP_UP_REQUIRED' })
    await wrapper.get('[data-testid="claudex-feedback-feedback-enabled"]').trigger('click')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    ;(wrapper.findComponent({ name: 'TotpStepUpDialog' }).props('controller') as StepUpController).onCancel()
    await flushPromises()
    expect(api.updateSettings).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="claudex-feedback-consent-note"]').text()).toContain('admin.claudexFeedback.notCollecting')
    expect(wrapper.find('[data-testid="claudex-save-error"]').exists()).toBe(false)
  })

  it('checks the ranges before saving', async () => {
    const wrapper = await loaded()
    await wrapper.get('[data-testid="claudex-diag-retention"]').setValue('400')
    await wrapper.get('[data-testid="claudex-fb-retention"]').setValue('731')
    await wrapper.get('[data-testid="claudex-fb-per-day"]').setValue('0')
    expect(wrapper.text()).toContain('admin.claudexFeedback.problems.diagnosticsRetention')
    expect(wrapper.text()).toContain('admin.claudexFeedback.problems.feedbackRetention')
    expect(wrapper.text()).toContain('admin.claudexFeedback.problems.perDay')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    expect(api.updateSettings).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe('admin.claudexFeedback.fixProblems')
  })

  it('says the page is not in this build when the server has no such endpoint', async () => {
    api.getSettings.mockRejectedValue({ status: 404 })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-unavailable"]').exists()).toBe(true)
    expect(api.listDiagnostics).not.toHaveBeenCalled()
  })
})

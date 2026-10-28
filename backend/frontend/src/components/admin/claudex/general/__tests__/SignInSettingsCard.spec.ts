// CLAUDEX: tests for the Sign-in card of the Claudex console General page (LOGIN).
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SignInSettingsCard from '../SignInSettingsCard.vue'
import { validPrivacyPolicyURL } from '@/api/admin/claudex/signIn'
import type { StepUpController } from '@/composables/useStepUp'

const { getSignIn, updateSignIn } = vi.hoisted(() => ({ getSignIn: vi.fn(), updateSignIn: vi.fn() }))

vi.mock('@/api/admin/claudex/signIn', async () => ({
  ...(await vi.importActual<typeof import('@/api/admin/claudex/signIn')>('@/api/admin/claudex/signIn')),
  getSignIn,
  updateSignIn
}))

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: () => false
  })
}))

const stepUp = { run: <T>(action: () => Promise<T>) => action() } as unknown as StepUpController

const base = {
  email_code_login_enabled: false,
  privacy_policy_url: '',
  smtp_configured: true,
  backend_mode_enabled: false,
  email_code_login_available: false
}

function mountCard() {
  return mount(SignInSettingsCard, { props: { stepUp }, global: { stubs: { Icon: true } } })
}

describe('SignInSettingsCard', () => {
  beforeEach(() => {
    getSignIn.mockReset()
    updateSignIn.mockReset()
  })

  it('saves the email code switch and the privacy policy link', async () => {
    getSignIn.mockResolvedValue(base)
    updateSignIn.mockResolvedValue({
      ...base,
      email_code_login_enabled: true,
      privacy_policy_url: '/legal/privacy',
      email_code_login_available: true
    })
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-general-email-code"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.text()).toContain('admin.claudexGeneral.signIn.smtpNote')
    expect(wrapper.get('[data-testid="claudex-save-button"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="claudex-general-email-code"]').trigger('click')
    await wrapper.get('[data-testid="claudex-general-privacy-url"]').setValue(' /legal/privacy ')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()

    expect(updateSignIn).toHaveBeenCalledWith({ email_code_login_enabled: true, privacy_policy_url: '/legal/privacy' })
    expect(wrapper.get('[data-testid="claudex-general-email-code-status"]').text()).toBe(
      'admin.claudexGeneral.signIn.available'
    )
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.saved')
  })

  it('says the email code needs SMTP', async () => {
    getSignIn.mockResolvedValue({ ...base, email_code_login_enabled: true, smtp_configured: false })
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-general-email-code-smtp"]').text()).toBe(
      'admin.claudexGeneral.signIn.smtpMissing'
    )
    expect(wrapper.get('[data-testid="claudex-general-email-code-status"]').text()).toBe(
      'admin.claudexGeneral.signIn.unavailable'
    )
  })

  it('refuses an invalid privacy policy link before saving', async () => {
    getSignIn.mockResolvedValue(base)
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="claudex-general-privacy-url"]').setValue('http://example.com')
    expect(wrapper.find('[data-testid="claudex-general-privacy-url-error"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="claudex-save-button"]').attributes('disabled')).toBeDefined()
  })

  it('stays hidden when the server has no sign-in setting', async () => {
    getSignIn.mockRejectedValue({ status: 404, message: '404 page not found' })
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-general-sign-in"]').exists()).toBe(false)
  })

  it('checks links like the server', () => {
    for (const ok of ['', '/legal/privacy', 'https://example.com/privacy']) expect(validPrivacyPolicyURL(ok)).toBe(true)
    for (const bad of ['http://example.com', '//evil.example', '/a b', 'privacy', 'https://u:p@example.com'])
      expect(validPrivacyPolicyURL(bad)).toBe(false)
  })
})

// CLAUDEX: LOGIN tests for /reset-password on ClaudexPublicLayout (the reset email's landing page).
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ResetPasswordView from '@/views/auth/ResetPasswordView.vue'

const state = vi.hoisted(() => ({ query: {} as Record<string, unknown> }))
const mocks = vi.hoisted(() => ({
  resetPassword: vi.fn(),
  showError: vi.fn(),
  showSuccess: vi.fn()
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({
    get query() {
      return state.query
    }
  })
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key })
}))

vi.mock('@/stores', () => ({
  useAppStore: () => ({ showError: mocks.showError, showSuccess: mocks.showSuccess })
}))

vi.mock('@/api/auth', () => ({
  resetPassword: (...args: unknown[]) => mocks.resetPassword(...args)
}))

function mountPage() {
  return mount(ResetPasswordView, {
    global: {
      stubs: {
        Icon: true,
        RouterLink: { props: ['to'], template: '<a :href="to" data-router-link><slot /></a>' }
      }
    }
  })
}

describe('ResetPasswordView', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    state.query = { email: 'ada@example.com', token: 'reset-token' }
  })

  it('shows the form in the sign-in page frame', async () => {
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-public-layout"]').exists()).toBe(true)
    expect(wrapper.get('h1').text()).toBe('auth.resetPasswordTitle')
    expect(wrapper.get('#email').element).toHaveProperty('value', 'ada@example.com')
    // "Sign in" goes to the Claudex web app at '/'
    expect(wrapper.get('[data-testid="reset-password-footer-sign-in"]').attributes('href')).toBe('/')
  })

  it('resets the password and then points to the web app, with a console link for admins', async () => {
    mocks.resetPassword.mockResolvedValue({})
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('#password').setValue('new-secret-1')
    await wrapper.get('#confirmPassword').setValue('new-secret-1')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.resetPassword).toHaveBeenCalledWith({
      email: 'ada@example.com',
      token: 'reset-token',
      new_password: 'new-secret-1'
    })
    expect(wrapper.find('[data-testid="reset-password-success"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="reset-password-sign-in"]').attributes('href')).toBe('/')
    expect(wrapper.get('[data-testid="reset-password-console-sign-in"]').attributes('href')).toBe('/admin/login')
  })

  it('does not submit mismatched passwords', async () => {
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('#password').setValue('new-secret-1')
    await wrapper.get('#confirmPassword').setValue('other-secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.resetPassword).not.toHaveBeenCalled()
    expect(mocks.showError).toHaveBeenCalledWith('auth.passwordsDoNotMatch')
  })

  it('shows the error of a failed reset in the card', async () => {
    mocks.resetPassword.mockRejectedValue({ response: { data: { code: 'INVALID_RESET_TOKEN' } } })
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.get('#password').setValue('new-secret-1')
    await wrapper.get('#confirmPassword').setValue('new-secret-1')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-testid="reset-password-error"]').text()).toBe('auth.invalidOrExpiredToken')
  })

  it('offers a new link when the link is incomplete', async () => {
    state.query = { email: 'ada@example.com' }
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="reset-password-invalid"]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.text()).toContain('auth.requestNewResetLink')
  })
})

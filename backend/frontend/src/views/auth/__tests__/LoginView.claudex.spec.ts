// CLAUDEX: where a web sign-in ends while the web console is for admins only
// (web_console_admin_only), for password, passkey and 2FA sign-in.
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest' // CLAUDEX: W-CONSOLE afterAll
import LoginView from '@/views/auth/LoginView.vue'

const state = vi.hoisted(() => ({
  isAdmin: false,
  adminOnly: true,
  query: {} as Record<string, unknown>,
  requires2FA: false
}))

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  login: vi.fn(),
  login2FA: vi.fn(),
  loginWithPasskey: vi.fn(),
  logout: vi.fn(),
  showSuccess: vi.fn(),
  showInfo: vi.fn(), // CLAUDEX: W-CONSOLE
  locationReplace: vi.fn(), // CLAUDEX: W-CONSOLE the full-page jump to the web app
  ensureLoaded: vi.fn(),
  getPublicSettings: vi.fn()
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mocks.push,
    currentRoute: {
      get value() {
        return { query: state.query }
      }
    }
  })
}))

vi.mock('vue-i18n', () => ({
  createI18n: () => ({ global: { t: (key: string) => key } }),
  useI18n: () => ({ t: (key: string) => key })
}))

vi.mock('@/stores', () => ({
  useAuthStore: () => ({
    login: mocks.login,
    login2FA: mocks.login2FA,
    loginWithPasskey: mocks.loginWithPasskey,
    logout: mocks.logout,
    get isAdmin() {
      return state.isAdmin
    }
  }),
  useAppStore: () => ({
    showError: vi.fn(),
    showSuccess: mocks.showSuccess,
    showInfo: mocks.showInfo, // CLAUDEX: W-CONSOLE
    showWarning: vi.fn()
  })
}))

vi.mock('@/stores/webConsole', () => ({
  useWebConsoleStore: () => ({
    get adminOnly() {
      return state.adminOnly
    },
    ensureLoaded: mocks.ensureLoaded
  })
}))

vi.mock('@/api/auth', () => ({
  buildOAuthLoginStartURL: vi.fn(),
  getPublicSettings: (...args: unknown[]) => mocks.getPublicSettings(...args),
  isTotp2FARequired: () => state.requires2FA,
  isWeChatWebOAuthEnabled: () => false,
  startOAuthLogin: vi.fn()
}))

const publicSettings = {
  registration_enabled: true,
  turnstile_enabled: false,
  turnstile_site_key: '',
  backend_mode_enabled: false,
  password_reset_enabled: true,
  passkey_enabled: true,
  login_agreement_enabled: false,
  login_agreement_documents: []
}

const TotpStub = defineComponent({
  emits: ['verify', 'cancel'],
  setup(_, { emit, expose }) {
    expose({ setVerifying: vi.fn(), setError: vi.fn() })
    return () => h('button', { type: 'button', 'data-testid': 'totp-verify', onClick: () => emit('verify', '123456') })
  }
})

function mountLogin() {
  return mount(LoginView, {
    global: {
      stubs: {
        AuthLayout: { template: '<div><slot /><slot name="footer" /></div>' },
        DingTalkOAuthSection: true,
        EmailOAuthButtons: true,
        Icon: true,
        LinuxDoOAuthSection: true,
        LoginAgreementPrompt: true,
        OidcOAuthSection: true,
        RouterLink: { template: '<a><slot /></a>' },
        TotpLoginModal: TotpStub,
        TurnstileWidget: true,
        WechatOAuthSection: true,
        transition: false
      }
    }
  })
}

async function signInWithPassword() {
  const wrapper = mountLogin()
  await flushPromises()
  await wrapper.get('#email').setValue('someone@example.com')
  await wrapper.get('#password').setValue('secret-123')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  return wrapper
}

// CLAUDEX: W-CONSOLE a non-admin leaves the console for the web app at '/' with a full-page load
function expectSentToWebApp() {
  expect(mocks.locationReplace).toHaveBeenCalledWith('/')
  expect(mocks.showInfo).toHaveBeenCalledWith('desktopOnly.useWebAppOrDesktop')
  expect(mocks.push).not.toHaveBeenCalled()
}

describe('LoginView after sign-in (CLAUDEX web_console_admin_only)', () => {
  const originalLocation = window.location

  afterAll(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, replace: mocks.locationReplace }
    })
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.getPublicSettings.mockResolvedValue(publicSettings)
    mocks.ensureLoaded.mockResolvedValue(undefined)
    mocks.login.mockResolvedValue({})
    mocks.login2FA.mockResolvedValue({})
    mocks.loginWithPasskey.mockResolvedValue({})
    mocks.logout.mockResolvedValue(undefined)
    state.isAdmin = false
    state.adminOnly = true
    state.query = {}
    state.requires2FA = false
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class PublicKeyCredential {} })
  })

  it('signs a non-admin out of the console and sends them to the web app', async () => {
    await signInWithPassword()
    expect(mocks.logout).toHaveBeenCalledOnce()
    expectSentToWebApp()
    expect(mocks.showSuccess).not.toHaveBeenCalled()
    expect(mocks.logout.mock.invocationCallOrder[0]).toBeLessThan(mocks.locationReplace.mock.invocationCallOrder[0])
  })

  it('ignores the redirect query for a non-admin', async () => {
    state.query = { redirect: '/admin/my/keys' }
    await signInWithPassword()
    expectSentToWebApp()
  })

  it('sends an admin to the admin dashboard and keeps the session', async () => {
    state.isAdmin = true
    await signInWithPassword()
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(mocks.showSuccess).toHaveBeenCalledWith('auth.loginSuccess')
    expect(mocks.push).toHaveBeenCalledWith('/admin/dashboard')
  })

  it('sends an admin to an in-app redirect query', async () => {
    state.isAdmin = true
    state.query = { redirect: '/admin/claudex/policy' }
    await signInWithPassword()
    expect(mocks.push).toHaveBeenCalledWith('/admin/claudex/policy')
  })

  it('keeps the upstream destination for non-admins when the setting is off', async () => {
    state.adminOnly = false
    await signInWithPassword()
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/admin/my/dashboard')
  })

  it('applies the same rule after 2FA', async () => {
    state.requires2FA = true
    mocks.login.mockResolvedValue({ requires_2fa: true, temp_token: 't', user_email_masked: 's***@example.com' })
    const wrapper = await signInWithPassword()
    expect(mocks.push).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="totp-verify"]').trigger('click')
    await flushPromises()
    expect(mocks.login2FA).toHaveBeenCalledWith('t', '123456')
    expect(mocks.logout).toHaveBeenCalledOnce()
    expectSentToWebApp()
  })

  it('lets an admin through after 2FA', async () => {
    state.requires2FA = true
    state.isAdmin = true
    mocks.login.mockResolvedValue({ requires_2fa: true, temp_token: 't', user_email_masked: 'a***@example.com' })
    const wrapper = await signInWithPassword()
    await wrapper.get('[data-testid="totp-verify"]').trigger('click')
    await flushPromises()
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/admin/dashboard')
  })

  it('applies the same rule after passkey sign-in', async () => {
    const wrapper = mountLogin()
    await flushPromises()
    const passkey = wrapper.findAll('button').find((button) => button.text().includes('auth.passkeySignIn'))
    expect(passkey).toBeTruthy()
    await passkey!.trigger('click')
    await flushPromises()
    expect(mocks.loginWithPasskey).toHaveBeenCalledOnce()
    expect(mocks.logout).toHaveBeenCalledOnce()
    expectSentToWebApp()
  })

  it('hides the sign-up link while the console is for admins only and keeps the password reset link', async () => {
    const wrapper = mountLogin()
    await flushPromises()
    expect(wrapper.text()).not.toContain('auth.signUp')
    expect(wrapper.text()).toContain('auth.forgotPassword')
  })

  it('shows the sign-up link again when the setting is off', async () => {
    state.adminOnly = false
    const wrapper = mountLogin()
    await flushPromises()
    expect(wrapper.text()).toContain('auth.signUp')
  })
})

// CLAUDEX: tests for /desktop-only (web console for administrators only).
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DesktopOnlyView from '@/views/public/DesktopOnlyView.vue'

const state = vi.hoisted(() => ({
  isAuthenticated: false,
  query: {} as Record<string, unknown>
}))

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  logout: vi.fn(),
  getClientRelease: vi.fn(),
  detectDesktopPlatform: vi.fn()
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({
    get query() {
      return state.query
    }
  }),
  useRouter: () => ({ replace: mocks.replace })
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key)
  })
}))

vi.mock('@/stores', () => ({
  useAuthStore: () => ({
    get isAuthenticated() {
      return state.isAuthenticated
    },
    logout: mocks.logout
  })
}))

vi.mock('@/api/claudexPublic', () => ({
  getClientRelease: (...args: unknown[]) => mocks.getClientRelease(...args)
}))

vi.mock('@/utils/claudexDesktopPlatform', () => ({
  detectDesktopPlatform: (...args: unknown[]) => mocks.detectDesktopPlatform(...args)
}))

function mountPage() {
  return mount(DesktopOnlyView, {
    global: {
      stubs: {
        Icon: true,
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }
      }
    }
  })
}

describe('DesktopOnlyView', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    state.isAuthenticated = false
    state.query = {}
    mocks.detectDesktopPlatform.mockResolvedValue({ platform: 'darwin', arch: 'arm64' })
    mocks.getClientRelease.mockResolvedValue({
      api_version: 1,
      server: { version: '0.2.8', build_type: 'source' },
      latest_version: '1.4.0',
      download_url: 'https://dl.example.com/Claudex-1.4.0-arm64.zip'
    })
    mocks.logout.mockResolvedValue(undefined)
    mocks.replace.mockResolvedValue(undefined)
  })

  it('points to the desktop app and back to sign in when signed out', async () => {
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.text()).toContain('desktopOnly.title')
    expect(wrapper.text()).toContain('desktopOnly.body')
    // CLAUDEX: LOGIN the sign-in page's frame, with the wordmark linking to the web app
    expect(wrapper.get('h1').text()).toBe('desktopOnly.title')
    expect(wrapper.get('[data-testid="claudex-public-brand"]').attributes('href')).toBe('/')
    expect(wrapper.get('[data-testid="desktop-only-sign-in"]').attributes('href')).toBe('/admin/login') // CLAUDEX: W-CONSOLE
    // CLAUDEX: W-CONSOLE the page also points to the web app at the site root
    expect(wrapper.get('[data-testid="desktop-only-web-app"]').attributes('href')).toBe('/')
    expect(wrapper.find('[data-testid="desktop-only-sign-out"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="desktop-only-not-admin"]').exists()).toBe(false)
  })

  it('explains the sign-out after a non-admin web sign-in', async () => {
    state.query = { reason: 'not_admin' }
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.get('[data-testid="desktop-only-not-admin"]').text()).toBe('desktopOnly.notAdmin')
  })

  it('offers the download the server publishes for this computer', async () => {
    const wrapper = mountPage()
    await flushPromises()
    expect(mocks.getClientRelease).toHaveBeenCalledWith({ platform: 'darwin', arch: 'arm64' })
    const link = wrapper.get('[data-testid="desktop-only-download"]')
    expect(link.attributes('href')).toBe('https://dl.example.com/Claudex-1.4.0-arm64.zip')
    expect(link.attributes('rel')).toContain('noopener')
    expect(link.text()).toContain('desktopOnly.downloadFor')
    expect(link.text()).toContain('desktopOnly.platforms.darwin')
    expect(wrapper.text()).toContain('desktopOnly.version{"version":"1.4.0"}')
  })

  it.each([
    ['no download for this platform', { api_version: 1, download_url: null }],
    ['a server without client release information', { api_version: 1, server: {} }],
    ['a non-https link', { api_version: 1, download_url: 'http://dl.example.com/Claudex.zip' }],
    ['a script link', { api_version: 1, download_url: 'javascript:alert(1)' }]
  ])('shows no download button for %s', async (_name, release) => {
    mocks.getClientRelease.mockResolvedValue(release)
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="desktop-only-download"]').exists()).toBe(false)
  })

  it('shows no download button when the release request fails', async () => {
    mocks.getClientRelease.mockRejectedValue({ status: 500 })
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="desktop-only-download"]').exists()).toBe(false)
  })

  it('does not ask for a download on a phone or tablet', async () => {
    mocks.detectDesktopPlatform.mockResolvedValue({})
    const wrapper = mountPage()
    await flushPromises()
    expect(mocks.getClientRelease).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="desktop-only-download"]').exists()).toBe(false)
  })

  it('signs a signed-in session out and returns to sign in', async () => {
    state.isAuthenticated = true
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="desktop-only-sign-in"]').exists()).toBe(false)
    await wrapper.get('[data-testid="desktop-only-sign-out"]').trigger('click')
    await flushPromises()
    expect(mocks.logout).toHaveBeenCalledOnce()
    expect(mocks.replace).toHaveBeenCalledWith('/admin/login') // CLAUDEX: W-CONSOLE
  })
})

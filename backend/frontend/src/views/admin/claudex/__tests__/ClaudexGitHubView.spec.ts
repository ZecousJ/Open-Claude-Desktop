// CLAUDEX: tests for the GitHub connection console page (W-GITHUB).
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ClaudexGitHubView from '../ClaudexGitHubView.vue'
import { githubFormFromSetting, githubUpdateFromForm, validateGitHubForm } from '@/components/admin/claudex/github/githubForm'

const { getGitHub, updateGitHub } = vi.hoisted(() => ({ getGitHub: vi.fn(), updateGitHub: vi.fn() }))

vi.mock('@/api/admin/claudex/github', () => ({ getGitHub, updateGitHub }))

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({
    t: (key: string) => key,
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

const stored = {
  enabled: true,
  kind: 'oauth_app',
  client_id: 'Iv1.abc',
  client_secret_configured: true,
  client_secret_masked: '********wxyz',
  public_base_url: 'https://claudex.example.com',
  callback_url: 'https://claudex.example.com/api/v1/claudex/web/github/callback',
  can_store_secret: true,
  warnings: ['Set the public address of this service.']
}

const off = {
  ...stored,
  enabled: false,
  client_id: '',
  client_secret_configured: false,
  client_secret_masked: '',
  public_base_url: '',
  callback_url: '',
  warnings: []
}

async function loaded(setting: unknown = stored) {
  getGitHub.mockResolvedValue(setting)
  const wrapper = mount(ClaudexGitHubView, { global: { stubs: { Icon: true } } })
  await flushPromises()
  return wrapper
}

type Wrapper = Awaited<ReturnType<typeof loaded>>
const el = (w: Wrapper, id: string) => w.get(`[data-testid="${id}"]`)

describe('ClaudexGitHubView', () => {
  beforeEach(() => {
    getGitHub.mockReset()
    updateGitHub.mockReset()
  })

  it('shows the stored app with the secret masked and the callback address to register', async () => {
    const w = await loaded()
    expect(el(w, 'claudex-github-enabled').attributes('aria-checked')).toBe('true')
    expect((el(w, 'claudex-github-client-id').element as HTMLInputElement).value).toBe('Iv1.abc')
    expect(el(w, 'claudex-github-secret-masked').text()).toBe('********wxyz')
    const secret = el(w, 'claudex-github-client-secret').element as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(secret.value).toBe('')
    expect(el(w, 'claudex-github-callback').text()).toContain('/api/v1/claudex/web/github/callback')
    expect(el(w, 'claudex-github-warning').text()).toContain('public address')
  })

  it('saves a new secret and never puts a stored one in the body', async () => {
    const w = await loaded(off)
    await el(w, 'claudex-github-client-id').setValue('Iv1.new')
    await el(w, 'claudex-github-client-secret').setValue('a-long-client-secret')
    await el(w, 'claudex-github-enabled').trigger('click')
    updateGitHub.mockResolvedValue({ ...stored, client_id: 'Iv1.new' })
    await el(w, 'claudex-save-button').trigger('click')
    await flushPromises()
    expect(updateGitHub).toHaveBeenCalledTimes(1)
    expect(updateGitHub.mock.calls[0][0]).toMatchObject({
      enabled: true,
      client_id: 'Iv1.new',
      client_secret: 'a-long-client-secret'
    })
    // After saving the field is empty again.
    expect((el(w, 'claudex-github-client-secret').element as HTMLInputElement).value).toBe('')
  })

  it('turning it on without a secret is refused before any request', async () => {
    const w = await loaded(off)
    await el(w, 'claudex-github-client-id').setValue('Iv1.new')
    await el(w, 'claudex-github-enabled').trigger('click')
    await el(w, 'claudex-save-button').trigger('click')
    await flushPromises()
    expect(updateGitHub).not.toHaveBeenCalled()
    expect(w.text()).toContain('admin.claudexGitHub.problems.secretRequired')
  })

  it('removing the secret turns GitHub off, and Undo puts it back', async () => {
    const w = await loaded()
    await el(w, 'claudex-github-secret-remove').trigger('click')
    expect(el(w, 'claudex-github-enabled').attributes('aria-checked')).toBe('false')
    await el(w, 'claudex-github-secret-undo').trigger('click')
    expect(el(w, 'claudex-github-enabled').attributes('aria-checked')).toBe('true')
  })

  it('says so when the server has no GitHub support', async () => {
    getGitHub.mockRejectedValue({ status: 404 })
    const w = mount(ClaudexGitHubView, { global: { stubs: { Icon: true } } })
    await flushPromises()
    expect(w.find('[data-testid="claudex-github-app"]').exists()).toBe(false)
  })
})

describe('githubForm', () => {
  it('leaves an empty secret out of the body and sends clear_client_secret alone', () => {
    const form = githubFormFromSetting(stored as never)
    expect(githubUpdateFromForm(form)).not.toHaveProperty('client_secret')
    form.clearSecret = true
    form.clientSecret = 'ignored-secret-value'
    const body = githubUpdateFromForm(form)
    expect(body.clear_client_secret).toBe(true)
    expect(body).not.toHaveProperty('client_secret')
  })

  it('checks the public address and the secret', () => {
    const form = githubFormFromSetting(off as never)
    form.publicBaseUrl = 'http://claudex.example.com'
    form.clientSecret = 'short'
    expect(validateGitHubForm(form)).toEqual({ public_base_url: 'baseUrl', client_secret: 'secretLength' })
    form.publicBaseUrl = 'http://localhost:8080'
    form.clientSecret = 'a-long-client-secret'
    expect(validateGitHubForm(form)).toEqual({})
  })
})

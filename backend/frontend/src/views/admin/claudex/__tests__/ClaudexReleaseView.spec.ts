// CLAUDEX: tests for the Claudex console desktop release page (K4).
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ClaudexReleaseView from '../ClaudexReleaseView.vue'
import type { StepUpController } from '@/composables/useStepUp'

const { getRelease, updateRelease, KNOWN_KEYS } = vi.hoisted(() => ({
  getRelease: vi.fn(),
  updateRelease: vi.fn(),
  KNOWN_KEYS: new Set(['admin.claudexRelease.errors.CLAUDEX_RELEASE_INVALID'])
}))

vi.mock('@/api/admin/claudex/release', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin/claudex/release')>()),
  getRelease,
  updateRelease
}))

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: (key: string) => KNOWN_KEYS.has(key)
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

const SHA = 'b'.repeat(64)

const stored = {
  channels: {
    stable: {
      latest_version: '1.4.0',
      minimum_version: '1.2.0',
      published_at: null,
      release_notes_url: 'https://claudex.example.com/releases/1.4.0',
      release_notes_md: '## 1.4.0\n- Plan usage limits',
      downloads: {
        'darwin-arm64': { url: 'https://dl.example.com/Claudex-1.4.0-arm64.zip', sha256: SHA }
      }
    }
  },
  enforce_minimum_on_gateway: false,
  updated_at: '2026-09-21T00:00:00Z'
}

function mountView() {
  return mount(ClaudexReleaseView, { global: { stubs: { Icon: true } } })
}

async function loaded(setting: unknown = stored) {
  getRelease.mockResolvedValue(setting)
  const wrapper = mountView()
  await flushPromises()
  return wrapper
}

async function save(wrapper: ReturnType<typeof mountView>) {
  await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
  await flushPromises()
}

describe('ClaudexReleaseView', () => {
  beforeEach(() => {
    getRelease.mockReset()
    updateRelease.mockReset()
  })

  it('loads the stored release into the form with a rendered preview', async () => {
    const wrapper = await loaded()
    expect((wrapper.get('[data-testid="claudex-release-latest"]').element as HTMLInputElement).value).toBe('1.4.0')
    expect((wrapper.get('[data-testid="claudex-release-minimum"]').element as HTMLInputElement).value).toBe('1.2.0')
    expect(
      (wrapper.get('[data-testid="claudex-release-download-sha-darwin-arm64"]').element as HTMLInputElement).value
    ).toBe(SHA)
    expect(wrapper.get('[data-testid="claudex-release-notes-preview"] h2').text()).toBe('1.4.0')
    expect(wrapper.get('[data-testid="claudex-release-updated"]').exists()).toBe(true)
    // Seven platforms (RELEASE_PLATFORMS), each with a URL and a checksum field.
    expect(wrapper.findAll('[data-testid^="claudex-release-download-sha-"]')).toHaveLength(7)
  })

  it('keeps the gateway enforcement off by default, with the warning shown', async () => {
    const wrapper = await loaded({ channels: {}, enforce_minimum_on_gateway: undefined })
    const toggle = wrapper.get('[data-testid="claudex-release-enforce"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(wrapper.get('[data-testid="claudex-release-enforce-warning"]').text()).toBe(
      'admin.claudexRelease.enforcement.warning'
    )
    await toggle.trigger('click')
    expect(wrapper.find('[data-testid="claudex-release-enforce-no-minimum"]').exists()).toBe(true)
  })

  it('shows raw HTML in the notes as text in the preview', async () => {
    const wrapper = await loaded()
    await wrapper.get('[data-testid="claudex-release-notes-input"]').setValue('<img src="https://x.example/a.png"> <script>x()</script>')
    const preview = wrapper.get('[data-testid="claudex-release-notes-preview"]')
    expect(preview.find('img').exists()).toBe(false)
    expect(preview.find('script').exists()).toBe(false)
    expect(preview.text()).toContain('<script>x()</script>')
  })

  it('refuses to save an http download URL', async () => {
    const wrapper = await loaded()
    await wrapper.get('[data-testid="claudex-release-download-url-win32-x64"] input').setValue('http://dl.example.com/setup.exe')
    await save(wrapper)
    expect(updateRelease).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe('admin.claudexRelease.fixProblems')
    expect(wrapper.get('[data-testid="claudex-release-download-url-win32-x64"]').text()).toContain('admin.claudex.common.https')
  })

  it('refuses a minimum version newer than the latest', async () => {
    const wrapper = await loaded()
    await wrapper.get('[data-testid="claudex-release-minimum"]').setValue('1.5.0')
    expect(wrapper.get('[data-testid="claudex-release-minimum-error"]').text()).toBe(
      'admin.claudexRelease.problems.minimumAboveLatest{"max":20000}'
    )
    await save(wrapper)
    expect(updateRelease).not.toHaveBeenCalled()
  })

  it('saves the whole setting through step-up', async () => {
    const wrapper = await loaded()
    updateRelease
      .mockRejectedValueOnce({ status: 403, code: 'STEP_UP_REQUIRED' })
      .mockImplementationOnce(async (body) => ({ ...body, updated_at: '2026-09-26T00:00:00Z' }))
    await wrapper.get('[data-testid="claudex-release-latest"]').setValue('1.5.0')
    await wrapper.get('[data-testid="claudex-release-download-url-linux-x64"] input').setValue('https://dl.example.com/claudex.AppImage')
    await wrapper.get('[data-testid="claudex-release-download-sha-linux-x64"]').setValue(SHA.toUpperCase())
    await wrapper.get('[data-testid="claudex-release-enforce"]').trigger('click')
    await save(wrapper)

    const stepUp = wrapper.findComponent({ name: 'TotpStepUpDialog' }).props('controller') as StepUpController
    expect(stepUp.visible.value).toBe(true)
    stepUp.onVerified()
    await flushPromises()

    expect(updateRelease).toHaveBeenCalledTimes(2)
    expect(updateRelease).toHaveBeenLastCalledWith({
      channels: {
        stable: {
          latest_version: '1.5.0',
          minimum_version: '1.2.0',
          published_at: null,
          release_notes_url: 'https://claudex.example.com/releases/1.4.0',
          release_notes_md: '## 1.4.0\n- Plan usage limits',
          downloads: {
            'darwin-arm64': { url: 'https://dl.example.com/Claudex-1.4.0-arm64.zip', sha256: SHA },
            'linux-x64': { url: 'https://dl.example.com/claudex.AppImage', sha256: SHA }
          }
        }
      },
      enforce_minimum_on_gateway: true
    })
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.saved')
  })

  it('maps CLAUDEX_RELEASE_INVALID to the page message and names the field', async () => {
    const wrapper = await loaded()
    updateRelease.mockRejectedValue({
      status: 400,
      reason: 'CLAUDEX_RELEASE_INVALID',
      message: 'invalid',
      metadata: { field: 'channels.stable.release_notes_url', rule: 'https' }
    })
    await wrapper.get('[data-testid="claudex-release-latest"]').setValue('1.4.1')
    await save(wrapper)
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe(
      'admin.claudexRelease.errors.CLAUDEX_RELEASE_INVALID admin.claudexRelease.serverField{"field":"release_notes_url"}'
    )
  })

  it('says the page is not in this build when the server has no such endpoint', async () => {
    getRelease.mockRejectedValue({ status: 404 })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('input').exists()).toBe(false)
  })
})

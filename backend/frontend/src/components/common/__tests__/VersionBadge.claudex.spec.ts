// CLAUDEX: VersionBadge when the server has online update disabled.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'

import VersionBadge from '../VersionBadge.vue'

const appStore = reactive({
  versionLoading: false,
  currentVersion: '0.2.8',
  latestVersion: '0.2.8',
  hasUpdate: false,
  releaseInfo: null,
  buildType: 'release',
  updateDisabled: true,
  fetchVersion: vi.fn(),
  clearVersionCache: vi.fn()
})

vi.mock('@/stores', () => ({
  useAuthStore: () => ({ isAdmin: true }),
  useAppStore: () => appStore
}))

vi.mock('@/api/admin/system', () => ({
  performUpdate: vi.fn(),
  restartService: vi.fn(),
  getRollbackVersions: vi.fn(),
  rollback: vi.fn()
}))

vi.mock('@/composables/useClipboard', async () => {
  const { ref } = await import('vue')
  return { useClipboard: () => ({ copied: ref(false), copyToClipboard: vi.fn() }) }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

describe('VersionBadge (Claudex build)', () => {
  afterEach(() => {
    appStore.updateDisabled = true
    document.body.innerHTML = ''
  })

  it('shows that online update is disabled instead of update and rollback controls', async () => {
    const wrapper = mount(VersionBadge, { attachTo: document.body })
    const badge = wrapper.get('button')
    expect(badge.attributes('title')).toBe('admin.claudex.selfUpdate.disabled')

    await badge.trigger('click')
    const text = wrapper.text()
    expect(text).toContain('v0.2.8')
    expect(text).toContain('admin.claudex.selfUpdate.disabled')
    expect(text).toContain('admin.claudex.selfUpdate.disabledHint')
    expect(text).not.toContain('version.upToDate')
    expect(text).not.toContain('version.rollback')
    expect(text).not.toContain('version.updateNow')
    wrapper.unmount()
  })

  it('keeps the upstream controls when online update is enabled', async () => {
    appStore.updateDisabled = false
    const wrapper = mount(VersionBadge, { attachTo: document.body })
    await wrapper.get('button').trigger('click')
    const text = wrapper.text()
    expect(text).toContain('version.upToDate')
    expect(text).toContain('version.rollback')
    expect(text).not.toContain('admin.claudex.selfUpdate.disabledHint')
    wrapper.unmount()
  })
})

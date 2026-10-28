// CLAUDEX: tests for the Claudex admin overview page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ClaudexOverviewView from '../ClaudexOverviewView.vue'

const { getOverview, getMemoryStats } = vi.hoisted(() => ({ getOverview: vi.fn(), getMemoryStats: vi.fn() }))

vi.mock('@/api/admin/claudex/overview', () => ({ getOverview }))
vi.mock('@/api/admin/claudex/memory', () => ({ getStats: getMemoryStats }))

vi.mock('@/components/layout/AppLayout.vue', () => ({
  default: defineComponent({
    name: 'AppLayout',
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    }
  })
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

const overview = {
  api_version: 1,
  server: { version: '0.2.8', build_type: 'source' },
  upstream: {
    repository: 'https://github.com/Wei-Shaw/sub2api',
    commit: 'a3eb7ef302961cba716dc78b39b93b60c467db0e'
  },
  self_update_disabled: true,
  features: [] as Array<{ name: string; setting_keys: string[] }>
}

describe('ClaudexOverviewView', () => {
  beforeEach(() => {
    getOverview.mockReset()
    getMemoryStats.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the server build, the upstream commit and the disabled online update', async () => {
    getOverview.mockResolvedValue(overview)
    const wrapper = mount(ClaudexOverviewView, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()

    const server = wrapper.get('[data-testid="claudex-overview-server"]').text()
    expect(server).toContain('0.2.8')
    expect(server).toContain('source')
    expect(wrapper.get('[data-testid="claudex-overview-self-update"]').text()).toContain(
      'admin.claudex.selfUpdate.disabled'
    )
    const link = wrapper.get('[data-testid="claudex-overview-upstream"] a')
    expect(link.text()).toBe('a3eb7ef')
    expect(link.attributes('href')).toBe(
      'https://github.com/Wei-Shaw/sub2api/commit/a3eb7ef302961cba716dc78b39b93b60c467db0e'
    )
    expect(wrapper.get('[data-testid="claudex-overview-features"]').text()).toContain(
      'admin.claudex.overview.featuresEmpty'
    )
  })

  it('lists installed features with their settings keys', async () => {
    getOverview.mockResolvedValue({
      ...overview,
      self_update_disabled: false,
      features: [
        { name: 'client-policy', setting_keys: ['claudex_client_policy'] },
        { name: 'device-keys', setting_keys: [] }
      ]
    })
    const wrapper = mount(ClaudexOverviewView, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()

    expect(wrapper.find('[data-testid="claudex-overview-self-update"]').exists()).toBe(false)
    const items = wrapper.findAll('[data-testid="claudex-overview-features"] li')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('client-policy')
    expect(items[0].text()).toContain('claudex_client_policy')
    expect(items[1].text()).toContain('admin.claudex.overview.noSettings')
  })

  it('does not ask for memory stats when the server has no memory feature', async () => {
    getOverview.mockResolvedValue(overview)
    const wrapper = mount(ClaudexOverviewView, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(getMemoryStats).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="claudex-overview-memory-key"]').exists()).toBe(false)
  })

  it('warns when memory has no encryption key and links to the Memory page', async () => {
    getOverview.mockResolvedValue({ ...overview, features: [{ name: 'memory', setting_keys: [] }] })
    getMemoryStats.mockResolvedValue({ encryption_key_ready: false })
    const wrapper = mount(ClaudexOverviewView, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    const warning = wrapper.get('[data-testid="claudex-overview-memory-key"]')
    expect(warning.text()).toContain('admin.claudexMemory.overviewWarning.title')
    expect(warning.findComponent(RouterLinkStub).props('to')).toBe('/admin/claudex/memory')
  })

  it('shows no memory warning when the key is ready or the stats fail', async () => {
    getOverview.mockResolvedValue({ ...overview, features: [{ name: 'memory', setting_keys: [] }] })
    getMemoryStats.mockResolvedValueOnce({ encryption_key_ready: true })
    const wrapper = mount(ClaudexOverviewView, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-overview-memory-key"]').exists()).toBe(false)

    getMemoryStats.mockRejectedValueOnce({ status: 500, message: 'boom' })
    await wrapper.get('[data-testid="claudex-overview-refresh"]').trigger('click')
    await flushPromises()
    expect(getMemoryStats).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="claudex-overview-memory-key"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="claudex-overview-error"]').exists()).toBe(false)
  })

  it('shows the error and reloads on refresh', async () => {
    getOverview.mockRejectedValueOnce({ message: 'administrator compliance acknowledgement is required' })
    const wrapper = mount(ClaudexOverviewView, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-overview-error"]').text()).toContain(
      'administrator compliance acknowledgement is required'
    )

    getOverview.mockResolvedValueOnce(overview)
    await wrapper.get('[data-testid="claudex-overview-refresh"]').trigger('click')
    await flushPromises()
    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="claudex-overview-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="claudex-overview-server"]').exists()).toBe(true)
  })
})

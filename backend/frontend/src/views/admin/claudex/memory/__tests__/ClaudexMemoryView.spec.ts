// CLAUDEX R3-S3: /admin/claudex/memory: usage numbers, the missing key
// warning, one user's metadata (never memory text) and clearing it, confirmed
// first and sent through step-up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils'

import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import UserSearchSelect from '@/components/admin/claudex/devices/UserSearchSelect.vue'
import { StepUpCancelledError } from '@/composables/useStepUp'
import ClaudexMemoryView from '../ClaudexMemoryView.vue'

const api = vi.hoisted(() => ({ getStats: vi.fn(), getUser: vi.fn(), clearUser: vi.fn() }))
const listUsers = vi.hoisted(() => vi.fn())
const stepUpRun = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ showSuccess: vi.fn(), showError: vi.fn() }))

vi.mock('@/api/admin/claudex/memory', () => api)
vi.mock('@/api/admin/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/admin/users')>()
  return { ...actual, list: listUsers, default: { ...actual.default, list: listUsers } }
})
vi.mock('@/stores', () => ({ useAppStore: () => toast }))
vi.mock('@/utils/format', () => ({
  formatDateTime: (value: unknown) => (value ? `date:${String(value)}` : ''),
  formatBytes: (value: number) => `${value} B`,
  formatNumber: (value: number) => String(value)
}))
vi.mock('@/composables/useStepUp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useStepUp')>()
  return {
    ...actual,
    useStepUp: () => ({ visible: { value: false }, blockedReason: { value: '' }, run: stepUpRun })
  }
})

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en)
}

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: (key: string) => typeof lookup(key) === 'string'
  })
}))

vi.mock('@/components/layout/AppLayout.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'AppLayout',
      setup(_, { slots }) {
        return () => vue.h('div', { 'data-testid': 'app-layout' }, slots.default?.())
      }
    })
  }
})

const stats = {
  users_opted_in: 4,
  users_with_memory: 3,
  documents: 5,
  edits: 12,
  total_bytes: 20480,
  encryption_key_ready: true
}

const userMeta = {
  user_id: 123,
  prefs: { set: true, search_chats: true, generate: false, updated_at: '2026-09-20T08:00:00Z' },
  scopes: [
    {
      scope: 'global',
      has_document: true,
      content_bytes: 2048,
      revision: 7,
      source: 'generated',
      generated_at: '2026-09-25T01:00:00Z',
      updated_at: '2026-09-25T01:00:00Z',
      edits: 2,
      edit_bytes: 90
    },
    {
      scope: 'project:0b8e6f2a-1111-4222-8333-444455556666',
      has_document: false,
      content_bytes: 0,
      revision: 0,
      source: null,
      generated_at: null,
      updated_at: null,
      edits: 1,
      edit_bytes: 30
    }
  ],
  documents: 1,
  edits: 3,
  total_bytes: 2168
}

const wrappers: VueWrapper[] = []

async function mountView() {
  const wrapper = mount(ClaudexMemoryView, {
    attachTo: document.body,
    global: {
      stubs: { teleport: true, Icon: true, TotpStepUpDialog: true, RouterLink: RouterLinkStub }
    }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

async function pickUser(wrapper: VueWrapper, user = { id: 123, email: 'a@example.com' }) {
  wrapper.findComponent(UserSearchSelect).vm.$emit('update:modelValue', user)
  await flushPromises()
}

function confirmDialog(wrapper: VueWrapper) {
  return wrapper.findComponent(ConfirmDialog)
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  listUsers.mockReset()
  stepUpRun.mockReset()
  toast.showSuccess.mockReset()
  toast.showError.mockReset()
  stepUpRun.mockImplementation((action: () => Promise<unknown>) => action())
  api.getStats.mockResolvedValue({ ...stats })
  api.getUser.mockResolvedValue(structuredClone(userMeta))
  api.clearUser.mockResolvedValue({ deleted_docs: 1, deleted_edits: 3 })
  listUsers.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 8, pages: 0 })
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

describe('ClaudexMemoryView', () => {
  it('shows the usage numbers and links to the memory policy', async () => {
    const wrapper = await mountView()
    expect(api.getStats).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="claudex-memory-stat-opted-in"]').text()).toContain('4')
    expect(wrapper.get('[data-testid="claudex-memory-stat-edits"]').text()).toContain('12')
    expect(wrapper.get('[data-testid="claudex-memory-stat-size"]').text()).toContain('20480 B')
    expect(wrapper.get('[data-testid="claudex-memory-stat-key"]').text()).toContain('admin.claudexMemory.stats.ready')
    expect(wrapper.find('[data-testid="claudex-memory-key-missing"]').exists()).toBe(false)
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toBe('/admin/claudex/policy')
    expect(wrapper.find('[data-testid="claudex-memory-user-pick"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="claudex-memory-clear"]').exists()).toBe(false)
  })

  it('warns when the server has no encryption key', async () => {
    api.getStats.mockResolvedValue({ ...stats, encryption_key_ready: false })
    const wrapper = await mountView()
    expect(wrapper.get('[data-testid="claudex-memory-key-missing"]').text()).toContain(
      'admin.claudexMemory.keyMissing.title'
    )
    expect(wrapper.get('[data-testid="claudex-memory-stat-key"]').text()).toContain(
      'admin.claudexMemory.stats.missing'
    )
  })

  it('says the page is not available on a server without the memory feature', async () => {
    api.getStats.mockRejectedValue({ status: 404, message: 'Not Found' })
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="claudex-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="claudex-memory-stats"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="claudex-memory-refresh"]').exists()).toBe(false)
  })

  it('shows a load error with retry', async () => {
    api.getStats.mockRejectedValueOnce({ status: 500, message: 'boom' })
    const wrapper = await mountView()
    expect(wrapper.get('[data-testid="claudex-page-load-error"]').text()).toContain('boom')
    await wrapper.get('[data-testid="claudex-page-load-error"] button').trigger('click')
    await flushPromises()
    expect(api.getStats).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="claudex-memory-stats"]').exists()).toBe(true)
  })

  it('shows one user’s switches and scope metadata', async () => {
    const wrapper = await mountView()
    await pickUser(wrapper)
    expect(api.getUser).toHaveBeenCalledWith(123)
    expect(wrapper.get('[data-testid="claudex-memory-pref-search"]').text()).toBe('admin.claudexMemory.user.on')
    expect(wrapper.get('[data-testid="claudex-memory-pref-generate"]').text()).toBe('admin.claudexMemory.user.off')
    const rows = wrapper.findAll('[data-testid="claudex-memory-scope-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('admin.claudexMemory.scope.global')
    expect(rows[0].text()).toContain('2048 B')
    expect(rows[0].text()).toContain('admin.claudexMemory.source.generated')
    expect(rows[0].text()).toContain('7')
    expect(rows[1].text()).toContain('admin.claudexMemory.scope.project{"id":"0b8e6f2a"}')
    expect(rows[1].text()).toContain('admin.claudexMemory.noDocument')
    expect(wrapper.get('[data-testid="claudex-memory-clear"]').attributes('disabled')).toBeUndefined()
  })

  it('shows unset switches as the policy default and disables clearing an empty memory', async () => {
    api.getUser.mockResolvedValue({
      user_id: 7,
      prefs: { set: false, search_chats: null, generate: null, updated_at: null },
      scopes: [],
      documents: 0,
      edits: 0,
      total_bytes: 0
    })
    const wrapper = await mountView()
    await pickUser(wrapper, { id: 7, email: '' })
    expect(wrapper.get('[data-testid="claudex-memory-pref-search"]').text()).toBe('admin.claudexMemory.user.notSet')
    expect(wrapper.get('[data-testid="claudex-memory-user-empty"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="claudex-memory-clear"]').attributes('disabled')).toBeDefined()
  })

  it('shows the page’s message for an unknown user', async () => {
    api.getUser.mockRejectedValue({ status: 404, reason: 'CLAUDEX_MEMORY_USER_NOT_FOUND', message: 'user not found' })
    const wrapper = await mountView()
    await pickUser(wrapper)
    expect(wrapper.get('[data-testid="claudex-memory-user-error"]').text()).toBe(
      'admin.claudexMemory.errors.CLAUDEX_MEMORY_USER_NOT_FOUND'
    )
    expect(wrapper.find('[data-testid="claudex-memory-scope-row"]').exists()).toBe(false)
  })

  it('confirms, then clears through step-up and reloads', async () => {
    const wrapper = await mountView()
    await pickUser(wrapper)
    await wrapper.get('[data-testid="claudex-memory-clear"]').trigger('click')
    await flushPromises()
    expect(api.clearUser).not.toHaveBeenCalled()
    expect(confirmDialog(wrapper).props('show')).toBe(true)
    expect(confirmDialog(wrapper).props('danger')).toBe(true)
    expect(confirmDialog(wrapper).props('message')).toContain('a@example.com')

    api.getUser.mockResolvedValue({ ...structuredClone(userMeta), scopes: [], documents: 0, edits: 0, total_bytes: 0 })
    confirmDialog(wrapper).vm.$emit('confirm')
    await flushPromises()

    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.clearUser).toHaveBeenCalledWith(123)
    expect(toast.showSuccess).toHaveBeenCalledWith('admin.claudexMemory.user.cleared{"documents":1,"edits":3}')
    expect(api.getUser).toHaveBeenCalledTimes(2)
    expect(api.getStats).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="claudex-memory-user-empty"]').exists()).toBe(true)
  })

  it('does nothing when the confirmation is declined', async () => {
    const wrapper = await mountView()
    await pickUser(wrapper)
    await wrapper.get('[data-testid="claudex-memory-clear"]').trigger('click')
    await flushPromises()
    confirmDialog(wrapper).vm.$emit('cancel')
    await flushPromises()
    expect(stepUpRun).not.toHaveBeenCalled()
    expect(api.clearUser).not.toHaveBeenCalled()
  })

  it('treats a cancelled step-up as no error', async () => {
    stepUpRun.mockRejectedValueOnce(new StepUpCancelledError())
    const wrapper = await mountView()
    await pickUser(wrapper)
    await wrapper.get('[data-testid="claudex-memory-clear"]').trigger('click')
    await flushPromises()
    confirmDialog(wrapper).vm.$emit('confirm')
    await flushPromises()
    expect(api.clearUser).not.toHaveBeenCalled()
    expect(toast.showError).not.toHaveBeenCalled()
    expect(toast.showSuccess).not.toHaveBeenCalled()
  })

  it('shows a failed clear', async () => {
    api.clearUser.mockRejectedValue({ status: 500, reason: 'CLAUDEX_MEMORY_STORE_FAILED', message: 'x' })
    const wrapper = await mountView()
    await pickUser(wrapper)
    await wrapper.get('[data-testid="claudex-memory-clear"]').trigger('click')
    await flushPromises()
    confirmDialog(wrapper).vm.$emit('confirm')
    await flushPromises()
    expect(toast.showError).toHaveBeenCalledWith('admin.claudexMemory.errors.CLAUDEX_MEMORY_STORE_FAILED')
  })

  it('never renders memory text even if a response carried some', async () => {
    const leaked = structuredClone(userMeta) as typeof userMeta & { scopes: Array<Record<string, unknown>> }
    leaked.scopes[0].content = 'SECRET MEMORY TEXT'
    api.getUser.mockResolvedValue(leaked)
    const wrapper = await mountView()
    await pickUser(wrapper)
    expect(wrapper.text()).not.toContain('SECRET MEMORY TEXT')
  })

  it('has its strings in both languages with the same keys', () => {
    const keys = (node: unknown, prefix = ''): string[] =>
      typeof node === 'object' && node
        ? Object.entries(node).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix]
    const page = (locale: typeof en) => (locale.admin as Record<string, unknown>).claudexMemory
    expect(keys(page(zh as typeof en)).sort()).toEqual(keys(page(en)).sort())
    expect(keys(page(en)).length).toBeGreaterThan(20)
  })
})

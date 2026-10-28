// CLAUDEX: tests for the diagnostics and reply feedback inboxes (K4).
import { defineComponent, h } from 'vue'
import { RouterLinkStub, flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DiagnosticsInbox from '../DiagnosticsInbox.vue'
import FeedbackInbox from '../FeedbackInbox.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { api, toast, copyToClipboard } = vi.hoisted(() => ({
  api: {
    listDiagnostics: vi.fn(),
    getDiagnostic: vi.fn(),
    deleteDiagnostic: vi.fn(),
    listFeedback: vi.fn(),
    getFeedback: vi.fn(),
    deleteFeedback: vi.fn()
  },
  toast: { showSuccess: vi.fn(), showError: vi.fn() },
  copyToClipboard: vi.fn()
}))

vi.mock('@/api/admin/claudex/feedback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin/claudex/feedback')>()),
  ...api
}))
vi.mock('@/stores/app', () => ({ useAppStore: () => toast }))
vi.mock('@/composables/useClipboard', () => ({ useClipboard: () => ({ copyToClipboard }) }))

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: (key: string) => key.startsWith('admin.claudexFeedback.kinds.gateway_refusal')
  })
}))

vi.mock('@/components/icons/Icon.vue', () => ({
  default: defineComponent({ name: 'Icon', setup: () => () => h('i') })
}))

const report = {
  id: 11,
  report_uuid: '8a0f7c1e-0000-4000-8000-000000000001',
  user_id: 7,
  user_email: 'ann@example.com',
  device_id: 3,
  kind: 'gateway_refusal',
  code: 'USAGE_LIMIT_EXCEEDED',
  message: '',
  request_id: 'req_01H',
  model: 'gpt-5.5',
  app_version: '1.3.2',
  codex_version: '0.144.1',
  platform: 'darwin',
  arch: 'arm64',
  os_version: 'macOS 26.1',
  context: { surface: 'code', reason: 'SUBSCRIPTION_WEEKLY_LIMIT', http_status: 429 },
  occurred_at: '2026-09-26T02:00:00Z',
  created_at: '2026-09-26T02:00:05Z'
}

const feedback = {
  id: 21,
  feedback_uuid: 'c1d2e3f4-0000-4000-8000-000000000002',
  user_id: 8,
  user_email: null,
  rating: 'down' as const,
  categories: ['inaccurate', 'not_helpful'],
  comment: 'The table was wrong.',
  model: 'gpt-5.5',
  request_id: 'req_02H',
  conversation_excerpt: null,
  app_version: '1.3.2',
  platform: 'win32',
  created_at: '2026-09-26T03:00:00Z'
}

function page<T>(items: T[]) {
  return { items, total: items.length, page: 1, page_size: 20, pages: 1 }
}

const global = { stubs: { RouterLink: RouterLinkStub, teleport: true } }

describe('DiagnosticsInbox', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    toast.showSuccess.mockReset()
    toast.showError.mockReset()
  })

  it('lists reports and sends the filters', async () => {
    api.listDiagnostics.mockResolvedValue(page([report]))
    const wrapper = mount(DiagnosticsInbox, { global })
    await flushPromises()
    expect(wrapper.text()).toContain('USAGE_LIMIT_EXCEEDED')
    expect(wrapper.text()).toContain('ann@example.com')
    expect(wrapper.text()).toContain('admin.claudexFeedback.kinds.gateway_refusal')

    await wrapper.get('[data-testid="claudex-diag-filter-user"]').setValue('7')
    await wrapper.get('[data-testid="claudex-diag-filter-kind"]').setValue('crash')
    await wrapper.get('[data-testid="claudex-diag-filter-code"]').setValue(' USAGE_LIMIT_EXCEEDED ')
    await wrapper.get('[data-testid="claudex-diag-filter-version"]').setValue('1.3.2')
    await wrapper.get('[data-testid="claudex-diag-filter-from"]').setValue('2026-09-20')
    await wrapper.get('[data-testid="claudex-diagnostics-filters"]').trigger('submit')
    await flushPromises()
    const query = api.listDiagnostics.mock.calls.at(-1)?.[0]
    expect(query).toMatchObject({
      user_id: 7,
      kind: 'crash',
      code: 'USAGE_LIMIT_EXCEEDED',
      app_version: '1.3.2',
      page: 1,
      page_size: 20
    })
    expect(new Date(query.from).getTime()).toBe(new Date(2026, 8, 20).getTime())
    expect(query).not.toHaveProperty('to')
  })

  it('opens the details from the server with the request ID linked to Ops', async () => {
    api.listDiagnostics.mockResolvedValue(page([report]))
    api.getDiagnostic.mockResolvedValue(report)
    const wrapper = mount(DiagnosticsInbox, { global })
    await flushPromises()
    await wrapper.get('[data-testid="claudex-diag-view-11"]').trigger('click')
    await flushPromises()

    expect(api.getDiagnostic).toHaveBeenCalledWith(11)
    const detail = wrapper.get('[data-testid="claudex-diagnostic-detail"]')
    expect(detail.text()).toContain('macOS 26.1')
    expect(detail.text()).toContain('0.144.1')
    expect(wrapper.get('[data-testid="claudex-diagnostic-context"]').text()).toContain('reason: SUBSCRIPTION_WEEKLY_LIMIT')
    expect(wrapper.get('[data-testid="claudex-request-id"]').text()).toContain('req_01H')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/admin/ops')
    await wrapper.get('[data-testid="claudex-request-id-copy"]').trigger('click')
    expect(copyToClipboard).toHaveBeenCalledWith('req_01H', 'admin.claudexFeedback.requestId.copied')

    await wrapper.get('[data-testid="claudex-detail-drawer-close"]').trigger('click')
    expect(wrapper.find('[data-testid="claudex-diagnostic-detail"]').exists()).toBe(false)
  })

  it('deletes a report after confirmation and reloads the list', async () => {
    api.listDiagnostics.mockResolvedValueOnce(page([report])).mockResolvedValueOnce(page([]))
    api.deleteDiagnostic.mockResolvedValue(undefined)
    const wrapper = mount(DiagnosticsInbox, { global })
    await flushPromises()
    await wrapper.get('[data-testid="claudex-diag-delete-11"]').trigger('click')
    expect(api.deleteDiagnostic).not.toHaveBeenCalled()

    wrapper.getComponent(ConfirmDialog).vm.$emit('confirm')
    await flushPromises()
    expect(api.deleteDiagnostic).toHaveBeenCalledWith(11)
    expect(toast.showSuccess).toHaveBeenCalledWith('admin.claudexFeedback.diagnostics.deleted')
    expect(api.listDiagnostics).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="claudex-diagnostics-empty"]').exists()).toBe(true)
  })

  it('drops a report that someone else already deleted', async () => {
    api.listDiagnostics.mockResolvedValueOnce(page([report])).mockResolvedValueOnce(page([]))
    api.deleteDiagnostic.mockRejectedValue({ status: 404, reason: 'CLAUDEX_REPORT_NOT_FOUND', message: 'gone' })
    const wrapper = mount(DiagnosticsInbox, { global })
    await flushPromises()
    await wrapper.get('[data-testid="claudex-diag-delete-11"]').trigger('click')
    wrapper.getComponent(ConfirmDialog).vm.$emit('confirm')
    await flushPromises()
    expect(toast.showError).toHaveBeenCalledWith('gone')
    expect(api.listDiagnostics).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="claudex-diagnostics-empty"]').exists()).toBe(true)
  })

  it('does nothing when the deletion is cancelled', async () => {
    api.listDiagnostics.mockResolvedValue(page([report]))
    const wrapper = mount(DiagnosticsInbox, { global })
    await flushPromises()
    await wrapper.get('[data-testid="claudex-diag-delete-11"]').trigger('click')
    wrapper.getComponent(ConfirmDialog).vm.$emit('cancel')
    await flushPromises()
    expect(api.deleteDiagnostic).not.toHaveBeenCalled()
  })

  it('shows a list error', async () => {
    api.listDiagnostics.mockRejectedValue({ status: 500, message: 'boom' })
    const wrapper = mount(DiagnosticsInbox, { global })
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-diagnostics-error"]').text()).toBe('boom')
  })
})

describe('FeedbackInbox', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    toast.showSuccess.mockReset()
    toast.showError.mockReset()
  })

  it('lists feedback and filters by rating and user', async () => {
    api.listFeedback.mockResolvedValue(page([feedback]))
    const wrapper = mount(FeedbackInbox, { global })
    await flushPromises()
    expect(wrapper.text()).toContain('admin.claudexFeedback.ratings.down')
    expect(wrapper.text()).toContain('inaccurate, not_helpful')
    expect(wrapper.text()).toContain('#8')

    await wrapper.get('[data-testid="claudex-fb-filter-rating"]').setValue('down')
    await wrapper.get('[data-testid="claudex-fb-filter-user"]').setValue('8')
    await wrapper.get('[data-testid="claudex-fb-filter-to"]').setValue('2026-09-26')
    await wrapper.get('[data-testid="claudex-feedback-filters"]').trigger('submit')
    await flushPromises()
    const query = api.listFeedback.mock.calls.at(-1)?.[0]
    expect(query).toMatchObject({ rating: 'down', user_id: 8, page: 1, page_size: 20 })
    expect(new Date(query.to).getTime()).toBe(new Date(2026, 8, 27).getTime())
  })

  it('shows the comment and says when no conversation was included', async () => {
    api.listFeedback.mockResolvedValue(page([feedback]))
    api.getFeedback.mockResolvedValue(feedback)
    const wrapper = mount(FeedbackInbox, { global })
    await flushPromises()
    await wrapper.get('[data-testid="claudex-fb-view-21"]').trigger('click')
    await flushPromises()
    expect(api.getFeedback).toHaveBeenCalledWith(21)
    expect(wrapper.get('[data-testid="claudex-feedback-detail-comment"]').text()).toBe('The table was wrong.')
    expect(wrapper.get('[data-testid="claudex-feedback-detail-no-excerpt"]').text()).toBe('admin.claudexFeedback.feedback.noExcerpt')
    expect(wrapper.find('[data-testid="claudex-feedback-detail-excerpt"]').exists()).toBe(false)
  })

  it('shows an included conversation excerpt as text', async () => {
    const withExcerpt = { ...feedback, conversation_excerpt: 'User: <b>hi</b>\nAssistant: hello' }
    api.listFeedback.mockResolvedValue(page([withExcerpt]))
    api.getFeedback.mockResolvedValue(withExcerpt)
    const wrapper = mount(FeedbackInbox, { global })
    await flushPromises()
    await wrapper.get('[data-testid="claudex-fb-view-21"]').trigger('click')
    await flushPromises()
    const excerpt = wrapper.get('[data-testid="claudex-feedback-detail-excerpt"]')
    expect(excerpt.text()).toContain('User: <b>hi</b>')
    expect(excerpt.find('b').exists()).toBe(false)
  })

  it('deletes from the details drawer and closes it', async () => {
    api.listFeedback.mockResolvedValue(page([feedback]))
    api.getFeedback.mockResolvedValue(feedback)
    api.deleteFeedback.mockResolvedValue(undefined)
    const wrapper = mount(FeedbackInbox, { global })
    await flushPromises()
    await wrapper.get('[data-testid="claudex-fb-view-21"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="claudex-feedback-detail-delete"]').trigger('click')
    wrapper.getComponent(ConfirmDialog).vm.$emit('confirm')
    await flushPromises()
    expect(api.deleteFeedback).toHaveBeenCalledWith(21)
    expect(wrapper.find('[data-testid="claudex-feedback-detail"]').exists()).toBe(false)
  })

  it('reports a failed deletion', async () => {
    api.listFeedback.mockResolvedValue(page([feedback]))
    api.deleteFeedback.mockRejectedValue({ status: 404, message: 'not found' })
    const wrapper = mount(FeedbackInbox, { global })
    await flushPromises()
    await wrapper.get('[data-testid="claudex-fb-delete-21"]').trigger('click')
    wrapper.getComponent(ConfirmDialog).vm.$emit('confirm')
    await flushPromises()
    expect(toast.showError).toHaveBeenCalledWith('not found')
  })
})

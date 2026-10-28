// CLAUDEX: tests for the Claudex console Sharing page (R1-K).
import { defineComponent, h } from 'vue'
import { RouterLinkStub, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ClaudexSharingView from '../ClaudexSharingView.vue'
import type { StepUpController } from '@/composables/useStepUp'
import {
  parseBaseUrl,
  reasonLength,
  sharingFormFromSettings,
  sharingSettingsFromForm,
  shareLink,
  validateSharingForm
} from '@/api/admin/claudex/sharing'

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listShares: vi.fn(),
  getShare: vi.fn(),
  getShareContent: vi.fn(),
  getSharePreview: vi.fn(),
  disableShare: vi.fn(),
  enableShare: vi.fn(),
  deleteShare: vi.fn(),
  listReports: vi.fn(),
  resolveReport: vi.fn(),
  listArtifactReports: vi.fn(),
  getArtifactReport: vi.fn(),
  resolveArtifactReport: vi.fn(),
  listBlocks: vi.fn(),
  blockUser: vi.fn(),
  unblockUser: vi.fn(),
  disableAllOfUser: vi.fn()
}))

vi.mock('@/api/admin/claudex/sharing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin/claudex/sharing')>()),
  ...api
}))

const toast = vi.hoisted(() => ({ showSuccess: vi.fn(), showError: vi.fn() }))
vi.mock('@/stores/app', () => ({ useAppStore: () => toast }))

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
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

const DEFAULTS = {
  enabled: false,
  conversations: true,
  artifacts: true,
  public_base_url: '',
  content_base_url: '',
  usage_policy_url: '',
  max_snapshot_bytes: 8 << 20,
  max_artifact_bytes: 2 << 20,
  max_active_per_user: 200,
  default_ttl_days: 0,
  allow_reports: true
}

const EFFECTIVE = {
  public_base_url: '',
  public_base_url_source: 'none',
  usage_policy_url: '',
  usage_policy_path: '',
  storage_available: true
}

const empty = { items: [], total: 0, page: 1, page_size: 20, pages: 0 }

function share(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    kind: 'conversation',
    source_key: 'abc',
    title: 'Trip plan',
    status: 'active',
    disabled_reason: '',
    path: '/s/tok7',
    url: 'https://share.example.com/s/tok7',
    created_at: '2026-09-26T10:00:00Z',
    snapshot_at: '2026-09-26T10:00:00Z',
    updated_at: '2026-09-26T10:00:00Z',
    expires_at: null,
    view_count: 12,
    content_bytes: 2048,
    user_id: 42,
    user_email: 'ann@example.com',
    open_reports: 1,
    disabled_by: null,
    disabled_at: null,
    last_viewed_at: null,
    expired: false,
    ...overrides
  }
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    share_id: 7,
    share_title: 'Trip plan',
    share_kind: 'conversation',
    share_status: 'active',
    share_user_id: 42,
    share_path: '/s/tok7',
    share_url: '',
    reason: 'privacy',
    detail: 'Has my phone number',
    status: 'open',
    created_at: '2026-09-26T11:00:00Z',
    resolved_at: null,
    resolved_by: null,
    ...overrides
  }
}

function artifactReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    user_id: 42,
    user_email: 'ann@example.com',
    title: 'Landing page',
    language: 'html',
    content_bytes: 2048,
    content_truncated: false,
    reason: 'other',
    category: 'violation_of_terms',
    notes: 'Phishing form',
    reporter_name: 'Ann',
    reporter_email: '',
    opt_out_of_training: false,
    status: 'open',
    created_at: '2026-10-12T11:00:00Z',
    resolved_at: null,
    resolved_by: null,
    ...overrides
  }
}

function mountView() {
  return mount(ClaudexSharingView, {
    global: { stubs: { Icon: true, RouterLink: RouterLinkStub, teleport: true } }
  })
}

async function loaded(
  settings: unknown = DEFAULTS,
  effective: Record<string, unknown> = EFFECTIVE,
  shares: unknown[] = [share()]
) {
  api.getSettings.mockResolvedValue({ settings, effective })
  api.listShares.mockResolvedValue({ ...empty, items: shares, total: shares.length })
  api.listReports.mockResolvedValue({ ...empty, items: [report()], total: 1 })
  api.listArtifactReports.mockResolvedValue({ ...empty, items: [artifactReport()], total: 1 })
  api.listBlocks.mockResolvedValue(empty)
  const wrapper = mountView()
  await flushPromises()
  return wrapper
}

function stepUpOf(wrapper: VueWrapper): StepUpController {
  return wrapper.findComponent({ name: 'TotpStepUpDialog' }).props('controller') as StepUpController
}

async function confirmDialog(wrapper: VueWrapper, confirmKey: string) {
  const button = wrapper
    .findAllComponents({ name: 'ConfirmDialog' })[0]
    .findAll('button')
    .find((b) => b.text() === confirmKey)
  expect(button, `confirm button ${confirmKey}`).toBeTruthy()
  await button!.trigger('click')
  await flushPromises()
}

describe('ClaudexSharingView', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    toast.showSuccess.mockReset()
    toast.showError.mockReset()
  })

  it('shows sharing off by default and loads the shared links', async () => {
    const wrapper = await loaded()
    expect(wrapper.get('[data-testid="claudex-sharing-enabled"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.get('[data-testid="claudex-sharing-state-note"]').text()).toContain('admin.claudexSharing.offNote')
    expect(wrapper.get('[data-testid="claudex-sharing-effective-base"]').text()).toContain(
      'admin.claudexSharing.links.sources.none'
    )
    expect(wrapper.get('[data-testid="claudex-sharing-effective-policy"]').text()).toContain(
      'admin.claudexSharing.links.noPolicy'
    )
    expect(api.listShares).toHaveBeenCalledWith({ page: 1, page_size: 20 })
    expect(api.listReports).toHaveBeenCalledWith({ status: 'open', page: 1, page_size: 1 })
    expect(wrapper.get('[data-testid="claudex-sharing-open-reports"]').text()).toBe('1')
    const row = wrapper.get('[data-testid="claudex-share-row-7"]')
    expect(row.text()).toContain('Trip plan')
    expect(wrapper.get('[data-testid="claudex-share-open-7"]').attributes('href')).toBe('https://share.example.com/s/tok7')
    expect(wrapper.get('[data-testid="claudex-share-open-7"]').attributes('rel')).toBe('noopener noreferrer')
  })

  it('treats a missing or partial setting as off with the server defaults', async () => {
    const wrapper = await loaded({})
    expect(wrapper.get('[data-testid="claudex-sharing-enabled"]').attributes('aria-checked')).toBe('false')
    expect((wrapper.get('[data-testid="claudex-sharing-max_snapshot_bytes"]').element as HTMLInputElement).value).toBe('8192')
    expect(wrapper.find('[data-testid="claudex-save-status"]').exists()).toBe(false)
  })

  it('hides the moderation lists when the server has no storage for shares', async () => {
    const wrapper = await loaded(DEFAULTS, { ...EFFECTIVE, storage_available: false })
    expect(wrapper.find('[data-testid="claudex-sharing-storage-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="claudex-sharing-moderation"]').exists()).toBe(false)
    expect(api.listShares).not.toHaveBeenCalled()
  })

  it('says the page is not in this build when the server has no such endpoint', async () => {
    api.getSettings.mockRejectedValue({ status: 404 })
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-unavailable"]').exists()).toBe(true)
    expect(api.listShares).not.toHaveBeenCalled()
  })

  it('turns sharing on only through step-up and sends sizes in bytes', async () => {
    const wrapper = await loaded()
    api.updateSettings.mockRejectedValueOnce({ status: 403, reason: 'STEP_UP_REQUIRED' }).mockImplementationOnce(async (body) => ({
      settings: body,
      effective: { ...EFFECTIVE, public_base_url: body.public_base_url, public_base_url_source: 'setting' }
    }))
    await wrapper.get('[data-testid="claudex-sharing-enabled"]').trigger('click')
    await wrapper.get('[data-testid="claudex-sharing-public_base_url"]').setValue(' https://share.example.com/ ')
    await wrapper.get('[data-testid="claudex-sharing-max_artifact_bytes"]').setValue('512')
    await wrapper.get('[data-testid="claudex-sharing-default_ttl_days"]').setValue('30')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()

    const stepUp = stepUpOf(wrapper)
    expect(stepUp.visible.value).toBe(true)
    stepUp.onVerified()
    await flushPromises()

    expect(api.updateSettings).toHaveBeenCalledTimes(2)
    expect(api.updateSettings).toHaveBeenLastCalledWith({
      ...DEFAULTS,
      enabled: true,
      public_base_url: 'https://share.example.com',
      max_artifact_bytes: 512 * 1024,
      default_ttl_days: 30
    })
    expect(wrapper.get('[data-testid="claudex-sharing-state-note"]').text()).toContain('admin.claudexSharing.onNote')
    expect(wrapper.get('[data-testid="claudex-sharing-effective-base"]').text()).toContain('https://share.example.com')
  })

  it('keeps sharing off when the step-up prompt is cancelled', async () => {
    const wrapper = await loaded()
    api.updateSettings.mockRejectedValue({ status: 403, reason: 'STEP_UP_REQUIRED' })
    await wrapper.get('[data-testid="claudex-sharing-enabled"]').trigger('click')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    stepUpOf(wrapper).onCancel()
    await flushPromises()
    expect(api.updateSettings).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="claudex-sharing-state-note"]').text()).toContain('admin.claudexSharing.offNote')
    expect(wrapper.find('[data-testid="claudex-save-error"]').exists()).toBe(false)
  })

  it('checks the addresses and limits before saving', async () => {
    const wrapper = await loaded()
    await wrapper.get('[data-testid="claudex-sharing-content_base_url"]').setValue('https://content.example.net')
    await wrapper.get('[data-testid="claudex-sharing-usage_policy_url"]').setValue('http://policy.example.com')
    await wrapper.get('[data-testid="claudex-sharing-max_snapshot_bytes"]').setValue('10')
    await wrapper.get('[data-testid="claudex-sharing-max_active_per_user"]').setValue('0')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    expect(api.updateSettings).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe('admin.claudexSharing.fixProblems')
    expect(wrapper.get('[data-testid="claudex-sharing-content_base_url-error"]').text()).toBe(
      'admin.claudexSharing.problems.requiresPublicBase'
    )
    expect(wrapper.get('[data-testid="claudex-sharing-usage_policy_url-error"]').text()).toBe(
      'admin.claudexSharing.problems.httpsUrl'
    )
    expect(wrapper.get('[data-testid="claudex-sharing-max_snapshot_bytes-error"]').text()).toBe(
      'admin.claudexSharing.problems.snapshotSize'
    )
    expect(wrapper.get('[data-testid="claudex-sharing-max_active_per_user-error"]').text()).toBe(
      'admin.claudexSharing.problems.activePerUser'
    )
  })

  it('shows a field the server refused under that field', async () => {
    const wrapper = await loaded()
    api.updateSettings.mockRejectedValue({
      status: 400,
      reason: 'CLAUDEX_SETTING_INVALID',
      message: 'content_base_url must use a different host than public_base_url.',
      metadata: { field: 'content_base_url', rule: 'same_host' }
    })
    await wrapper.get('[data-testid="claudex-sharing-enabled"]').trigger('click')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-sharing-content_base_url-error"]').text()).toContain('different host')
  })

  it('takes a link down with a reason after confirmation and step-up', async () => {
    const wrapper = await loaded()
    api.disableShare.mockResolvedValue(share({ status: 'disabled' }))
    await wrapper.get('[data-testid="claudex-share-takedown-7"]').trigger('click')
    await wrapper.get('[data-testid="claudex-sharing-reason-input"]').setValue('  Personal data  ')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.takeDown')
    expect(api.disableShare).toHaveBeenCalledWith(7, 'Personal data')
    expect(toast.showSuccess).toHaveBeenCalledWith('admin.claudexSharing.toasts.takenDown')
    expect(api.listShares).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the confirmation is cancelled', async () => {
    const wrapper = await loaded()
    await wrapper.get('[data-testid="claudex-share-delete-7"]').trigger('click')
    const cancel = wrapper
      .findAllComponents({ name: 'ConfirmDialog' })[0]
      .findAll('button')
      .find((b) => b.text() === 'common.cancel')
    await cancel!.trigger('click')
    await flushPromises()
    expect(api.deleteShare).not.toHaveBeenCalled()
  })

  it('does not send a reason over 500 characters', async () => {
    const wrapper = await loaded()
    await wrapper.get('[data-testid="claudex-share-takedown-7"]').trigger('click')
    await wrapper.get('[data-testid="claudex-sharing-reason-input"]').setValue('x'.repeat(501))
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.takeDown')
    expect(api.disableShare).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('admin.claudexSharing.reason.tooLong')
  })

  it('restores and deletes links, and offers no actions on deleted ones', async () => {
    const wrapper = await loaded(DEFAULTS, EFFECTIVE, [
      share({ id: 8, status: 'disabled', disabled_reason: 'spam' }),
      share({ id: 9, status: 'revoked' })
    ])
    expect(wrapper.get('[data-testid="claudex-share-row-8"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('admin.claudexSharing.shares.takenDownReason{"reason":"spam"}')
    expect(wrapper.find('[data-testid="claudex-share-open-9"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="claudex-share-delete-9"]').exists()).toBe(false)

    api.enableShare.mockResolvedValue(share({ id: 8 }))
    await wrapper.get('[data-testid="claudex-share-restore-8"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.restore')
    expect(api.enableShare).toHaveBeenCalledWith(8)

    api.deleteShare.mockResolvedValue({ deleted: true })
    await wrapper.get('[data-testid="claudex-share-delete-8"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.delete')
    expect(api.deleteShare).toHaveBeenCalledWith(8)
  })

  it('reports a failed action without claiming success', async () => {
    const wrapper = await loaded()
    api.deleteShare.mockRejectedValue({ status: 404, reason: 'CLAUDEX_SHARE_NOT_FOUND', message: 'gone' })
    await wrapper.get('[data-testid="claudex-share-delete-7"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.delete')
    expect(toast.showSuccess).not.toHaveBeenCalled()
    expect(toast.showError).toHaveBeenCalledWith('gone')
  })

  it('shows the snapshot as plain text for review', async () => {
    const wrapper = await loaded()
    api.getShareContent.mockResolvedValue({
      id: 7,
      schema: 1,
      snapshot: {
        kind: 'conversation',
        title: 'Trip plan',
        mode: 'chat',
        messages: [
          { role: 'user', text: 'Plan a trip <img src=x onerror=alert(1)>' },
          { role: 'assistant', text: 'Here is a plan.', activity: ['Searched the web'], artifacts: [0] }
        ],
        artifacts: [{ title: 'Itinerary', language: 'html', content: '<script>alert(1)</script>' }]
      }
    })
    await wrapper.get('[data-testid="claudex-share-review-7"]').trigger('click')
    await flushPromises()
    expect(api.getShareContent).toHaveBeenCalledWith(7)
    const panel = wrapper.get('[data-testid="claudex-sharing-content"]')
    expect(panel.findAll('[data-testid="claudex-sharing-content-message"]')).toHaveLength(2)
    expect(panel.text()).toContain('<img src=x onerror=alert(1)>')
    expect(panel.find('img').exists()).toBe(false)
    expect(panel.find('script').exists()).toBe(false)
    expect(panel.get('[data-testid="claudex-sharing-content-artifact"]').text()).toContain('<script>alert(1)</script>')
    expect(panel.text()).toContain('Searched the web')
  })

  it('shows an app report\'s category, reporter and training opt-out', async () => {
    const wrapper = await loaded()
    api.listReports.mockResolvedValue({
      ...empty,
      items: [
        report({
          id: 4,
          reason: 'other',
          category: 'violation_of_terms',
          reporter_name: 'Ann',
          reporter_email: 'ann@example.com',
          reporter_user_id: 8,
          opt_out_of_training: true
        })
      ],
      total: 1
    })
    await wrapper.get('[data-testid="claudex-sharing-tab-reports"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-report-category-4"]').text()).toBe(
      'admin.claudexSharing.reports.categories.violation_of_terms'
    )
    expect(wrapper.get('[data-testid="claudex-report-reporter-4"]').text()).toContain('admin.claudexSharing.reports.reporter')
    expect(wrapper.get('[data-testid="claudex-report-opt-out-4"]').text()).toBe('admin.claudexSharing.reports.optedOut')
  })

  it('dismisses a report or takes the reported link down', async () => {
    const wrapper = await loaded()
    await wrapper.get('[data-testid="claudex-sharing-tab-reports"]').trigger('click')
    await flushPromises()
    expect(api.listReports).toHaveBeenLastCalledWith({ status: 'open', page: 1, page_size: 20 })
    const row = wrapper.get('[data-testid="claudex-report-row-3"]')
    expect(row.text()).toContain('Trip plan')
    expect(wrapper.text()).toContain('admin.claudexSharing.reports.reasons.privacy')
    expect(wrapper.text()).toContain('Has my phone number')
    // A public-page report has no reporter and may be used for training.
    expect(wrapper.find('[data-testid="claudex-report-reporter-3"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="claudex-report-opt-out-3"]').exists()).toBe(false)

    api.resolveReport.mockResolvedValue(report({ status: 'dismissed' }))
    await wrapper.get('[data-testid="claudex-report-dismiss-3"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.dismiss')
    expect(api.resolveReport).toHaveBeenLastCalledWith(3, 'dismiss')

    await wrapper.get('[data-testid="claudex-report-takedown-3"]').trigger('click')
    await wrapper.get('[data-testid="claudex-sharing-reason-input"]').setValue('Private data')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.takeDown')
    expect(api.resolveReport).toHaveBeenLastCalledWith(3, 'disable', 'Private data')
  })

  it('lists artifact reports, shows the copy as text, and dismisses or resolves them', async () => {
    const wrapper = await loaded()
    expect(api.listArtifactReports).toHaveBeenCalledWith({ status: 'open', page: 1, page_size: 1 })
    expect(wrapper.get('[data-testid="claudex-sharing-open-artifact-reports"]').text()).toBe('1')
    await wrapper.get('[data-testid="claudex-sharing-tab-artifactReports"]').trigger('click')
    await flushPromises()
    expect(api.listArtifactReports).toHaveBeenLastCalledWith({ status: 'open', page: 1, page_size: 20 })
    const row = wrapper.get('[data-testid="claudex-artifact-report-row-9"]')
    expect(row.text()).toContain('Landing page')
    expect(row.text()).toContain('ann@example.com (#42)')
    expect(wrapper.text()).toContain('admin.claudexSharing.reports.categories.violation_of_terms')
    expect(wrapper.text()).toContain('Phishing form')
    expect(wrapper.get('[data-testid="claudex-artifact-report-reporter-9"]').text()).toContain(
      'admin.claudexSharing.reports.reporter'
    )

    api.getArtifactReport.mockResolvedValue({
      ...artifactReport({ content_truncated: true, content_bytes: 900000 }),
      content: '<form><script>steal()</script></form>'
    })
    await wrapper.get('[data-testid="claudex-artifact-report-review-9"]').trigger('click')
    await flushPromises()
    expect(api.getArtifactReport).toHaveBeenCalledWith(9)
    const copy = wrapper.get('[data-testid="claudex-artifact-report-copy"]')
    expect(copy.get('pre').text()).toBe('<form><script>steal()</script></form>')
    expect(copy.find('script').exists()).toBe(false)
    expect(copy.get('[data-testid="claudex-artifact-report-copy-cut"]').text()).toContain(
      'admin.claudexSharing.artifactReports.copyCut'
    )

    api.resolveArtifactReport.mockResolvedValue(artifactReport({ status: 'dismissed' }))
    await wrapper.get('[data-testid="claudex-artifact-report-dismiss-9"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.dismiss')
    expect(api.resolveArtifactReport).toHaveBeenLastCalledWith(9, 'dismiss')

    await wrapper.get('[data-testid="claudex-artifact-report-resolve-9"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.resolve')
    expect(api.resolveArtifactReport).toHaveBeenLastCalledWith(9, 'resolve')
    expect(toast.showSuccess).toHaveBeenLastCalledWith('admin.claudexSharing.toasts.resolved')
  })

  it('blocks a user, then unblocks or takes down all their links', async () => {
    const wrapper = await loaded()
    api.listBlocks.mockResolvedValue({
      ...empty,
      items: [{ user_id: 42, user_email: 'ann@example.com', reason: 'abuse', created_by: 1, created_at: '2026-09-26T12:00:00Z' }],
      total: 1
    })
    await wrapper.get('[data-testid="claudex-sharing-tab-blocks"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-block-row-42"]').text()).toContain('ann@example.com')

    expect(wrapper.get('[data-testid="claudex-block-submit"]').attributes('disabled')).toBeDefined()
    api.blockUser.mockResolvedValue({ user_id: 5, user_email: '', reason: '', created_by: 1, created_at: '' })
    await wrapper.get('[data-testid="claudex-block-user"]').setValue('5')
    await wrapper.get('[data-testid="claudex-sharing-block-form"]').trigger('submit')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.block')
    expect(api.blockUser).toHaveBeenCalledWith(5, '')

    api.disableAllOfUser.mockResolvedValue({ disabled: 3 })
    await wrapper.get('[data-testid="claudex-block-takedown-all-42"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.takeDownAll')
    expect(api.disableAllOfUser).toHaveBeenCalledWith(42, '')
    expect(toast.showSuccess).toHaveBeenLastCalledWith('admin.claudexSharing.toasts.takenDownAll{"count":3}')

    api.unblockUser.mockResolvedValue({ deleted: true })
    await wrapper.get('[data-testid="claudex-block-remove-42"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.unblock')
    expect(api.unblockUser).toHaveBeenCalledWith(42)
  })

  it('blocks the author of a shared link from its row', async () => {
    const wrapper = await loaded()
    api.blockUser.mockResolvedValue({ user_id: 42 })
    await wrapper.get('[data-testid="claudex-share-block-7"]').trigger('click')
    await wrapper.get('[data-testid="claudex-sharing-reason-input"]').setValue('Repeated spam')
    await confirmDialog(wrapper, 'admin.claudexSharing.actions.block')
    expect(api.blockUser).toHaveBeenCalledWith(42, 'Repeated spam')
  })
})

describe('sharing settings form helpers', () => {
  it('converts between bytes and KiB', () => {
    const form = sharingFormFromSettings({ max_snapshot_bytes: 1 << 20, max_artifact_bytes: 64 << 10 })
    expect(form.maxSnapshotKiB).toBe(1024)
    expect(form.maxArtifactKiB).toBe(64)
    const body = sharingSettingsFromForm({ ...form, publicBaseUrl: 'https://a.example.com///' })
    expect(body.max_snapshot_bytes).toBe(1 << 20)
    expect(body.public_base_url).toBe('https://a.example.com')
    expect(body.enabled).toBe(false)
  })

  it('accepts the same base addresses as the server', () => {
    expect(parseBaseUrl('https://share.example.com/prefix')).toBe('share.example.com')
    expect(parseBaseUrl('http://127.0.0.1:8080')).toBe('127.0.0.1')
    expect(parseBaseUrl('http://localhost:3000')).toBe('localhost')
    expect(parseBaseUrl('http://share.example.com')).toBeNull()
    expect(parseBaseUrl('https://share.example.com/?a=1')).toBeNull()
    expect(parseBaseUrl('https://share.example.com/#x')).toBeNull()
    expect(parseBaseUrl('https://user:pw@share.example.com')).toBeNull()
    expect(parseBaseUrl('ftp://share.example.com')).toBeNull()
    expect(parseBaseUrl('https://share .example.com')).toBeNull()
  })

  it('needs a public address on another host for a content address', () => {
    const base = sharingFormFromSettings(null)
    expect(validateSharingForm({ ...base, contentBaseUrl: 'https://c.example.net' }).content_base_url).toBe(
      'requiresPublicBase'
    )
    expect(
      validateSharingForm({ ...base, publicBaseUrl: 'https://s.example.com', contentBaseUrl: 'https://S.example.com/x' })
        .content_base_url
    ).toBe('sameHost')
    expect(
      validateSharingForm({ ...base, publicBaseUrl: 'https://s.example.com', contentBaseUrl: 'https://c.example.net' })
    ).toEqual({})
  })

  it('keeps an artifact no larger than a conversation', () => {
    const base = sharingFormFromSettings(null)
    expect(validateSharingForm({ ...base, maxSnapshotKiB: 128, maxArtifactKiB: 256 }).max_artifact_bytes).toBe('artifactSize')
    expect(validateSharingForm({ ...base, maxSnapshotKiB: 128, maxArtifactKiB: 128 })).toEqual({})
    expect(validateSharingForm({ ...base, defaultTtlDays: 3651 }).default_ttl_days).toBe('ttlDays')
    expect(validateSharingForm({ ...base, defaultTtlDays: 1.5 }).default_ttl_days).toBe('ttlDays')
  })

  it('opens a path on the console host when links are paths', () => {
    expect(shareLink('', '/s/abc', 'https://console.example.com/')).toBe('https://console.example.com/s/abc')
    expect(shareLink('https://share.example.com/s/abc', '/s/abc', 'https://x')).toBe('https://share.example.com/s/abc')
    expect(shareLink('', '', 'https://x')).toBe('')
  })

  it('counts a reason the way the server does', () => {
    expect(reasonLength('  spam  ')).toBe(4)
    expect(reasonLength('a\n\n\tb')).toBe(3)
    expect(reasonLength('\u{1F600}'.repeat(500))).toBe(500)
  })
})

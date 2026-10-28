// CLAUDEX W-ADMIN1: tests for the Web app console page: access setting, run
// limits and runners (add with a one-time token, rename, switch off, drain,
// revoke).
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ClaudexWebView from '../ClaudexWebView.vue'
import type { StepUpController } from '@/composables/useStepUp'

const api = vi.hoisted(() => ({
  getWebSettings: vi.fn(),
  updateWebSettings: vi.fn(),
  getWebUsageSettings: vi.fn(),
  updateWebUsageSettings: vi.fn(),
  listRunners: vi.fn(),
  createRunner: vi.fn(),
  updateRunner: vi.fn(),
  revokeRunner: vi.fn(),
  drainRunner: vi.fn()
}))

vi.mock('@/api/admin/claudex/web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin/claudex/web')>()),
  ...api
}))

const toast = vi.hoisted(() => ({ showSuccess: vi.fn(), showError: vi.fn() }))
vi.mock('@/stores/app', () => ({ useAppStore: () => toast }))
vi.mock('@/stores', () => ({ useAppStore: () => toast }))

vi.mock('@/composables/useClipboard', async () => {
  const vue = await import('vue')
  return { useClipboard: () => ({ copied: vue.ref(false), copyToClipboard: vi.fn() }) }
})

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: (key: string) =>
      key === 'admin.claudexWeb.errors.CLAUDEX_WEB_SETTINGS_CONFLICT' ||
      key === 'admin.claudexWeb.errors.CLAUDEX_WEB_RUNNER_NOT_FOUND'
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

const BaseDialogStub = defineComponent({
  props: { show: Boolean, title: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () => (props.show ? h('div', [h('h3', props.title), slots.default?.(), h('footer', slots.footer?.())]) : null)
  }
})

const webSettings = {
  enabled: true,
  mode: 'allowlist',
  allowlist_user_ids: [7],
  allowlist_emails: ['ann@example.com'],
  max_web_sessions_per_user: 5,
  revision: 3
}

const usageSettings = {
  max_concurrent_sessions_per_user: 1,
  max_concurrent_sessions: 4,
  max_session_minutes: 30,
  runner_minute_price_usd: 0,
  revision: 8
}

const runnersView = {
  items: [
    {
      id: 'local',
      name: 'Local runner',
      local: true,
      connected: true,
      draining: false,
      disabled: false,
      version: '1.2.0',
      methods: 30,
      capacity: { engines: 4, users: 8 },
      load: { engines: 1, users: 2, rss_mb: 300, at: '2026-09-29T10:00:00Z' },
      assigned_users: 2,
      connected_at: '2026-09-29T09:00:00Z',
      created_at: null,
      revoked_at: null,
      disabled_at: null,
      last_seen_at: null,
      labels: {}
    },
    {
      id: 'r5',
      record_id: 5,
      name: 'office',
      local: false,
      connected: false,
      draining: false,
      disabled: false,
      version: '1.1.0',
      methods: 0,
      capacity: null,
      load: null,
      assigned_users: 0,
      connected_at: null,
      created_at: '2026-09-01T10:00:00Z',
      revoked_at: null,
      disabled_at: null,
      last_seen_at: '2026-09-28T10:00:00Z',
      labels: {}
    },
    {
      id: 'r6',
      record_id: 6,
      name: 'old box',
      local: false,
      connected: false,
      draining: false,
      disabled: false,
      version: '',
      methods: 0,
      capacity: null,
      load: null,
      assigned_users: 0,
      connected_at: null,
      created_at: '2026-08-01T10:00:00Z',
      revoked_at: '2026-08-02T10:00:00Z',
      disabled_at: null,
      last_seen_at: null,
      labels: {}
    }
  ],
  local_token_configured: true,
  active_runs: 1,
  dropped_frames: 0,
  users_with_open_tabs: 2
}

async function mountPage(): Promise<VueWrapper> {
  api.getWebSettings.mockResolvedValue(webSettings)
  api.getWebUsageSettings.mockResolvedValue(usageSettings)
  api.listRunners.mockResolvedValue(runnersView)
  const wrapper = mount(ClaudexWebView, {
    attachTo: document.body,
    global: { stubs: { Icon: true, BaseDialog: BaseDialogStub, RouterLink: true } }
  })
  await flushPromises()
  return wrapper
}

function el(wrapper: VueWrapper, id: string) {
  return wrapper.get(`[data-testid="${id}"]`)
}

function card(wrapper: VueWrapper, id: string) {
  return el(wrapper, id)
}

async function clickSave(wrapper: VueWrapper, cardId: string) {
  await card(wrapper, cardId).get('[data-testid="claudex-save-button"]').trigger('click')
  await flushPromises()
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

describe('ClaudexWebView', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    toast.showSuccess.mockReset()
    toast.showError.mockReset()
  })

  it('shows the access setting, the limits and the runners', async () => {
    const wrapper = await mountPage()
    expect((el(wrapper, 'claudex-web-access-mode').element as HTMLSelectElement).value).toBe('allowlist')
    expect((el(wrapper, 'claudex-web-access-sessions').element as HTMLInputElement).value).toBe('5')
    expect(card(wrapper, 'claudex-web-access-lists').text()).toContain('ann@example.com')
    expect(card(wrapper, 'claudex-web-access-lists').text()).toContain('7')
    expect((el(wrapper, 'claudex-web-limits-concurrent').element as HTMLInputElement).value).toBe('4')
    expect((el(wrapper, 'claudex-web-limits-per-user').element as HTMLInputElement).value).toBe('1')
    expect((el(wrapper, 'claudex-web-limits-minutes').element as HTMLInputElement).value).toBe('30')
    const rows = wrapper.findAll('[data-testid="claudex-web-runner-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('admin.claudexWeb.runners.status_online')
    expect(rows[0].text()).toContain('1.2.0')
    expect(rows[1].text()).toContain('admin.claudexWeb.runners.status_offline')
    expect(rows[2].text()).toContain('admin.claudexWeb.runners.status_revoked')
    // The local runner can only be drained; a revoked one has no actions.
    expect(rows[0].find('[data-testid="claudex-web-runner-drain"]').exists()).toBe(true)
    expect(rows[0].find('[data-testid="claudex-web-runner-revoke"]').exists()).toBe(false)
    expect(rows[0].find('[data-testid="claudex-web-runner-rename"]').exists()).toBe(false)
    expect(rows[2].findAll('button')).toHaveLength(0)
  })

  it('saves the access setting with the revision it was loaded at', async () => {
    const wrapper = await mountPage()
    api.updateWebSettings.mockResolvedValue({ ...webSettings, mode: 'everyone', revision: 4 })
    await el(wrapper, 'claudex-web-access-mode').setValue('everyone')
    await clickSave(wrapper, 'claudex-web-access')
    expect(api.updateWebSettings).toHaveBeenCalledWith({
      enabled: true,
      mode: 'everyone',
      allowlist_user_ids: [7],
      allowlist_emails: ['ann@example.com'],
      max_web_sessions_per_user: 5,
      revision: 3
    })
    // The next save carries the new revision.
    api.updateWebSettings.mockResolvedValue({ ...webSettings, enabled: false, mode: 'everyone', revision: 5 })
    await el(wrapper, 'claudex-web-access-mode').setValue('off')
    expect(el(wrapper, 'claudex-web-access-off-note').exists()).toBe(true)
    await clickSave(wrapper, 'claudex-web-access')
    expect(api.updateWebSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, revision: 4 }))
  })

  it('refuses an out-of-range sessions value before sending', async () => {
    const wrapper = await mountPage()
    await el(wrapper, 'claudex-web-access-sessions').setValue('51')
    await clickSave(wrapper, 'claudex-web-access')
    expect(api.updateWebSettings).not.toHaveBeenCalled()
    expect(card(wrapper, 'claudex-web-access').text()).toContain('admin.claudexWeb.problems.sessionsPerUser')
  })

  it('reloads and says so when another administrator saved first', async () => {
    const wrapper = await mountPage()
    api.updateWebSettings.mockRejectedValue({
      status: 409,
      code: 'CLAUDEX_WEB_SETTINGS_CONFLICT',
      reason: 'CLAUDEX_WEB_SETTINGS_CONFLICT',
      message: 'changed'
    })
    api.getWebSettings.mockResolvedValue({ ...webSettings, max_web_sessions_per_user: 9, revision: 6 })
    await el(wrapper, 'claudex-web-access-sessions').setValue('2')
    await clickSave(wrapper, 'claudex-web-access')
    expect(api.getWebSettings).toHaveBeenCalledTimes(2)
    expect((el(wrapper, 'claudex-web-access-sessions').element as HTMLInputElement).value).toBe('9')
    expect(card(wrapper, 'claudex-web-access').text()).toContain('admin.claudexWeb.errors.CLAUDEX_WEB_SETTINGS_CONFLICT')
  })

  it('checks the limits and saves them', async () => {
    const wrapper = await mountPage()
    await el(wrapper, 'claudex-web-limits-per-user').setValue('5')
    await el(wrapper, 'claudex-web-limits-concurrent').setValue('3')
    await clickSave(wrapper, 'claudex-web-limits')
    expect(api.updateWebUsageSettings).not.toHaveBeenCalled()
    expect(card(wrapper, 'claudex-web-limits').text()).toContain('admin.claudexWeb.problems.perUserOverTotal')

    api.updateWebUsageSettings.mockResolvedValue({ ...usageSettings, max_concurrent_sessions: 6, revision: 9 })
    await el(wrapper, 'claudex-web-limits-concurrent').setValue('6')
    await el(wrapper, 'claudex-web-limits-minutes').setValue('60')
    await clickSave(wrapper, 'claudex-web-limits')
    expect(api.updateWebUsageSettings).toHaveBeenCalledWith({
      max_concurrent_sessions_per_user: 5,
      max_concurrent_sessions: 6,
      max_session_minutes: 60,
      runner_minute_price_usd: 0,
      revision: 8
    })
  })

  it('adds a runner and shows its token once', async () => {
    const wrapper = await mountPage()
    api.createRunner.mockResolvedValue({
      runner: { id: 9, name: 'lab', created_at: '2026-09-29T10:00:00Z' },
      token: 'cxr_secret-token-value'
    })
    await el(wrapper, 'claudex-web-runners-add').trigger('click')
    await el(wrapper, 'claudex-web-runner-name').setValue('   ')
    await el(wrapper, 'claudex-web-runner-form').trigger('submit')
    await flushPromises()
    expect(api.createRunner).not.toHaveBeenCalled()

    await el(wrapper, 'claudex-web-runner-name').setValue('  lab ')
    await el(wrapper, 'claudex-web-runner-form').trigger('submit')
    await flushPromises()
    expect(api.createRunner).toHaveBeenCalledWith('lab')
    expect((el(wrapper, 'claudex-web-runner-token').element as HTMLInputElement).value).toBe('cxr_secret-token-value')
    expect(api.listRunners).toHaveBeenCalledTimes(2)

    // Closing drops the token; adding another runner starts from an empty form.
    await el(wrapper, 'claudex-web-runner-done').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('cxr_secret-token-value')
    expect(wrapper.find('[data-testid="claudex-web-runner-token"]').exists()).toBe(false)
  })

  it('renames a runner', async () => {
    const wrapper = await mountPage()
    api.updateRunner.mockResolvedValue({ id: 5, name: 'hq', disabled: false })
    const row = wrapper.findAll('[data-testid="claudex-web-runner-row"]')[1]
    await row.get('[data-testid="claudex-web-runner-rename"]').trigger('click')
    expect((el(wrapper, 'claudex-web-runner-name').element as HTMLInputElement).value).toBe('office')
    await el(wrapper, 'claudex-web-runner-name').setValue('hq')
    await el(wrapper, 'claudex-web-runner-form').trigger('submit')
    await flushPromises()
    expect(api.updateRunner).toHaveBeenCalledWith(5, { name: 'hq' })
    expect(toast.showSuccess).toHaveBeenCalled()
  })

  it('switches a runner off after a confirmation, and on without one', async () => {
    const wrapper = await mountPage()
    api.updateRunner.mockResolvedValue({ id: 5, name: 'office', disabled: true })
    const row = wrapper.findAll('[data-testid="claudex-web-runner-row"]')[1]
    await row.get('[data-testid="claudex-web-runner-toggle"]').trigger('click')
    await flushPromises()
    expect(api.updateRunner).not.toHaveBeenCalled()
    await confirmDialog(wrapper, 'admin.claudexWeb.runners.disable')
    expect(api.updateRunner).toHaveBeenCalledWith(5, { disabled: true })

    api.listRunners.mockResolvedValue({
      ...runnersView,
      items: runnersView.items.map((r) => (r.id === 'r5' ? { ...r, disabled: true, disabled_at: '2026-09-29T10:00:00Z' } : r))
    })
    await wrapper.get('[data-testid="claudex-web-runners-reload"]').trigger('click')
    await flushPromises()
    const disabledRow = wrapper.findAll('[data-testid="claudex-web-runner-row"]')[1]
    expect(disabledRow.text()).toContain('admin.claudexWeb.runners.status_disabled')
    api.updateRunner.mockResolvedValue({ id: 5, name: 'office', disabled: false })
    await disabledRow.get('[data-testid="claudex-web-runner-toggle"]').trigger('click')
    await flushPromises()
    expect(api.updateRunner).toHaveBeenLastCalledWith(5, { disabled: false })
  })

  it('revokes a runner only after confirming, and drains the local one', async () => {
    const wrapper = await mountPage()
    api.revokeRunner.mockResolvedValue(undefined)
    const rows = wrapper.findAll('[data-testid="claudex-web-runner-row"]')
    await rows[1].get('[data-testid="claudex-web-runner-revoke"]').trigger('click')
    await flushPromises()
    expect(api.revokeRunner).not.toHaveBeenCalled()
    await confirmDialog(wrapper, 'admin.claudexWeb.runners.revoke.action')
    expect(api.revokeRunner).toHaveBeenCalledWith(5)

    api.drainRunner.mockResolvedValue(undefined)
    await rows[0].get('[data-testid="claudex-web-runner-drain"]').trigger('click')
    await flushPromises()
    await confirmDialog(wrapper, 'admin.claudexWeb.runners.drain.action')
    expect(api.drainRunner).toHaveBeenCalledWith('local')
  })

  it('shows a write error and still reloads the list', async () => {
    const wrapper = await mountPage()
    api.revokeRunner.mockRejectedValue({
      status: 404,
      code: 'CLAUDEX_WEB_RUNNER_NOT_FOUND',
      reason: 'CLAUDEX_WEB_RUNNER_NOT_FOUND',
      message: 'gone'
    })
    const rows = wrapper.findAll('[data-testid="claudex-web-runner-row"]')
    await rows[1].get('[data-testid="claudex-web-runner-revoke"]').trigger('click')
    await confirmDialog(wrapper, 'admin.claudexWeb.runners.revoke.action')
    expect(el(wrapper, 'claudex-web-runners-action-error').text()).toBe('admin.claudexWeb.errors.CLAUDEX_WEB_RUNNER_NOT_FOUND')
    expect(api.listRunners).toHaveBeenCalledTimes(2)
  })

  it('uses the page step-up for every write', async () => {
    const wrapper = await mountPage()
    const controller = wrapper.findComponent({ name: 'TotpStepUpDialog' }).props('controller') as StepUpController
    const run = vi.spyOn(controller, 'run')
    api.updateWebUsageSettings.mockResolvedValue({ ...usageSettings, revision: 9 })
    await el(wrapper, 'claudex-web-limits-minutes').setValue('45')
    await clickSave(wrapper, 'claudex-web-limits')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

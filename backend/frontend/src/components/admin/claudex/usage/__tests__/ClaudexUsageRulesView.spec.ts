// CLAUDEX K3: /admin/claudex/usage-rules: rule saves with the window presets in
// seconds, delete, counters with reset, and a user's usage status. Every write
// is confirmed first and sent through step-up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import en from '@/i18n/locales/en'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import ClaudexUsageRulesView from '@/views/admin/claudex/ClaudexUsageRulesView.vue'
import UserSearchSelect from '@/components/admin/claudex/devices/UserSearchSelect.vue'
import UsageRuleDialog from '../UsageRuleDialog.vue'
import UsageCountersDrawer from '../UsageCountersDrawer.vue'
import UserUsageStatusCard from '../UserUsageStatusCard.vue'

const api = vi.hoisted(() => ({
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  listCounters: vi.fn(),
  resetCounter: vi.fn(),
  getUserUsageStatus: vi.fn()
}))
const getAllGroups = vi.hoisted(() => vi.fn())
const stepUpRun = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ showSuccess: vi.fn(), showError: vi.fn() }))

vi.mock('@/api/admin/claudex/usageRules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin/claudex/usageRules')>()),
  ...api
}))
vi.mock('@/api/admin/groups', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/admin/groups')>()
  return { ...actual, getAll: getAllGroups, default: { ...actual.default, getAll: getAllGroups } }
})
vi.mock('@/stores', () => ({ useAppStore: () => toast }))
vi.mock('@/utils/format', () => ({
  formatDateTime: (value: unknown) => (value ? `date:${String(value)}` : ''),
  formatRelativeTime: (value: unknown) => `ago:${String(value)}`
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

const sessionRule = {
  id: 3,
  group_id: null,
  kind: 'session',
  label: 'Current session',
  model_patterns: ['*'],
  window_seconds: 18000,
  limit_usd: 5,
  enabled: true,
  show_in_client: true,
  sort_order: 0
}
const opusRule = {
  id: 5,
  group_id: 4,
  group_name: 'claudex-pro',
  kind: 'models',
  label: 'Opus',
  model_patterns: ['claude-opus-*'],
  window_seconds: 604800,
  limit_usd: 20,
  enabled: true,
  show_in_client: true,
  sort_order: 10
}

const wrappers: VueWrapper[] = []

async function mountView() {
  const wrapper = mount(ClaudexUsageRulesView, {
    attachTo: document.body,
    global: { stubs: { teleport: true, Icon: true, TotpStepUpDialog: true } }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function confirmDialog(wrapper: VueWrapper) {
  return wrapper.findComponent(ConfirmDialog)
}

async function accept(wrapper: VueWrapper) {
  expect(confirmDialog(wrapper).props('show')).toBe(true)
  confirmDialog(wrapper).vm.$emit('confirm')
  await flushPromises()
}

async function openCreate(wrapper: VueWrapper) {
  await wrapper.find('[data-testid="claudex-rule-create"]').trigger('click')
  await flushPromises()
  return wrapper.findComponent(UsageRuleDialog)
}

async function submitDialog(wrapper: VueWrapper) {
  await wrapper.find('[data-testid="claudex-rule-submit"]').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  getAllGroups.mockReset()
  stepUpRun.mockReset()
  toast.showSuccess.mockReset()
  toast.showError.mockReset()
  stepUpRun.mockImplementation((action: () => Promise<unknown>) => action())
  api.listRules.mockResolvedValue([opusRule, sessionRule])
  api.createRule.mockImplementation(async (input: object) => ({ id: 9, ...input }))
  api.updateRule.mockImplementation(async (id: number, input: object) => ({ id, ...input }))
  api.deleteRule.mockResolvedValue({ deleted: true })
  api.listCounters.mockResolvedValue({
    items: [
      {
        user_id: 123,
        user_email: 'a@example.com',
        window_start: '2026-09-26T01:00:00Z',
        window_end: '2999-01-01T00:00:00Z',
        used_usd: 20.13,
        request_count: 42,
        updated_at: '2026-09-26T02:00:00Z'
      },
      {
        user_id: 124,
        user_email: 'b@example.com',
        window_start: '2026-01-01T00:00:00Z',
        window_end: '2026-01-08T00:00:00Z',
        used_usd: 3.5,
        request_count: 7,
        updated_at: '2026-01-07T00:00:00Z'
      }
    ],
    total: 2,
    page: 1,
    page_size: 20,
    pages: 1
  })
  api.resetCounter.mockResolvedValue({ reset: true })
  api.getUserUsageStatus.mockResolvedValue({
    plan: { group_id: 4, group_name: 'claudex-pro' },
    windows: [
      {
        id: 'rule:3',
        source: 'rule',
        kind: 'session',
        label: 'Current session',
        window: '5h',
        window_seconds: 18000,
        used_usd: 1.2,
        limit_usd: 5,
        percent: 24,
        active: true,
        window_start: '2026-09-26T01:00:00Z',
        resets_at: '2026-09-26T06:00:00Z',
        models: null,
        exceeded: false
      }
    ],
    balance: { balance_usd: 12.34 },
    blocked: { blocked: false, window_id: null, reason: null, resets_at: null },
    updated_at: '2026-09-26T02:30:00Z'
  })
  getAllGroups.mockResolvedValue([
    { id: 4, name: 'claudex-pro', platform: 'openai' },
    { id: 2, name: 'claudex-basic', platform: 'openai' }
  ])
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

describe('ClaudexUsageRulesView rules', () => {
  it('lists rules by group, All groups first', async () => {
    const wrapper = await mountView()
    const sections = wrapper.findAll('[data-testid="claudex-rule-section"]')
    expect(sections).toHaveLength(2)
    expect(sections[0].text()).toContain('admin.claudexUsageRules.allGroups')
    expect(sections[0].text()).toContain('Current session')
    expect(sections[0].find('[data-testid="claudex-rule-window-cell"]').text()).toBe(
      'admin.claudexUsageRules.window.5h{}'
    )
    expect(sections[1].text()).toContain('claudex-pro')
    expect(sections[1].text()).toContain('claude-opus-*')
    expect(sections[1].text()).toContain('$20.00')
  })

  it('marks the rules of a deleted group', async () => {
    api.listRules.mockResolvedValue([
      sessionRule,
      { ...opusRule, id: 6, group_id: 99, group_name: 'old-group', group_deleted: true }
    ])
    const wrapper = await mountView()
    const sections = wrapper.findAll('[data-testid="claudex-rule-section"]')
    expect(sections).toHaveLength(2)
    expect(sections[0].find('[data-testid="claudex-rule-section-deleted"]').exists()).toBe(false)
    expect(sections[1].text()).toContain('old-group')
    expect(sections[1].find('[data-testid="claudex-rule-section-deleted"]').text()).toBe(
      'admin.claudexUsageRules.groupDeleted'
    )
    // No new rules for a deleted group (the server would refuse them).
    expect(sections[1].find('[data-testid="claudex-rule-add-99"]').exists()).toBe(false)
    await sections[1].find('[data-testid="claudex-rule-edit"]').trigger('click')
    await flushPromises()
    const select = wrapper.findComponent(UsageRuleDialog).find('[data-testid="claudex-rule-group"]')
    expect(select.text()).toContain('admin.claudexUsageRules.deletedGroupOption{"name":"old-group"}')
  })

  it.each([
    ['5h', null, 18000],
    ['24h', null, 86400],
    ['7d', null, 604800],
    ['30d', null, 2592000],
    ['custom', '36', 129600]
  ])('saves window %s (custom hours %s) as %d seconds after confirmation and step-up', async (choice, hours, seconds) => {
    const wrapper = await mountView()
    const dialog = await openCreate(wrapper)
    await dialog.find('[data-testid="claudex-rule-limit"]').setValue('5')
    await dialog.find('[data-testid="claudex-rule-window"]').setValue(choice)
    if (hours) await dialog.find('[data-testid="claudex-rule-custom-hours"]').setValue(hours)
    await submitDialog(wrapper)

    expect(api.createRule).not.toHaveBeenCalled()
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.createRule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session', label: 'admin.claudexUsageRules.defaults.sessionLabel', window_seconds: seconds })
    )
    expect(wrapper.findComponent(UsageRuleDialog).props('show')).toBe(false)
    expect(api.listRules).toHaveBeenCalledTimes(2)
  })

  it('creates a specific-models rule for a group', async () => {
    const wrapper = await mountView()
    const dialog = await openCreate(wrapper)
    await dialog.find('[data-testid="claudex-rule-group"]').setValue('4')
    await dialog.find('[data-testid="claudex-rule-kind"]').setValue('models')
    // Changing the kind moves the window to its default (7 days).
    expect((dialog.find('[data-testid="claudex-rule-window"]').element as HTMLSelectElement).value).toBe('7d')
    await dialog.find('[data-testid="claudex-rule-label"]').setValue('Opus')
    const tagInput = dialog.find('[data-testid="claudex-tag-input"]')
    await tagInput.setValue('claude-opus-*')
    await tagInput.trigger('keydown', { key: 'Enter' })
    await dialog.find('[data-testid="claudex-rule-limit"]').setValue('20')
    await dialog.find('[data-testid="claudex-rule-sort"]').setValue('10')
    await dialog.find('[data-testid="claudex-rule-show"]').trigger('click')
    await submitDialog(wrapper)
    expect(confirmDialog(wrapper).props('message')).toBe('admin.claudexUsageRules.confirm.saveMessage{"group":"claudex-pro"}')
    await accept(wrapper)
    expect(api.createRule).toHaveBeenCalledWith({
      group_id: 4,
      kind: 'models',
      label: 'Opus',
      model_patterns: ['claude-opus-*'],
      window_seconds: 604800,
      limit_usd: 20,
      enabled: true,
      show_in_client: false,
      sort_order: 10
    })
  })

  it('checks the form before asking', async () => {
    const wrapper = await mountView()
    const dialog = await openCreate(wrapper)
    await dialog.find('[data-testid="claudex-rule-kind"]').setValue('models')
    await dialog.find('[data-testid="claudex-rule-label"]').setValue('')
    await dialog.find('[data-testid="claudex-rule-window"]').setValue('custom')
    await dialog.find('[data-testid="claudex-rule-custom-hours"]').setValue('721')
    await submitDialog(wrapper)
    expect(confirmDialog(wrapper).props('show')).toBe(false)
    const text = dialog.text()
    expect(text).toContain('admin.claudexUsageRules.validation.labelRequired')
    expect(text).toContain('admin.claudexUsageRules.validation.patternsRequired')
    expect(text).toContain('admin.claudexUsageRules.validation.customHours')
    expect(text).toContain('admin.claudexUsageRules.validation.limit')
    expect(api.createRule).not.toHaveBeenCalled()
  })

  it('edits a rule after confirmation and step-up', async () => {
    const wrapper = await mountView()
    const rows = wrapper.findAll('[data-testid="claudex-rule-row"]')
    await rows[1].find('[data-testid="claudex-rule-edit"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.findComponent(UsageRuleDialog)
    expect((dialog.find('[data-testid="claudex-rule-label"]').element as HTMLInputElement).value).toBe('Opus')
    expect((dialog.find('[data-testid="claudex-rule-window"]').element as HTMLSelectElement).value).toBe('7d')
    await dialog.find('[data-testid="claudex-rule-limit"]').setValue('25')
    await submitDialog(wrapper)
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.updateRule).toHaveBeenCalledWith(5, {
      group_id: 4,
      kind: 'models',
      label: 'Opus',
      model_patterns: ['claude-opus-*'],
      window_seconds: 604800,
      limit_usd: 25,
      enabled: true,
      show_in_client: true,
      sort_order: 10
    })
  })

  it('keeps the dialog open with the error when the save fails', async () => {
    api.createRule.mockRejectedValueOnce({ status: 400, reason: 'CLAUDEX_USAGE_RULE_INVALID', message: 'bad' })
    const wrapper = await mountView()
    const dialog = await openCreate(wrapper)
    await dialog.find('[data-testid="claudex-rule-limit"]').setValue('5')
    await submitDialog(wrapper)
    await accept(wrapper)
    expect(wrapper.findComponent(UsageRuleDialog).props('show')).toBe(true)
    expect(wrapper.find('[data-testid="claudex-rule-error"]').text()).toBe(
      'admin.claudexUsageRules.errors.CLAUDEX_USAGE_RULE_INVALID'
    )
  })

  it('does not save when the confirmation is declined', async () => {
    const wrapper = await mountView()
    const dialog = await openCreate(wrapper)
    await dialog.find('[data-testid="claudex-rule-limit"]').setValue('5')
    await submitDialog(wrapper)
    confirmDialog(wrapper).vm.$emit('cancel')
    await flushPromises()
    expect(stepUpRun).not.toHaveBeenCalled()
    expect(api.createRule).not.toHaveBeenCalled()
  })

  it('deletes a rule after confirmation and step-up', async () => {
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="claudex-rule-delete"]')[1].trigger('click')
    await flushPromises()
    expect(confirmDialog(wrapper).props('danger')).toBe(true)
    expect(api.deleteRule).not.toHaveBeenCalled()
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.deleteRule).toHaveBeenCalledWith(5)
  })
})

describe('ClaudexUsageRulesView counters', () => {
  it('lists counters and resets one after confirmation and step-up', async () => {
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="claudex-rule-counters"]')[1].trigger('click')
    await flushPromises()
    expect(api.listCounters).toHaveBeenCalledWith(5, { user_id: null, page: 1, page_size: 20 })
    const drawer = wrapper.findComponent(UsageCountersDrawer)
    const row = drawer.find('[data-testid="claudex-counter-row"]')
    expect(row.text()).toContain('a@example.com')
    expect(row.text()).toContain('$20.13')
    expect(row.text()).toContain('42')
    expect(row.text()).toContain('admin.claudexUsageRules.counters.resetsAt')
    // A window that has ended says the next request starts a new one.
    const ended = drawer.findAll('[data-testid="claudex-counter-row"]')[1]
    expect(ended.text()).toContain('admin.claudexUsageRules.counters.windowEnded')
    expect(ended.text()).toContain('admin.claudexUsageRules.counters.nextWindow')

    await row.find('[data-testid="claudex-counter-reset"]').trigger('click')
    await flushPromises()
    expect(api.resetCounter).not.toHaveBeenCalled()
    await accept(wrapper)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(api.resetCounter).toHaveBeenCalledWith(5, 123)
    expect(api.listCounters).toHaveBeenCalledTimes(2)
  })

  it('filters counters by user', async () => {
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="claudex-rule-counters"]')[0].trigger('click')
    await flushPromises()
    const drawer = wrapper.findComponent(UsageCountersDrawer)
    drawer.findComponent(UserSearchSelect).vm.$emit('update:modelValue', { id: 123, email: 'a@example.com' })
    await flushPromises()
    expect(api.listCounters).toHaveBeenLastCalledWith(3, { user_id: 123, page: 1, page_size: 20 })
  })
})

describe('ClaudexUsageRulesView user usage status', () => {
  it('shows what the user sees in Claudex', async () => {
    const wrapper = await mountView()
    const card = wrapper.findComponent(UserUsageStatusCard)
    card.findComponent(UserSearchSelect).vm.$emit('update:modelValue', { id: 123, email: 'a@example.com' })
    await flushPromises()
    expect(api.getUserUsageStatus).toHaveBeenCalledWith(123, null)
    const windowRow = card.find('[data-testid="claudex-status-window"]')
    expect(windowRow.text()).toContain('Current session')
    expect(windowRow.text()).toContain('$1.20 / $5.00')
    expect(windowRow.text()).toContain('24%')
    expect(card.text()).toContain('claudex-pro')

    await card.find('[data-testid="claudex-status-group"]').setValue('2')
    await flushPromises()
    expect(api.getUserUsageStatus).toHaveBeenLastCalledWith(123, 2)
  })

  it('shows a blocked user and load errors', async () => {
    api.getUserUsageStatus.mockResolvedValueOnce({
      plan: null,
      windows: [],
      blocked: { blocked: true, window_id: 'rule:3', reason: 'RULE_LIMIT', resets_at: '2026-09-26T06:00:00Z' }
    })
    const wrapper = await mountView()
    const card = wrapper.findComponent(UserUsageStatusCard)
    card.findComponent(UserSearchSelect).vm.$emit('update:modelValue', { id: 123, email: '' })
    await flushPromises()
    expect(card.find('[data-testid="claudex-status-blocked"]').exists()).toBe(true)
    expect(card.find('[data-testid="claudex-status-empty"]').exists()).toBe(true)

    api.getUserUsageStatus.mockRejectedValueOnce({ status: 400, reason: 'CLAUDEX_USER_NOT_FOUND', message: 'x' })
    await card.find('[data-testid="claudex-status-load"]').trigger('click')
    await flushPromises()
    expect(card.find('[data-testid="claudex-status-error"]').text()).toBe(
      'admin.claudexUsageRules.errors.CLAUDEX_USER_NOT_FOUND'
    )

    // The user endpoint's NO_PLAN message speaks to the user ("Your account ..."); the admin sees page text.
    api.getUserUsageStatus.mockRejectedValueOnce({
      status: 403,
      reason: 'CLAUDEX_NO_PLAN',
      message: 'Your account has no plan that Claudex can use. Contact your administrator.'
    })
    await card.find('[data-testid="claudex-status-load"]').trigger('click')
    await flushPromises()
    expect(card.find('[data-testid="claudex-status-error"]').text()).toBe('admin.claudexUsageRules.errors.CLAUDEX_NO_PLAN')
  })
})

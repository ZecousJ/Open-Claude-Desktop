// CLAUDEX: the model catalog page /admin/claudex/models (K2): list, filters, default switch,
// delete and load errors. Lives with the page's components (K2 owns components/admin/claudex/models/**).
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudexModelMeta } from '@/api/admin/claudex/models'
import ClaudexModelsView from '@/views/admin/claudex/ClaudexModelsView.vue'
import { getPersistedPageSize } from '@/composables/usePersistedPageSize'
import { AppLayoutStub, BaseDialogStub, ConfirmDialogStub, DataTableStub, RouterLinkStub, SelectStub } from './stubs'

const { list, create, update, remove, candidates, getAllIncludingInactive, showSuccess, showError, knownKeys, stepUpRun } =
  vi.hoisted(() => ({
    stepUpRun: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    candidates: vi.fn(),
    getAllIncludingInactive: vi.fn(),
    showSuccess: vi.fn(),
    showError: vi.fn(),
    knownKeys: new Set<string>()
  }))

vi.mock('@/api/admin', () => ({
  adminAPI: {
    claudex: { models: { list, create, update, remove, candidates } },
    groups: { getAllIncludingInactive }
  }
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showSuccess, showError })
}))

// Catalog writes go through step-up (R13): the page's controller runs them.
vi.mock('@/composables/useStepUp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useStepUp')>()
  return {
    ...actual,
    useStepUp: () => ({ visible: { value: false }, blockedReason: { value: '' }, run: stepUpRun })
  }
})

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  const { fakeT } = await import('./stubs')
  return { ...actual, useI18n: () => ({ t: fakeT, te: (key: string) => knownKeys.has(key) }) }
})

function entry(overrides: Partial<ClaudexModelMeta>): ClaudexModelMeta {
  return {
    id: 1,
    model_id: 'gpt-5.5',
    group_id: null,
    display_name: '',
    description: '',
    badges: [],
    sort_order: 0,
    hidden: false,
    is_default: false,
    supported_efforts: null,
    default_effort: '',
    context_window: null,
    auto_compact_tokens: null,
    fast_tier: null,
    usage_hint: '',
    created_by: 1,
    created_at: '2026-09-26T00:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
    ...overrides
  }
}

const big = entry({
  id: 1,
  model_id: 'gpt-5.5',
  display_name: 'GPT-5.5',
  description: 'Our smartest model for complex work',
  badges: ['new'],
  sort_order: 10,
  is_default: true,
  supported_efforts: ['low', 'medium', 'high', 'xhigh'],
  default_effort: 'medium',
  context_window: 400000,
  auto_compact_tokens: 320000,
  fast_tier: true,
  usage_hint: '1.5× usage'
})
const mini = entry({ id: 2, model_id: 'gpt-5.5-mini', display_name: 'GPT-5.5 mini', sort_order: 20, fast_tier: false })
const legacy = entry({ id: 3, model_id: 'gpt-4.1', group_id: 4, hidden: true })

function page(items: ClaudexModelMeta[], total = items.length) {
  return { items, total, page: 1, page_size: 20, pages: Math.max(1, Math.ceil(total / 20)) }
}

function mountView() {
  return mount(ClaudexModelsView, {
    global: {
      stubs: {
        AppLayout: AppLayoutStub,
        BaseDialog: BaseDialogStub,
        ConfirmDialog: ConfirmDialogStub,
        DataTable: DataTableStub,
        Select: SelectStub,
        RouterLink: RouterLinkStub,
        EmptyState: true,
        Pagination: true,
        Icon: true,
        TotpStepUpDialog: true
      }
    }
  })
}

const byTestId = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-testid="${id}"]`)
const rowEl = (wrapper: VueWrapper, id: number) => wrapper.get(`[data-testid="row"][data-id="${id}"]`)
const cell = (wrapper: VueWrapper, id: number, col: string) => rowEl(wrapper, id).get(`[data-col="${col}"]`)
const lastListQuery = () => list.mock.calls[list.mock.calls.length - 1][0]

describe('ClaudexModelsView', () => {
  beforeEach(() => {
    knownKeys.clear()
    list.mockReset().mockResolvedValue(page([big, mini, legacy]))
    create.mockReset()
    update.mockReset().mockImplementation(async (id, body) => entry({ ...body, id }))
    remove.mockReset().mockResolvedValue({ deleted: true })
    candidates.mockReset().mockResolvedValue({ models: ['gpt-5.5', 'gpt-5.5-mini'], sources: {} })
    getAllIncludingInactive.mockReset().mockResolvedValue([
      { id: 4, name: 'Pro', status: 'active', max_reasoning_effort: '' },
      { id: 5, name: 'Old', status: 'inactive', max_reasoning_effort: '' }
    ])
    showSuccess.mockReset()
    showError.mockReset()
    stepUpRun.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the catalog with every column of the design', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(list).toHaveBeenCalledTimes(1)
    expect(lastListQuery()).toMatchObject({ scope: 'all', q: '', page: 1 })
    expect(wrapper.find('h2').text()).toBe('admin.claudexModels.title')
    expect(byTestId(wrapper, 'claudex-models-note').text()).toContain('admin.claudexModels.hiddenNote')

    expect(cell(wrapper, 1, 'model_id').text()).toContain('gpt-5.5')
    expect(cell(wrapper, 1, 'model_id').text()).toContain('Our smartest model for complex work')
    expect(cell(wrapper, 1, 'scope').text()).toBe('admin.claudexModels.scopeGlobal')
    expect(cell(wrapper, 3, 'scope').text()).toBe('Pro')
    expect(cell(wrapper, 1, 'display_name').text()).toBe('GPT-5.5')
    expect(cell(wrapper, 1, 'badges').text()).toBe('new')
    expect(cell(wrapper, 1, 'sort_order').text()).toBe('10')
    expect(cell(wrapper, 3, 'hidden').text()).toBe('admin.claudexModels.hiddenYes')
    expect(cell(wrapper, 1, 'hidden').text()).toBe('—')
    expect(cell(wrapper, 1, 'is_default').text()).toBe('admin.claudexModels.defaultYes')
    expect(cell(wrapper, 2, 'is_default').text()).toBe('—')
    const efforts = cell(wrapper, 1, 'supported_efforts').findAll('span')
    expect(efforts.map((chip) => chip.text())).toEqual(['low', 'medium', 'high', 'xhigh'])
    // The default effort is marked.
    expect(efforts.filter((chip) => chip.attributes('title')).map((chip) => chip.text())).toEqual(['medium'])
    expect(cell(wrapper, 2, 'supported_efforts').text()).toBe('admin.claudexModels.effortsUnknown')
    expect(cell(wrapper, 1, 'context_window').text()).toBe(new Intl.NumberFormat().format(400000))
    expect(cell(wrapper, 1, 'auto_compact_tokens').text()).toBe(new Intl.NumberFormat().format(320000))
    expect(cell(wrapper, 2, 'context_window').text()).toBe('—')
    // Fast mode was dropped (R6): no Fast column.
    expect(rowEl(wrapper, 1).find('[data-col="fast_tier"]').exists()).toBe(false)
    expect(cell(wrapper, 1, 'usage_hint').text()).toBe('1.5× usage')
    // The default row has no "Make default" action; the others do.
    expect(rowEl(wrapper, 1).find('[data-testid="claudex-models-make-default"]').exists()).toBe(false)
    expect(rowEl(wrapper, 2).find('[data-testid="claudex-models-make-default"]').exists()).toBe(true)
  })

  it('filters by scope: all, global only, or one group', async () => {
    const wrapper = mountView()
    await flushPromises()
    const scope = byTestId(wrapper, 'claudex-models-scope-filter')
    expect(scope.findAll('option').map((o) => o.text())).toEqual([
      'admin.claudexModels.scopeAll',
      'admin.claudexModels.scopeGlobal',
      'Pro',
      'admin.claudexModels.groupInactive{"name":"Old"}'
    ])

    await scope.setValue('global')
    await flushPromises()
    expect(lastListQuery()).toMatchObject({ scope: 'global', page: 1 })

    await scope.setValue('4')
    await flushPromises()
    expect(lastListQuery()).toMatchObject({ scope: 4, page: 1 })
  })

  it('searches after typing stops', async () => {
    vi.useFakeTimers()
    const wrapper = mountView()
    await flushPromises()
    const input = byTestId(wrapper, 'claudex-models-search')
    await input.setValue('mini')
    await input.setValue('mini ')
    expect(list).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(2)
    expect(lastListQuery()).toMatchObject({ q: 'mini ', page: 1 })
  })

  it('makes an entry the default and reloads, so the old default is no longer marked', async () => {
    const wrapper = mountView()
    await flushPromises()
    list.mockResolvedValueOnce(page([{ ...big, is_default: false }, { ...mini, is_default: true }, legacy]))

    await rowEl(wrapper, 2).get('[data-testid="claudex-models-make-default"]').trigger('click')
    await flushPromises()

    expect(update).toHaveBeenCalledTimes(1)
    const [id, body] = update.mock.calls[0]
    expect(id).toBe(2)
    expect(body).toMatchObject({ model_id: 'gpt-5.5-mini', group_id: null, is_default: true, fast_tier: false })
    expect(body).not.toHaveProperty('id')
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(2)
    expect(cell(wrapper, 2, 'is_default').text()).toBe('admin.claudexModels.defaultYes')
    expect(cell(wrapper, 1, 'is_default').text()).toBe('—')
    expect(showSuccess).toHaveBeenCalledWith('admin.claudexModels.madeDefault{"model":"gpt-5.5-mini"}')
  })

  it('reloads after the editor saves a new default for the scope', async () => {
    const wrapper = mountView()
    await flushPromises()
    await rowEl(wrapper, 2).get('[data-testid="claudex-models-edit"]').trigger('click')
    await flushPromises()
    expect(byTestId(wrapper, 'dialog-title').text()).toBe('admin.claudexModels.editor.editTitle')

    list.mockResolvedValueOnce(page([{ ...big, is_default: false }, { ...mini, is_default: true }, legacy]))
    await byTestId(wrapper, 'claudex-model-default').setValue(true)
    await byTestId(wrapper, 'claudex-model-form').trigger('submit')
    await flushPromises()

    expect(update).toHaveBeenCalledWith(2, expect.objectContaining({ model_id: 'gpt-5.5-mini', is_default: true }))
    expect(wrapper.find('[data-testid="dialog"]').exists()).toBe(false)
    expect(list).toHaveBeenCalledTimes(2)
    expect(cell(wrapper, 2, 'is_default').text()).toBe('admin.claudexModels.defaultYes')
    expect(cell(wrapper, 1, 'is_default').text()).toBe('—')
    expect(showSuccess).toHaveBeenCalledWith('admin.claudexModels.saved')
  })

  it('shows a failed default switch and still reloads', async () => {
    knownKeys.add('admin.claudexModels.errors.CLAUDEX_MODEL_META_NOT_FOUND')
    update.mockRejectedValueOnce({ status: 404, code: 404, reason: 'CLAUDEX_MODEL_META_NOT_FOUND', message: 'gone' })
    const wrapper = mountView()
    await flushPromises()
    await rowEl(wrapper, 2).get('[data-testid="claudex-models-make-default"]').trigger('click')
    await flushPromises()
    expect(showError).toHaveBeenCalledWith('admin.claudexModels.errors.CLAUDEX_MODEL_META_NOT_FOUND')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('starts a new entry in the group the list is filtered to', async () => {
    const wrapper = mountView()
    await flushPromises()
    await byTestId(wrapper, 'claudex-models-scope-filter').setValue('4')
    await flushPromises()
    await byTestId(wrapper, 'claudex-models-add').trigger('click')
    await flushPromises()
    expect(byTestId(wrapper, 'dialog-title').text()).toBe('admin.claudexModels.editor.createTitle')
    expect((byTestId(wrapper, 'claudex-model-scope').element as HTMLSelectElement).value).toBe('4')
    expect(candidates).toHaveBeenLastCalledWith(4, expect.anything())
  })

  it('deletes an entry after confirmation', async () => {
    const wrapper = mountView()
    await flushPromises()
    await rowEl(wrapper, 3).get('[data-testid="claudex-models-delete"]').trigger('click')
    expect(byTestId(wrapper, 'confirm-message').text()).toBe(
      'admin.claudexModels.deleteConfirm{"model":"gpt-4.1","scope":"Pro"}'
    )
    list.mockResolvedValueOnce(page([big, mini]))
    await byTestId(wrapper, 'confirm-yes').trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith(3)
    expect(stepUpRun).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="row"][data-id="3"]').exists()).toBe(false)
    expect(showSuccess).toHaveBeenCalledWith('admin.claudexModels.deleted{"model":"gpt-4.1"}')
  })

  it('shows nothing when the step-up prompt is dismissed', async () => {
    const { StepUpCancelledError } = await import('@/composables/useStepUp')
    stepUpRun.mockRejectedValue(new StepUpCancelledError())
    const wrapper = mountView()
    await flushPromises()
    await rowEl(wrapper, 2).get('[data-testid="claudex-models-make-default"]').trigger('click')
    await flushPromises()
    await rowEl(wrapper, 3).get('[data-testid="claudex-models-delete"]').trigger('click')
    await byTestId(wrapper, 'confirm-yes').trigger('click')
    await flushPromises()
    expect(update).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
    expect(showSuccess).not.toHaveBeenCalled()
  })

  it('explains a step-up that cannot be completed', async () => {
    stepUpRun.mockRejectedValue({ status: 403, code: 'STEP_UP_TOTP_NOT_ENABLED', message: 'enable TOTP' })
    const wrapper = mountView()
    await flushPromises()
    await rowEl(wrapper, 3).get('[data-testid="claudex-models-delete"]').trigger('click')
    await byTestId(wrapper, 'confirm-yes').trigger('click')
    await flushPromises()
    expect(remove).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the delete is cancelled', async () => {
    const wrapper = mountView()
    await flushPromises()
    await rowEl(wrapper, 1).get('[data-testid="claudex-models-delete"]').trigger('click')
    await byTestId(wrapper, 'confirm-no').trigger('click')
    expect(remove).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="confirm"]').exists()).toBe(false)
  })

  it('treats deleting an entry that is already gone as done', async () => {
    remove.mockRejectedValueOnce({ status: 404, code: 404, reason: 'CLAUDEX_MODEL_META_NOT_FOUND', message: 'gone' })
    const wrapper = mountView()
    await flushPromises()
    await rowEl(wrapper, 2).get('[data-testid="claudex-models-delete"]').trigger('click')
    await byTestId(wrapper, 'confirm-yes').trigger('click')
    await flushPromises()
    expect(showError).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('shows a load error with retry', async () => {
    list
      .mockReset()
      .mockRejectedValueOnce({ status: 500, message: 'boom' })
      .mockResolvedValueOnce(page([big]))
    const wrapper = mountView()
    await flushPromises()
    const error = byTestId(wrapper, 'claudex-page-load-error')
    expect(error.text()).toContain('boom')
    await error.get('button').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="claudex-page-load-error"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="row"]')).toHaveLength(1)
  })

  it('labels an entry whose group was deleted and uses the name the row carries', async () => {
    list.mockResolvedValue(
      page([entry({ id: 8, model_id: 'gpt-4o', group_id: 99, group_name: 'Gone plan', group_deleted: true })])
    )
    const wrapper = mountView()
    await flushPromises()
    const scope = cell(wrapper, 8, 'scope')
    expect(scope.text()).toContain('Gone plan')
    expect(scope.get('[data-testid="claudex-models-group-deleted"]').text()).toBe(
      'admin.claudexModels.groupDeletedBadge'
    )
  })

  it('falls back to group ids when the groups cannot be loaded', async () => {
    getAllIncludingInactive.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountView()
    await flushPromises()
    expect(showError).toHaveBeenCalledWith('admin.claudexModels.groupsLoadFailed')
    expect(cell(wrapper, 3, 'scope').text()).toBe('admin.claudexModels.groupFallback{"id":4}')

    // Refresh tries the groups again.
    await byTestId(wrapper, 'claudex-models-refresh').trigger('click')
    await flushPromises()
    expect(getAllIncludingInactive).toHaveBeenCalledTimes(2)
    expect(cell(wrapper, 3, 'scope').text()).toBe('Pro')
  })

  it('goes back a page when the current page no longer exists', async () => {
    list
      .mockReset()
      .mockResolvedValueOnce({ items: [], total: 21, page: 3, page_size: 20, pages: 2 })
      .mockResolvedValueOnce({ items: [big], total: 21, page: 2, page_size: 20, pages: 2 })
    const wrapper = mountView()
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(2)
    expect(lastListQuery()).toMatchObject({ page: 2 })
    expect(wrapper.findAll('[data-testid="row"]')).toHaveLength(1)
  })

  it('pages with the smaller page size the server used', async () => {
    // The server caps a page at 200 rows; a larger configured size must not hide the rest.
    const requested = getPersistedPageSize()
    list.mockReset().mockResolvedValue({ items: [big], total: 300, page: 1, page_size: requested - 5, pages: 60 })
    const wrapper = mountView()
    await flushPromises()
    expect(lastListQuery()).toMatchObject({ page_size: requested })
    expect(wrapper.findComponent({ name: 'Pagination' }).props('pageSize')).toBe(requested - 5)
  })
})

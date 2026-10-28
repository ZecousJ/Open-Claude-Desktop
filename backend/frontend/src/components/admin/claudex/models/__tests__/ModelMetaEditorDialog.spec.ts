// CLAUDEX: the model catalog editor dialog (K2): candidates, checks, save bodies and server errors.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudexModelMeta } from '@/api/admin/claudex/models'
import type { AdminGroup } from '@/types'
import ModelMetaEditorDialog from '../ModelMetaEditorDialog.vue'
import { BaseDialogStub, RouterLinkStub, SelectStub } from './stubs'

const { candidates, create, update, knownKeys } = vi.hoisted(() => ({
  candidates: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  knownKeys: new Set<string>()
}))

vi.mock('@/api/admin', () => ({
  adminAPI: { claudex: { models: { candidates, create, update } } }
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  const { fakeT } = await import('./stubs')
  return { ...actual, useI18n: () => ({ t: fakeT, te: (key: string) => knownKeys.has(key) }) }
})

const groups = [
  { id: 4, name: 'Pro', status: 'active', max_reasoning_effort: 'medium' },
  { id: 5, name: 'Old', status: 'inactive', max_reasoning_effort: '' }
] as unknown as AdminGroup[]

const row: ClaudexModelMeta = {
  id: 7,
  model_id: 'gpt-5.5',
  group_id: 4,
  display_name: 'GPT-5.5',
  description: 'Our smartest model for complex work',
  badges: ['new'],
  sort_order: 10,
  hidden: false,
  is_default: false,
  supported_efforts: ['low', 'medium'],
  default_effort: 'medium',
  context_window: 400000,
  auto_compact_tokens: 320000,
  fast_tier: true,
  usage_hint: '1.5× usage',
  created_by: 1,
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(ModelMetaEditorDialog, {
    props: { show: true, groups, ...props },
    global: {
      stubs: { BaseDialog: BaseDialogStub, Select: SelectStub, RouterLink: RouterLinkStub, Icon: true }
    }
  })
}

const byTestId = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-testid="${id}"]`)

async function submit(wrapper: VueWrapper) {
  await byTestId(wrapper, 'claudex-model-form').trigger('submit')
  await flushPromises()
}

describe('ModelMetaEditorDialog', () => {
  beforeEach(() => {
    knownKeys.clear()
    candidates.mockReset().mockResolvedValue({
      models: ['gpt-5.5', 'gpt-5.5-mini'],
      sources: { 'gpt-5.5': ['allowlist', 'channel_pricing'], 'gpt-5.5-mini': ['default_mapped_model'] }
    })
    create.mockReset().mockImplementation(async (body) => ({ ...row, ...body, id: 11 }))
    update.mockReset().mockImplementation(async (id, body) => ({ ...row, ...body, id }))
  })

  it('loads candidates for the new entry’s scope and lists them with their sources', async () => {
    const wrapper = mountDialog({ defaultGroupId: 4 })
    await flushPromises()

    expect(candidates).toHaveBeenCalledTimes(1)
    expect(candidates.mock.calls[0][0]).toBe(4)
    expect((byTestId(wrapper, 'claudex-model-scope').element as HTMLSelectElement).value).toBe('4')
    const options = wrapper.findAll('[data-testid="claudex-model-candidates"] option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['gpt-5.5', 'gpt-5.5-mini'])
    expect(options[0].text()).toBe('admin.claudexModels.sources.allowlist, admin.claudexModels.sources.channelPricing')
    expect(options[1].text()).toBe('admin.claudexModels.sources.defaultMappedModel')
    expect(byTestId(wrapper, 'claudex-model-candidates-status').text()).toBe(
      'admin.claudexModels.editor.candidatesCount{"count":2}'
    )
  })

  it('reloads candidates when the scope changes and ignores a late answer for the old scope', async () => {
    const first = deferred<unknown>()
    candidates
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        models: ['claude-sonnet'],
        sources: { 'claude-sonnet': ['allowlist'] }
      })
    const wrapper = mountDialog()
    await flushPromises()
    expect(candidates).toHaveBeenLastCalledWith(null, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(byTestId(wrapper, 'claudex-model-candidates-status').text()).toBe(
      'admin.claudexModels.editor.candidatesLoading'
    )

    await byTestId(wrapper, 'claudex-model-scope').setValue('4')
    await flushPromises()
    expect(candidates).toHaveBeenCalledTimes(2)
    expect(candidates.mock.calls[1][0]).toBe(4)
    expect(candidates.mock.calls[0][1].signal.aborted).toBe(true)

    first.resolve({ models: ['stale-model'], sources: {} })
    await flushPromises()
    const values = wrapper.findAll('[data-testid="claudex-model-candidates"] option').map((o) => o.attributes('value'))
    expect(values).toEqual(['claude-sonnet'])
  })

  it('says when suggestions failed and still saves a typed model', async () => {
    candidates.mockReset().mockRejectedValue(new Error('offline'))
    const wrapper = mountDialog()
    await flushPromises()
    expect(byTestId(wrapper, 'claudex-model-candidates-status').text()).toBe(
      'admin.claudexModels.editor.candidatesFailed'
    )
    await byTestId(wrapper, 'claudex-model-id').setValue('my-model')
    await submit(wrapper)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model_id: 'my-model', group_id: null }))
  })

  it('warns about a model that is not among the scope’s candidates', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await byTestId(wrapper, 'claudex-model-id').setValue('gpt-5.5')
    expect(wrapper.find('[data-testid="claudex-model-not-candidate"]').exists()).toBe(false)
    await byTestId(wrapper, 'claudex-model-id').setValue('gpt-9')
    expect(byTestId(wrapper, 'claudex-model-not-candidate').text()).toBe('admin.claudexModels.editor.notInCandidates')
  })

  it('does not save an invalid form and shows each problem', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-model-error-model_id"]').exists()).toBe(false)

    await byTestId(wrapper, 'claudex-model-display-name').setValue('x'.repeat(101))
    await byTestId(wrapper, 'claudex-model-usage-hint').setValue('y'.repeat(41))
    await byTestId(wrapper, 'claudex-model-context-window').setValue('1000')
    await byTestId(wrapper, 'claudex-model-auto-compact').setValue('1000')
    await byTestId(wrapper, 'claudex-model-efforts-unknown').setValue(false)
    await submit(wrapper)

    expect(create).not.toHaveBeenCalled()
    expect(byTestId(wrapper, 'claudex-model-error-model_id').text()).toBe(
      'admin.claudexModels.validation.modelRequired'
    )
    expect(byTestId(wrapper, 'claudex-model-error-display_name').text()).toBe(
      'admin.claudexModels.validation.tooLong{"max":100}'
    )
    expect(byTestId(wrapper, 'claudex-model-error-usage_hint').text()).toBe(
      'admin.claudexModels.validation.tooLong{"max":40}'
    )
    expect(byTestId(wrapper, 'claudex-model-error-auto_compact_tokens').text()).toBe(
      'admin.claudexModels.validation.autoCompactBelowContext'
    )
    expect(byTestId(wrapper, 'claudex-model-error-supported_efforts').text()).toBe(
      'admin.claudexModels.validation.effortsRequired'
    )
    expect(byTestId(wrapper, 'claudex-model-form-invalid').text()).toBe('admin.claudexModels.editor.fixProblems')
  })

  it('rejects a badge that does not match the badge pattern and a fourth badge', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const input = wrapper.get('[data-testid="claudex-model-badges"] [data-testid="claudex-tag-input"]')
    await input.setValue('new!')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('[data-testid="claudex-tag-error"]').text()).toBe('admin.claudexModels.validation.badgeFormat')
    for (const badge of ['new', 'beta', '2×', 'extra']) {
      await input.setValue(badge)
      await input.trigger('keydown', { key: 'Enter' })
    }
    const tags = wrapper.findAll('[data-testid="claudex-tag"]').map((tag) => tag.text())
    expect(tags).toEqual(['new', 'beta', '2×'])
  })

  it('creates an entry with the design body and emits saved', async () => {
    const wrapper = mountDialog({ defaultGroupId: 4 })
    await flushPromises()
    await byTestId(wrapper, 'claudex-model-id').setValue('  gpt-5.5 ')
    await byTestId(wrapper, 'claudex-model-display-name').setValue('GPT-5.5')
    await byTestId(wrapper, 'claudex-model-description').setValue('Our smartest model for complex work')
    const badgeInput = wrapper.get('[data-testid="claudex-model-badges"] [data-testid="claudex-tag-input"]')
    await badgeInput.setValue('new')
    await badgeInput.trigger('keydown', { key: 'Enter' })
    await byTestId(wrapper, 'claudex-model-sort').setValue('10')
    await byTestId(wrapper, 'claudex-model-default').setValue(true)
    await byTestId(wrapper, 'claudex-model-efforts-unknown').setValue(false)
    for (const effort of ['xhigh', 'low', 'medium', 'high']) {
      await byTestId(wrapper, `claudex-model-effort-${effort}`).setValue(true)
    }
    await byTestId(wrapper, 'claudex-model-default-effort').setValue('medium')
    await byTestId(wrapper, 'claudex-model-context-window').setValue('400000')
    await byTestId(wrapper, 'claudex-model-auto-compact').setValue('320000')
    await byTestId(wrapper, 'claudex-model-usage-hint').setValue('1.5× usage')
    await submit(wrapper)

    expect(create).toHaveBeenCalledWith({
      model_id: 'gpt-5.5',
      group_id: 4,
      display_name: 'GPT-5.5',
      description: 'Our smartest model for complex work',
      badges: ['new'],
      sort_order: 10,
      hidden: false,
      is_default: true,
      supported_efforts: ['low', 'medium', 'high', 'xhigh'],
      default_effort: 'medium',
      context_window: 400000,
      auto_compact_tokens: 320000,
      fast_tier: null,
      usage_hint: '1.5× usage'
    })
    expect(update).not.toHaveBeenCalled()
    // Fast mode was dropped (R6): the editor has no Fast field.
    expect(wrapper.find('[data-testid="claudex-model-fast"]').exists()).toBe(false)
    expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({ id: 11, model_id: 'gpt-5.5', is_default: true })
  })

  it('edits an entry with scope and model locked and sends them unchanged', async () => {
    const wrapper = mountDialog({ row })
    await flushPromises()
    expect(byTestId(wrapper, 'dialog-title').text()).toBe('admin.claudexModels.editor.editTitle')
    expect(byTestId(wrapper, 'claudex-model-scope').attributes('disabled')).toBeDefined()
    expect(byTestId(wrapper, 'claudex-model-id').attributes('disabled')).toBeDefined()
    expect((byTestId(wrapper, 'claudex-model-id').element as HTMLInputElement).value).toBe('gpt-5.5')
    expect(candidates.mock.calls[0][0]).toBe(4)

    await byTestId(wrapper, 'claudex-model-hidden').setValue(true)
    await byTestId(wrapper, 'claudex-model-effort-medium').setValue(false)
    // The default effort was medium and is no longer supported, so it is cleared.
    expect((byTestId(wrapper, 'claudex-model-default-effort').element as HTMLSelectElement).value).toBe('')
    await submit(wrapper)

    expect(update).toHaveBeenCalledTimes(1)
    const [id, body] = update.mock.calls[0]
    expect(id).toBe(7)
    expect(body).toMatchObject({
      model_id: 'gpt-5.5',
      group_id: 4,
      hidden: true,
      supported_efforts: ['low'],
      default_effort: '',
      fast_tier: true
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('saves through the page step-up controller (R13)', async () => {
    const run = vi.fn((action: () => Promise<unknown>) => action())
    const wrapper = mountDialog({ row, stepUp: { visible: { value: false }, blockedReason: { value: '' }, run } })
    await flushPromises()
    await submit(wrapper)
    expect(run).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('turns efforts off as not known and disables the default effort', async () => {
    const wrapper = mountDialog({ row })
    await flushPromises()
    await byTestId(wrapper, 'claudex-model-efforts-unknown').setValue(true)
    expect(byTestId(wrapper, 'claudex-model-effort-low').attributes('disabled')).toBeDefined()
    expect(byTestId(wrapper, 'claudex-model-default-effort').attributes('disabled')).toBeDefined()
    await submit(wrapper)
    expect(update.mock.calls[0][1]).toMatchObject({ supported_efforts: null, default_effort: '' })
  })

  it('warns when the group caps reasoning below a chosen effort', async () => {
    const wrapper = mountDialog({ row })
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-model-effort-ceiling"]').exists()).toBe(false)
    await byTestId(wrapper, 'claudex-model-effort-high').setValue(true)
    expect(byTestId(wrapper, 'claudex-model-effort-ceiling').text()).toBe(
      'admin.claudexModels.editor.effortCeiling{"max":"medium","efforts":"high"}'
    )
  })

  it('explains Hidden and links to channel pricing instead of editing prices', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(byTestId(wrapper, 'claudex-model-hidden-hint').text()).toBe('admin.claudexModels.editor.hiddenHint')
    expect(wrapper.get('[data-testid="claudex-model-pricing-note"] a').attributes('href')).toBe(
      '/admin/channels/pricing'
    )
  })

  it('marks the field the server rejected and shows the page’s message', async () => {
    knownKeys.add('admin.claudexModels.errors.CLAUDEX_MODEL_META_INVALID')
    update.mockRejectedValueOnce({
      status: 400,
      code: 400,
      reason: 'CLAUDEX_MODEL_META_INVALID',
      message: 'usage_hint is too long',
      metadata: { field: 'usage_hint' }
    })
    const wrapper = mountDialog({ row })
    await flushPromises()
    await submit(wrapper)

    expect(byTestId(wrapper, 'claudex-model-save-error').text()).toBe(
      'admin.claudexModels.errors.CLAUDEX_MODEL_META_INVALID'
    )
    expect(byTestId(wrapper, 'claudex-model-error-usage_hint').text()).toBe('admin.claudexModels.validation.server')
    expect(wrapper.emitted('saved')).toBeUndefined()

    // Changing the form clears the server's mark.
    await byTestId(wrapper, 'claudex-model-usage-hint').setValue('2× usage')
    expect(wrapper.find('[data-testid="claudex-model-error-usage_hint"]').exists()).toBe(false)
  })

  it('shows a scope conflict from the server', async () => {
    knownKeys.add('admin.claudexModels.errors.CLAUDEX_MODEL_META_CONFLICT')
    create.mockRejectedValueOnce({ status: 409, code: 409, reason: 'CLAUDEX_MODEL_META_CONFLICT', message: 'exists' })
    const wrapper = mountDialog()
    await flushPromises()
    await byTestId(wrapper, 'claudex-model-id').setValue('gpt-5.5')
    await submit(wrapper)
    expect(byTestId(wrapper, 'claudex-model-save-error').text()).toBe(
      'admin.claudexModels.errors.CLAUDEX_MODEL_META_CONFLICT'
    )
    expect(wrapper.emitted('saved')).toBeUndefined()
    // The page reloads so the conflicting entry (or the other default) shows.
    expect(wrapper.emitted('stale')).toHaveLength(1)
  })

  it('edits an entry of a deleted group, keeping its scope', async () => {
    const orphan = { ...row, group_id: 99, group_name: 'Gone', group_deleted: true }
    const wrapper = mountDialog({ row: orphan })
    await flushPromises()
    const scope = byTestId(wrapper, 'claudex-model-scope')
    expect((scope.element as HTMLSelectElement).value).toBe('99')
    expect(scope.findAll('option').map((o) => o.text())).toContain('admin.claudexModels.groupDeleted{"name":"Gone"}')
    await byTestId(wrapper, 'claudex-model-usage-hint').setValue('2× usage')
    await submit(wrapper)
    expect(wrapper.find('[data-testid="claudex-model-error-group_id"]').exists()).toBe(false)
    expect(update).toHaveBeenCalledWith(7, expect.objectContaining({ group_id: 99, usage_hint: '2× usage' }))
  })

  it('names every candidate source', async () => {
    candidates.mockReset().mockResolvedValue({
      models: ['m'],
      sources: { m: ['channel_mapping', 'group_pricing', 'something_new'] }
    })
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-model-candidates"] option').text()).toBe(
      'admin.claudexModels.sources.channelMapping, admin.claudexModels.sources.groupPricing, something_new'
    )
  })

  it('asks the page to reload when the chosen group was deleted meanwhile', async () => {
    create.mockRejectedValueOnce({ status: 400, code: 400, reason: 'CLAUDEX_GROUP_NOT_FOUND', message: 'no group' })
    const wrapper = mountDialog()
    await flushPromises()
    await byTestId(wrapper, 'claudex-model-id').setValue('gpt-5.5')
    await submit(wrapper)
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.emitted('stale')).toHaveLength(1)
  })

  it('asks the page to reload when the entry was deleted meanwhile', async () => {
    update.mockRejectedValueOnce({ status: 404, code: 404, reason: 'CLAUDEX_MODEL_META_NOT_FOUND', message: 'gone' })
    const wrapper = mountDialog({ row })
    await flushPromises()
    await submit(wrapper)
    expect(wrapper.emitted('stale')).toHaveLength(1)
    expect(byTestId(wrapper, 'claudex-model-save-error').text()).toBe('gone')
  })

  it('starts over each time it opens', async () => {
    const wrapper = mountDialog({ show: false })
    await flushPromises()
    expect(candidates).not.toHaveBeenCalled()
    await wrapper.setProps({ show: true })
    await flushPromises()
    await byTestId(wrapper, 'claudex-model-id').setValue('draft')
    await submit(wrapper)
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true, row })
    await flushPromises()
    expect((byTestId(wrapper, 'claudex-model-id').element as HTMLInputElement).value).toBe('gpt-5.5')
    expect(candidates).toHaveBeenCalledTimes(2)
  })

  it('closes on cancel', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await byTestId(wrapper, 'dialog-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

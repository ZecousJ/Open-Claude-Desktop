// CLAUDEX: tests for the client policy console page (/admin/claudex/policy):
// revision-aware save through step-up, 409 reload, inherit semantics in the
// submitted body, no Bypass anywhere in it, overrides, preview, i18n parity.
import { defineComponent, h, type PropType } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ClaudexPolicyView from '../ClaudexPolicyView.vue'
import enPolicy from '@/i18n/locales/en/admin/claudexPolicy'
import zhPolicy from '@/i18n/locales/zh/admin/claudexPolicy'
import type { StepUpController } from '@/composables/useStepUp'

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), preview: vi.fn() }))
const groupsApi = vi.hoisted(() => ({ getAllIncludingInactive: vi.fn() }))
const usersApi = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('@/api/admin/claudex/policy', () => api)
vi.mock('@/api/admin/groups', () => groupsApi)
vi.mock('@/api/admin/users', () => usersApi)
vi.mock('@/utils/format', () => ({ formatDateTime: (value: string) => `formatted(${value})` }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length ? `${key}${JSON.stringify(params)}` : key,
    te: (key: string) => key.startsWith('admin.claudexPolicy.errors.')
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

// The real dialog talks to the TOTP API; this one verifies on click.
vi.mock('@/components/auth/TotpStepUpDialog.vue', () => ({
  default: defineComponent({
    name: 'TotpStepUpDialog',
    props: { controller: { type: Object as PropType<StepUpController>, required: true } },
    setup(props) {
      return () =>
        props.controller.visible.value
          ? h('button', { 'data-testid': 'step-up-verify', onClick: () => props.controller.onVerified() }, 'verify')
          : null
    }
  })
}))

// A plain <select> instead of the teleported dropdown.
vi.mock('@/components/common/Select.vue', () => ({
  default: defineComponent({
    name: 'SelectStub',
    props: {
      modelValue: { type: [String, Number, Boolean, null] as PropType<unknown>, default: null },
      options: { type: Array as PropType<Array<{ value: unknown; label: string }>>, default: () => [] }
    },
    emits: ['update:modelValue', 'change'],
    setup(props, { emit, attrs }) {
      return () =>
        h(
          'select',
          {
            'data-testid': attrs['data-testid'],
            onChange: (event: Event) => {
              const index = Number((event.target as HTMLSelectElement).value)
              const option = props.options[index] ?? null
              emit('update:modelValue', option?.value ?? null)
              emit('change', option?.value ?? null, option)
            }
          },
          props.options.map((option, index) => h('option', { value: String(index) }, option.label))
        )
    }
  })
}))

const savedPolicy = () => ({
  revision: 17,
  updated_at: '2026-09-26T02:00:00Z',
  updated_by: 1,
  defaults: {
    web_search_default: false,
    usage_banner: { warn_percent: 80 },
    // Not valid on the server; must never be sent back.
    permission_modes: ['auto', 'manual', 'acceptEdits', 'plan', 'bypass']
  },
  group_overrides: [{ group_id: 4, group_name: 'claudex-pro', patch: { plan_label: 'Max', voice: false } }],
  user_overrides: [
    { user_id: 123, email: 'a' + String.fromCharCode(64) + 'example.com', patch: { external_links: false } }
  ],
  builtin: null,
  fallbacks: { doc_url: 'https://docs.example.com', purchase_subscription_url: 'https://claudex.example.com/plans' }
})

const groups = [
  { id: 3, name: 'claudex-basic', platform: 'openai', status: 'active' },
  { id: 4, name: 'claudex-pro', platform: 'anthropic', status: 'active' }
]

function mountView() {
  return mount(ClaudexPolicyView, { global: { stubs: { teleport: true } }, attachTo: document.body })
}

/** Every key and every string value in a JSON value, at any depth. */
function everyKeyAndString(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => everyKeyAndString(entry, out))
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key)
      everyKeyAndString(child, out)
    }
  }
  return out
}

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key)
  )
}

async function uninherit(wrapper: VueWrapper, key: string) {
  await wrapper.get(`[data-testid="policy-item-${key}"] [data-testid="policy-inherit"]`).setValue(false)
  await flushPromises()
}

async function clickSave(wrapper: VueWrapper) {
  await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
  await flushPromises()
}

describe('ClaudexPolicyView', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    api.get.mockReset().mockResolvedValue(savedPolicy())
    api.update.mockReset()
    api.preview.mockReset()
    groupsApi.getAllIncludingInactive.mockReset().mockResolvedValue(groups)
    usersApi.list.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 10, pages: 0 })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('loads the policy and shows its revision; nothing is dirty yet', async () => {
    wrapper = mountView()
    await flushPromises()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="policy-revision"]').text()).toContain(
      'admin.claudexPolicy.revision{"revision":17}'
    )
    expect(wrapper.find('[data-testid="policy-patch-editor"]').attributes('data-mode')).toBe('defaults')
    expect(wrapper.find('[data-testid="claudex-save-status"]').exists()).toBe(false)
  })

  it('saves through step-up with the loaded revision, leaving inherited fields out and never sending bypass', async () => {
    api.update.mockRejectedValueOnce({ status: 403, code: 'STEP_UP_REQUIRED', message: 'step up' })
    api.update.mockImplementationOnce(async (body) => ({ ...savedPolicy(), ...body, revision: 18 }))
    wrapper = mountView()
    await flushPromises()

    await uninherit(wrapper, 'incognito')
    await wrapper.get('[data-testid="policy-item-incognito"] button[role="switch"]').trigger('click')
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.unsavedChanges')

    await clickSave(wrapper)
    // The first attempt asked for step-up; the dialog is open and nothing is saved yet.
    expect(api.update).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-testid="step-up-verify"]').trigger('click')
    await flushPromises()
    expect(api.update).toHaveBeenCalledTimes(2)

    const body = api.update.mock.calls[1][0]
    expect(body).toEqual(api.update.mock.calls[0][0])
    expect(body.revision).toBe(17)
    expect(body.defaults).toEqual({
      permission_modes: ['auto', 'manual', 'acceptEdits', 'plan'],
      incognito: false,
      web_search_default: false,
      usage_banner: { warn_percent: 80 }
    })
    expect(body.group_overrides).toEqual([{ group_id: 4, patch: { plan_label: 'Max', voice: false } }])
    expect(body.user_overrides).toEqual([{ user_id: 123, patch: { external_links: false } }])
    expect(everyKeyAndString(body).filter((entry) => /bypass/i.test(entry))).toEqual([])

    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.saved')
    expect(wrapper.get('[data-testid="policy-revision"]').text()).toContain('{"revision":18}')
  })

  it('does not save when the step-up prompt is cancelled', async () => {
    api.update.mockRejectedValueOnce({ status: 403, code: 'STEP_UP_REQUIRED' })
    wrapper = mountView()
    await flushPromises()
    await uninherit(wrapper, 'voice')
    await clickSave(wrapper)
    expect(wrapper.find('[data-testid="step-up-verify"]').exists()).toBe(true)
    const view = wrapper.findComponent({ name: 'TotpStepUpDialog' })
    ;(view.props('controller') as StepUpController).onCancel()
    await flushPromises()
    expect(api.update).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="claudex-save-error"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.unsavedChanges')
  })

  it('on 409 says someone else changed the policy and reloads on request', async () => {
    api.update.mockRejectedValueOnce({
      status: 409,
      code: 409,
      reason: 'CLAUDEX_POLICY_REVISION_CONFLICT',
      message: 'revision mismatch',
      metadata: { current_revision: 18 }
    })
    wrapper = mountView()
    await flushPromises()
    await uninherit(wrapper, 'voice')
    await clickSave(wrapper)

    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe(
      'admin.claudexPolicy.errors.CLAUDEX_POLICY_REVISION_CONFLICT'
    )
    api.get.mockResolvedValueOnce({ ...savedPolicy(), revision: 18, defaults: { voice: false } })
    await wrapper.get('[data-testid="policy-conflict-reload"]').trigger('click')
    await flushPromises()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="claudex-save-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="policy-conflict-reload"]').exists()).toBe(false)

    // The next save starts from the reloaded revision.
    api.update.mockResolvedValueOnce({ ...savedPolicy(), revision: 19 })
    await uninherit(wrapper, 'incognito')
    await clickSave(wrapper)
    expect(api.update.mock.calls.at(-1)?.[0].revision).toBe(18)
    expect(api.update.mock.calls.at(-1)?.[0].defaults).toEqual({ voice: false, incognito: true })
  })

  it('shows which field the server rejected', async () => {
    api.update.mockRejectedValueOnce({
      status: 400,
      code: 400,
      reason: 'CLAUDEX_POLICY_INVALID',
      message: 'invalid',
      metadata: { field: 'group_overrides.4.permission_modes.win32', rule: 'empty_mode_list' }
    })
    wrapper = mountView()
    await flushPromises()
    await uninherit(wrapper, 'voice')
    await clickSave(wrapper)
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe(
      'admin.claudexPolicy.errors.CLAUDEX_POLICY_INVALID'
    )
    expect(wrapper.get('[data-testid="policy-server-field"]').text()).toContain(
      'group_overrides.4.permission_modes.win32'
    )
  })

  it('does not send an invalid policy', async () => {
    wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-testid="policy-warn-percent"]').setValue('100')
    await clickSave(wrapper)
    expect(api.update).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe('admin.claudexPolicy.validationFailed')
    expect(wrapper.get('[data-testid="policy-tab-defaults"]').text()).toContain('admin.claudexPolicy.issuesBadge')
  })

  it('reload asks before discarding unsaved changes', async () => {
    wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-testid="policy-reload"]').trigger('click')
    await flushPromises()
    expect(api.get).toHaveBeenCalledTimes(2)

    await uninherit(wrapper, 'voice')
    await wrapper.get('[data-testid="policy-reload"]').trigger('click')
    await flushPromises()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('admin.claudexPolicy.reloadConfirmTitle')
  })

  it('adds a plan override from the dialog and saves only what it sets', async () => {
    api.update.mockResolvedValueOnce({ ...savedPolicy(), revision: 18 })
    wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-testid="policy-tab-plans"]').trigger('click')
    expect(wrapper.get('[data-testid="policy-plans"]').text()).toContain('claudex-pro')

    await wrapper.get('[data-testid="policy-add-plan"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.get('[data-testid="policy-override-dialog"]')
    // Only groups without an override can be chosen.
    const options = dialog.findAll('[data-testid="policy-group-select"] option').map((option) => option.text())
    expect(options).toEqual(['claudex-basic'])

    await wrapper.get('[data-testid="policy-dialog-apply"]').trigger('click')
    expect(wrapper.get('[data-testid="policy-dialog-error"]').text()).toBe('admin.claudexPolicy.dialog.chooseFirst')

    await dialog.get('[data-testid="policy-group-select"]').setValue('0')
    await uninherit(wrapper, 'plan_label')
    await wrapper.get('[data-testid="policy-dialog-apply"]').trigger('click')
    // An empty plan label is not valid.
    expect(wrapper.get('[data-testid="policy-dialog-error"]').text()).toBe('admin.claudexPolicy.dialog.fixErrors')
    await wrapper.get('[data-testid="policy-plan-label"]').setValue('Basic')
    await wrapper.get('[data-testid="policy-dialog-apply"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="policy-override-dialog"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="policy-plans"]').text()).toContain('claudex-basic')

    await clickSave(wrapper)
    const body = api.update.mock.calls[0][0]
    expect(body.group_overrides).toEqual([
      { group_id: 4, patch: { plan_label: 'Max', voice: false } },
      { group_id: 3, patch: { plan_label: 'Basic' } }
    ])
  })

  it('edits and removes a user override', async () => {
    api.update.mockResolvedValueOnce({ ...savedPolicy(), revision: 18 })
    wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-testid="policy-tab-users"]').trigger('click')
    await wrapper.get('[data-testid="policy-edit-user-123"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="policy-patch-editor"]').attributes('data-mode')).toBe('user')
    await wrapper.get('[data-testid="policy-item-external_links"] [data-testid="policy-inherit"]').setValue(true)
    await flushPromises()
    await wrapper.get('[data-testid="policy-dialog-apply"]').trigger('click')
    await flushPromises()
    await clickSave(wrapper)
    expect(api.update.mock.calls[0][0].user_overrides).toEqual([{ user_id: 123, patch: {} }])

    await wrapper.get('[data-testid="policy-remove-user-123"]').trigger('click')
    api.update.mockResolvedValueOnce({ ...savedPolicy(), user_overrides: [], revision: 19 })
    await clickSave(wrapper)
    expect(api.update.mock.calls[1][0].user_overrides).toEqual([])
  })

  it('previews with the unsaved draft when there are changes', async () => {
    api.preview.mockResolvedValue({
      policy: {
        revision: 17,
        group_id: 4,
        permission_modes: ['auto', 'plan'],
        incognito: true,
        web_search: true,
        web_search_default: false,
        voice: false,
        local_mcp_editing: true,
        remote_images: true,
        remote_image_domains: null,
        external_links: true,
        trusted_link_domains: [],
        connectors: [{ name: 'github', url_prefix: 'https://api.githubcopilot.com/mcp' }],
        attachments: { max_bytes: 10485760, types: ['png', 'txt'] },
        links: {
          help: 'https://docs.example.com',
          plans: null,
          apps: null,
          get_more_usage: null,
          usage_learn_more: null,
          learn_more: []
        },
        usage_banner: { warn_percent: 80 },
        plan_label: 'Max',
        scheduled_tasks: { enabled: true, max_tasks: null },
        approvals_always_allow: true
      }
    })
    wrapper = mountView()
    await flushPromises()
    await uninherit(wrapper, 'voice')
    await wrapper.get('[data-testid="policy-tab-preview"]').trigger('click')
    await wrapper.get('[data-testid="policy-preview-platform"]').setValue('win32')
    await wrapper.get('[data-testid="policy-preview-run"]').trigger('click')
    await flushPromises()

    const request = api.preview.mock.calls[0][0]
    expect(request.platform).toBe('win32')
    expect(request.group_id).toBeNull()
    expect(request.user_id).toBeNull()
    expect(request.draft.revision).toBe(17)
    expect(request.draft.defaults.voice).toBe(true)
    const result = wrapper.get('[data-testid="policy-preview-result"]').text()
    expect(result).toContain('claudex-pro (#4)')
    expect(result).toContain('10 MB')
    expect(result).toContain('github')
    expect(wrapper.get('[data-testid="policy-preview-row-bypass"]').text()).toContain(
      'admin.claudexPolicy.preview.bypassValue'
    )

    // Without the draft, the saved policy is previewed.
    await wrapper.get('[data-testid="policy-preview-draft"]').setValue(false)
    await wrapper.get('[data-testid="policy-preview-run"]').trigger('click')
    await flushPromises()
    expect(api.preview.mock.calls[1][0].draft).toBeNull()
  })

  it('shows a load error with retry', async () => {
    api.get.mockRejectedValueOnce({ status: 500, message: 'boom' })
    wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-testid="claudex-page-load-error"]').text()).toContain('boom')
    await wrapper.get('[data-testid="claudex-page-load-error"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="policy-patch-editor"]').exists()).toBe(true)
  })
})

describe('claudexPolicy locales', () => {
  it('have the same keys in English and Chinese, none empty', () => {
    const en = leafKeys(enPolicy).sort()
    const zh = leafKeys(zhPolicy).sort()
    expect(zh).toEqual(en)
    const values = (messages: unknown, keys: string[]) =>
      keys.map((key) =>
        key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages)
      )
    for (const value of [...values(enPolicy, en), ...values(zhPolicy, zh)]) {
      expect(typeof value === 'string' && value.trim().length > 0).toBe(true)
    }
  })

  it('carries the fixed Bypass note and the 409 message from the design', () => {
    expect(enPolicy.claudexPolicy.editor.bypassNote).toBe(
      'Bypass permissions is always up to each user and can’t be turned off here.'
    )
    expect(enPolicy.claudexPolicy.errors.CLAUDEX_POLICY_REVISION_CONFLICT).toBe(
      'Someone else changed the policy. Reload to see their changes.'
    )
  })
})

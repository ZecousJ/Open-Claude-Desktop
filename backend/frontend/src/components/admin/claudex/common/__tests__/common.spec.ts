// CLAUDEX: tests for the shared Claudex console pieces (components/admin/claudex/common)
// and the console page stubs built on them.
import { defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import ClaudexPageShell from '../ClaudexPageShell.vue'
import SaveBar from '../SaveBar.vue'
import TagInput from '../TagInput.vue'
import UrlInput from '../UrlInput.vue'
import { claudexErrorMessage, claudexErrorReason } from '../errors'
import { useClaudexSave } from '../useClaudexSave'
import { validateHttpsUrl } from '../validation'
import { StepUpCancelledError } from '@/composables/useStepUp'
import en from '@/i18n/locales/en'

const KNOWN_KEYS = vi.hoisted(
  () =>
    new Set([
      'admin.claudexPolicy.errors.CLAUDEX_POLICY_REVISION_CONFLICT',
      'admin.claudex.errors.CLAUDEX_GROUP_NOT_FOUND'
    ])
)

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: (key: string) => KNOWN_KEYS.has(key)
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

const t = (key: string) => key
const te = (key: string) => KNOWN_KEYS.has(key)

describe('validateHttpsUrl', () => {
  it.each([
    ['', null],
    ['   ', null],
    ['https://example.com', null],
    ['https://example.com/docs?x=1#y', null],
    ['http://example.com', 'https'],
    ['ftp://example.com', 'https'],
    ['example.com', 'https'],
    ['https://', 'https'],
    ['https://user:pass@example.com', 'https'],
    ['https://exa mple.com', 'https'],
    ['javascript:alert(1)', 'https']
  ])('%j -> %j', (value, problem) => {
    expect(validateHttpsUrl(value)).toBe(problem)
  })

  it('checks required and the length limit', () => {
    expect(validateHttpsUrl('', { required: true })).toBe('required')
    expect(validateHttpsUrl(`https://example.com/${'a'.repeat(2000)}`)).toBe('tooLong')
    expect(validateHttpsUrl('https://example.com/abc', { maxLength: 10 })).toBe('tooLong')
  })
})

describe('claudexErrorMessage', () => {
  it('prefers the page text, then the shared text, then the server message', () => {
    const conflict = { status: 409, reason: 'CLAUDEX_POLICY_REVISION_CONFLICT', message: 'revision mismatch' }
    expect(claudexErrorMessage(conflict, t, te, 'claudexPolicy', 'fallback')).toBe(
      'admin.claudexPolicy.errors.CLAUDEX_POLICY_REVISION_CONFLICT'
    )
    const group = { status: 400, reason: 'CLAUDEX_GROUP_NOT_FOUND', message: 'group 7 not found' }
    expect(claudexErrorMessage(group, t, te, 'claudexPolicy', 'fallback')).toBe('admin.claudex.errors.CLAUDEX_GROUP_NOT_FOUND')
    const unknown = { status: 400, reason: 'CLAUDEX_SOMETHING_NEW', message: 'server says why' }
    expect(claudexErrorMessage(unknown, t, te, 'claudexPolicy', 'fallback')).toBe('server says why')
    expect(claudexErrorMessage({ status: 500 }, t, te, null, 'fallback')).toBe('fallback')
  })

  it('reads only CLAUDEX_* reasons', () => {
    expect(claudexErrorReason({ reason: 'CLAUDEX_POLICY_INVALID' })).toBe('CLAUDEX_POLICY_INVALID')
    expect(claudexErrorReason({ code: 'ADMIN_COMPLIANCE_ACK_REQUIRED' })).toBeUndefined()
    expect(claudexErrorReason(null)).toBeUndefined()
  })
})

describe('useClaudexSave', () => {
  function harness() {
    let api!: ReturnType<typeof useClaudexSave>
    mount(
      defineComponent({
        setup() {
          api = useClaudexSave('claudexPolicy')
          return () => h('div')
        }
      })
    )
    return api
  }

  it('reports success', async () => {
    const save = harness()
    const result = await save.run(async () => 42)
    expect(result).toEqual({ ok: true, value: 42 })
    expect(save.saved.value).toBe(true)
    expect(save.saving.value).toBe(false)
    expect(save.error.value).toBeNull()
  })

  it('maps a failure to the page message and keeps the reason', async () => {
    const save = harness()
    const result = await save.run(async () => {
      throw { status: 409, reason: 'CLAUDEX_POLICY_REVISION_CONFLICT', message: 'conflict' }
    })
    expect(result).toEqual({ ok: false, cancelled: false })
    expect(save.error.value).toBe('admin.claudexPolicy.errors.CLAUDEX_POLICY_REVISION_CONFLICT')
    expect(save.reason.value).toBe('CLAUDEX_POLICY_REVISION_CONFLICT')
    expect(save.saved.value).toBe(false)
  })

  it('treats a cancelled step-up prompt as no error', async () => {
    const save = harness()
    const result = await save.run(async () => {
      throw new StepUpCancelledError()
    })
    expect(result).toEqual({ ok: false, cancelled: true })
    expect(save.error.value).toBeNull()
  })

  it('shows the saving state while the request runs', async () => {
    const save = harness()
    let finish!: () => void
    const pending = save.run(() => new Promise<void>((resolve) => (finish = resolve)))
    expect(save.saving.value).toBe(true)
    finish()
    await pending
    expect(save.saving.value).toBe(false)
  })
})

describe('SaveBar', () => {
  it('shows the status and emits save', async () => {
    const wrapper = mount(SaveBar, { props: { dirty: true }, global: { stubs: { Icon: true } } })
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.unsavedChanges')
    await wrapper.get('[data-testid="claudex-save-button"]').trigger('click')
    expect(wrapper.emitted('save')).toHaveLength(1)

    await wrapper.setProps({ dirty: false, saved: true })
    expect(wrapper.get('[data-testid="claudex-save-status"]').text()).toBe('admin.claudex.common.saved')

    await wrapper.setProps({ error: 'Could not save' })
    expect(wrapper.get('[data-testid="claudex-save-error"]').text()).toBe('Could not save')
  })

  it('disables the button while saving', async () => {
    const wrapper = mount(SaveBar, { props: { saving: true }, global: { stubs: { Icon: true } } })
    const button = wrapper.get('[data-testid="claudex-save-button"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.text()).toContain('admin.claudex.common.saving')
    await button.trigger('click')
    expect(wrapper.emitted('save')).toBeUndefined()
  })
})

describe('UrlInput', () => {
  it('emits the typed value and shows a problem after leaving the field', async () => {
    const wrapper = mount(UrlInput, { props: { modelValue: 'http://example.com', label: 'Help link' } })
    expect(wrapper.find('[data-testid="claudex-url-error"]').exists()).toBe(false)
    await wrapper.get('input').trigger('blur')
    expect(wrapper.get('[data-testid="claudex-url-error"]').text()).toBe('admin.claudex.common.https')
    expect(wrapper.get('input').attributes('aria-invalid')).toBe('true')

    await wrapper.get('input').setValue('https://example.com')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['https://example.com'])
    await wrapper.setProps({ modelValue: 'https://example.com' })
    expect(wrapper.find('[data-testid="claudex-url-error"]').exists()).toBe(false)
  })

  it('shows problems at once when asked, including a missing required value', () => {
    const wrapper = mount(UrlInput, { props: { modelValue: '', required: true, showError: true } })
    expect(wrapper.get('[data-testid="claudex-url-error"]').text()).toBe('admin.claudex.common.required')
  })
})

describe('TagInput', () => {
  function mountTags(initial: string[], props: Record<string, unknown> = {}) {
    const model = ref([...initial])
    const wrapper = mount(
      defineComponent({
        setup() {
          return () =>
            h(TagInput, {
              ...props,
              modelValue: model.value,
              'onUpdate:modelValue': (value: string[]) => (model.value = value)
            })
        }
      }),
      { global: { stubs: { Icon: true } } }
    )
    return { wrapper, model }
  }

  it('adds on Enter and on a pasted comma list, and removes chips', async () => {
    const { wrapper, model } = mountTags(['a.example.com'])
    const input = wrapper.get('[data-testid="claudex-tag-input"]')
    await input.setValue('b.example.com')
    await input.trigger('keydown', { key: 'Enter' })
    expect(model.value).toEqual(['a.example.com', 'b.example.com'])
    expect((input.element as HTMLInputElement).value).toBe('')

    await input.setValue('c.example.com, d.example.com')
    await input.trigger('blur')
    expect(model.value).toEqual(['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com'])

    await wrapper.findAll('[data-testid="claudex-tag-remove"]')[0].trigger('click')
    expect(model.value).toEqual(['b.example.com', 'c.example.com', 'd.example.com'])

    await input.trigger('keydown', { key: 'Backspace' })
    expect(model.value).toEqual(['b.example.com', 'c.example.com'])
  })

  it('rejects duplicates, values over the limit and invalid values', async () => {
    const { wrapper, model } = mountTags(['Alpha'], {
      max: 2,
      caseInsensitive: true,
      validate: (value: string) => (value.includes(' ') ? 'admin.claudex.common.required' : null)
    })
    const input = wrapper.get('[data-testid="claudex-tag-input"]')

    await input.setValue('alpha')
    await input.trigger('keydown', { key: 'Enter' })
    expect(model.value).toEqual(['Alpha'])
    expect(wrapper.get('[data-testid="claudex-tag-error"]').text()).toBe('admin.claudex.common.tags.duplicate')
    expect((input.element as HTMLInputElement).value).toBe('alpha')

    await input.setValue('two words')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('[data-testid="claudex-tag-error"]').text()).toBe('admin.claudex.common.required')

    await input.setValue('beta, gamma')
    await input.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(model.value).toEqual(['Alpha', 'beta'])
    expect(wrapper.get('[data-testid="claudex-tag-error"]').text()).toBe('admin.claudex.common.tags.limit{"max":2}')
    expect((input.element as HTMLInputElement).value).toBe('gamma')
  })
})

describe('ClaudexPageShell', () => {
  it('shows the title, the content and the save row', () => {
    const wrapper = mount(ClaudexPageShell, {
      props: { title: 'Client policy', description: 'What the app follows' },
      slots: { default: '<p data-testid="content">form</p>', footer: '<p data-testid="footer">save</p>' },
      global: { stubs: { Icon: true } }
    })
    expect(wrapper.find('h2').text()).toBe('Client policy')
    expect(wrapper.text()).toContain('What the app follows')
    expect(wrapper.find('[data-testid="content"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="footer"]').exists()).toBe(true)
  })

  it('shows a spinner while loading and a retry after a failed load', async () => {
    const wrapper = mount(ClaudexPageShell, {
      props: { title: 'Devices', loading: true },
      slots: { default: '<p data-testid="content">form</p>' },
      global: { stubs: { Icon: true } }
    })
    expect(wrapper.find('[data-testid="claudex-page-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="content"]').exists()).toBe(false)

    await wrapper.setProps({ loading: false, loadError: 'Network error' })
    expect(wrapper.get('[data-testid="claudex-page-load-error"]').text()).toContain('Network error')
    await wrapper.get('[data-testid="claudex-page-load-error"] button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })
})

describe('Claudex console page stubs', () => {
  const views = import.meta.glob<{ default: unknown }>('../../../../../views/admin/claudex/Claudex*View.vue')
  const pages = Object.keys(views).filter((path) => !path.endsWith('ClaudexOverviewView.vue'))
  // CLAUDEX(K4, cross-package): pages that K1-K4 have implemented are covered by
  // their own specs; only the pages that are still K0 stubs are checked here.
  const sources = import.meta.glob<string>('../../../../../views/admin/claudex/Claudex*View.vue', {
    query: '?raw',
    import: 'default',
    eager: true
  })
  // CLAUDEX(B-S): round 2 adds the Sharing page (stub from the backend seam).
  const stubs = pages.filter(
    (path) =>
      sources[path]?.includes('Stub from the console skeleton (K0)') ||
      sources[path]?.includes('Stub from the backend seam (B-S)')
  )

  it('covers the fourteen console pages', () => {
    expect(pages).toHaveLength(14)
  })

  if (stubs.length > 0) it.each(stubs)(
    '%s shows its title and says the page is not in this build',
    async (path) => {
      const component = (await views[path]()).default
      const wrapper = mount(component as never, { global: { stubs: { Icon: true } } })
      await flushPromises()
      const title = wrapper.find('h2').text()
      expect(title).toMatch(/^admin\.claudex[A-Z]\w+\.title$/)
      const page = title.split('.')[1]
      expect((en.admin as Record<string, { title?: string }>)[page]?.title, page).toBeTruthy()
      expect(wrapper.find('[data-testid="claudex-unavailable"]').text()).toContain('admin.claudex.common.notAvailable')
      expect(wrapper.find('form').exists()).toBe(false)
      expect(wrapper.find('input').exists()).toBe(false)
    }
  )
})

// CLAUDEX R13: creating an API key for a user from the devices page. The key
// is created through step-up, its plaintext is shown once, and names in the
// device key namespace are refused before anything is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import CreateUserKeyDialog from '../CreateUserKeyDialog.vue'

const createUserKey = vi.hoisted(() => vi.fn())
const copyToClipboard = vi.hoisted(() => vi.fn())

vi.mock('@/api/admin/claudex/devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/admin/claudex/devices')>()),
  createUserKey
}))
vi.mock('@/composables/useClipboard', async () => {
  const vue = await import('vue')
  return { useClipboard: () => ({ copied: vue.ref(false), copyToClipboard }) }
})
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    te: () => false
  })
}))

const BaseDialogStub = defineComponent({
  props: { show: Boolean, title: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () =>
      props.show
        ? h('div', { 'data-testid': 'dialog' }, [
            h('h3', { 'data-testid': 'dialog-title' }, props.title),
            slots.default?.(),
            h('footer', slots.footer?.())
          ])
        : null
  }
})

const created = {
  id: 128,
  name: 'CI deploy',
  key: 'sk-0f4c2d9a7b1e4c58a3d6e2f190b7c4a1',
  group_id: 4,
  status: 'active',
  quota: 25,
  expires_at: '2026-12-25T04:00:00Z',
  created_at: '2026-09-26T04:00:00Z'
}

const groups = [
  { id: 4, name: 'claudex-pro', status: 'active' },
  { id: 5, name: 'retired', status: 'inactive' }
]

const wrappers: VueWrapper[] = []

function mountDialog(run = vi.fn((action: () => Promise<unknown>) => action())) {
  const wrapper = mount(CreateUserKeyDialog, {
    attachTo: document.body,
    props: {
      show: true,
      user: { id: 123, email: 'a@example.com' },
      groups,
      stepUp: { visible: { value: false }, blockedReason: { value: '' }, run }
    } as never,
    global: { stubs: { BaseDialog: BaseDialogStub } }
  })
  wrappers.push(wrapper)
  return { wrapper, run }
}

const byTestId = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-testid="${id}"]`)

async function submit(wrapper: VueWrapper) {
  await byTestId(wrapper, 'claudex-user-key-form').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  createUserKey.mockReset().mockResolvedValue(created)
  copyToClipboard.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

describe('CreateUserKeyDialog', () => {
  it('checks the form before sending anything', async () => {
    const { wrapper, run } = mountDialog()
    await submit(wrapper)
    expect(wrapper.text()).toContain('admin.claudexDevices.userKeys.validation.nameRequired')

    await byTestId(wrapper, 'claudex-user-key-name').setValue('  Claudex-Device:abc ')
    await submit(wrapper)
    expect(wrapper.text()).toContain('admin.claudexDevices.userKeys.validation.nameReserved')

    await byTestId(wrapper, 'claudex-user-key-name').setValue('CI deploy')
    await byTestId(wrapper, 'claudex-user-key-expires').setValue('0')
    await byTestId(wrapper, 'claudex-user-key-quota').setValue('-1')
    await submit(wrapper)
    expect(wrapper.text()).toContain('admin.claudexDevices.validation.expiresInDays')
    expect(wrapper.text()).toContain('admin.claudexDevices.validation.usd')
    expect(run).not.toHaveBeenCalled()
    expect(createUserKey).not.toHaveBeenCalled()
  })

  it('lists only active groups', () => {
    const { wrapper } = mountDialog()
    const options = byTestId(wrapper, 'claudex-user-key-group')
      .findAll('option')
      .map((option) => option.text())
    expect(options).toEqual(['admin.claudexDevices.userKeys.create.noGroup', 'claudex-pro'])
  })

  it('creates the key through step-up and shows the plaintext once', async () => {
    const { wrapper, run } = mountDialog()
    await byTestId(wrapper, 'claudex-user-key-name').setValue(' CI deploy ')
    await byTestId(wrapper, 'claudex-user-key-group').setValue('4')
    await byTestId(wrapper, 'claudex-user-key-quota').setValue('25')
    await byTestId(wrapper, 'claudex-user-key-expires').setValue('90')
    await byTestId(wrapper, 'claudex-user-key-ips').setValue('203.0.113.0/24\n\n 198.51.100.7 ')
    await submit(wrapper)

    expect(run).toHaveBeenCalledTimes(1)
    expect(createUserKey).toHaveBeenCalledWith(123, {
      name: 'CI deploy',
      group_id: 4,
      quota: 25,
      expires_in_days: 90,
      ip_whitelist: ['203.0.113.0/24', '198.51.100.7']
    })
    expect(wrapper.emitted('created')?.[0]?.[0]).toEqual(created)
    const plaintext = byTestId(wrapper, 'claudex-user-key-plaintext').element as HTMLInputElement
    expect(plaintext.value).toBe(created.key)
    expect(plaintext.readOnly).toBe(true)
    expect(wrapper.text()).toContain('admin.claudexDevices.userKeys.create.onceNotice')

    await byTestId(wrapper, 'claudex-user-key-copy').trigger('click')
    expect(copyToClipboard).toHaveBeenCalledWith(created.key, 'admin.claudexDevices.userKeys.create.copiedToast')

    await byTestId(wrapper, 'claudex-user-key-done').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    // The parent closes and later reopens the dialog: the key is gone.
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true })
    expect(wrapper.find('[data-testid="claudex-user-key-plaintext"]').exists()).toBe(false)
    expect(wrapper.html()).not.toContain(created.key)
    expect(byTestId(wrapper, 'claudex-user-key-form').exists()).toBe(true)
  })

  it('sends empty fields as no group, no quota and no expiry', async () => {
    const { wrapper } = mountDialog()
    await byTestId(wrapper, 'claudex-user-key-name').setValue('script')
    await byTestId(wrapper, 'claudex-user-key-quota').setValue('')
    await submit(wrapper)
    expect(createUserKey).toHaveBeenCalledWith(123, {
      name: 'script',
      group_id: null,
      quota: 0,
      expires_in_days: null,
      ip_whitelist: []
    })
  })

  it('shows a server refusal and keeps the form', async () => {
    createUserKey.mockRejectedValueOnce({ status: 400, reason: 'CLAUDEX_GROUP_NOT_ALLOWED', message: 'nope' })
    const { wrapper } = mountDialog()
    await byTestId(wrapper, 'claudex-user-key-name').setValue('script')
    await submit(wrapper)
    expect(byTestId(wrapper, 'claudex-user-key-error').exists()).toBe(true)
    expect(wrapper.find('[data-testid="claudex-user-key-plaintext"]').exists()).toBe(false)
    expect(wrapper.emitted('created')).toBeUndefined()
  })

  it('treats a dismissed step-up prompt as no error', async () => {
    const { StepUpCancelledError } = await import('@/composables/useStepUp')
    const { wrapper } = mountDialog(vi.fn(async () => Promise.reject(new StepUpCancelledError())))
    await byTestId(wrapper, 'claudex-user-key-name').setValue('script')
    await submit(wrapper)
    expect(wrapper.find('[data-testid="claudex-user-key-error"]').exists()).toBe(false)
    expect(wrapper.emitted('created')).toBeUndefined()
  })
})

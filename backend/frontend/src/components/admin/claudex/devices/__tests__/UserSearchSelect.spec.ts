// CLAUDEX K3: the user picker shared by the devices and usage rules pages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import UserSearchSelect from '../UserSearchSelect.vue'

const listUsers = vi.hoisted(() => vi.fn())

vi.mock('@/api/admin/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/admin/users')>()
  return { ...actual, list: listUsers }
})

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key)
  })
}))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  listUsers.mockReset()
  listUsers.mockResolvedValue({
    items: [{ id: 123, email: 'a@example.com', username: 'alice' }],
    total: 1,
    page: 1,
    page_size: 8,
    pages: 1
  })
})

afterEach(() => {
  vi.useRealTimers()
})

function mountPicker(modelValue: { id: number; email: string } | null = null) {
  return mount(UserSearchSelect, {
    props: { modelValue, label: 'User' },
    global: { stubs: { Icon: true } }
  })
}

describe('UserSearchSelect', () => {
  it('searches after a pause and picks a user', async () => {
    const wrapper = mountPicker()
    await wrapper.find('[data-testid="claudex-user-search"]').setValue('ali')
    expect(listUsers).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(listUsers).toHaveBeenCalledTimes(1)
    expect(listUsers).toHaveBeenCalledWith(1, 8, { search: 'ali' })
    const options = wrapper.findAll('[data-testid="claudex-user-option"]')
    expect(options).toHaveLength(1)
    await options[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([{ id: 123, email: 'a@example.com', username: 'alice' }])
  })

  it('only searches once for fast typing', async () => {
    const wrapper = mountPicker()
    const input = wrapper.find('[data-testid="claudex-user-search"]')
    await input.setValue('a')
    vi.advanceTimersByTime(100)
    await input.setValue('al')
    vi.advanceTimersByTime(100)
    await input.setValue('ali')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(listUsers).toHaveBeenCalledTimes(1)
  })

  it('offers a typed user ID', async () => {
    listUsers.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 8, pages: 0 })
    const wrapper = mountPicker()
    await wrapper.find('[data-testid="claudex-user-search"]').setValue('77')
    vi.advanceTimersByTime(300)
    await flushPromises()
    const options = wrapper.findAll('[data-testid="claudex-user-option"]')
    expect(options).toHaveLength(1)
    expect(options[0].text()).toContain('admin.claudexDevices.userSearch.userId{"id":77}')
    await options[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([{ id: 77, email: '' }])
  })

  it('shows the picked user with a clear button', async () => {
    const wrapper = mountPicker({ id: 123, email: 'a@example.com' })
    expect(wrapper.find('[data-testid="claudex-user-selected"]').text()).toContain('a@example.com')
    await wrapper.find('[data-testid="claudex-user-clear"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([null])
  })

  it('says when nothing matches and when the search fails', async () => {
    listUsers.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 8, pages: 0 })
    const wrapper = mountPicker()
    await wrapper.find('[data-testid="claudex-user-search"]').setValue('zzz')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(wrapper.find('[data-testid="claudex-user-no-results"]').exists()).toBe(true)

    listUsers.mockRejectedValueOnce({ status: 500, message: 'down' })
    await wrapper.find('[data-testid="claudex-user-search"]').setValue('yyy')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(wrapper.text()).toContain('down')
  })
})

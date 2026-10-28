import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ClaudexDirectorySubmissionsView from '../ClaudexDirectorySubmissionsView.vue'

const api = vi.hoisted(() => ({ list: vi.fn(), review: vi.fn() }))
vi.mock('@/api/admin/claudex/directory', () => ({ directory: api }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/useStepUp', () => ({ useStepUp: () => ({ run: (action: () => Promise<unknown>) => action() }), isStepUpCancelled: () => false }))
vi.mock('@/components/auth/TotpStepUpDialog.vue', () => ({ default: defineComponent({ setup: () => () => null }) }))
vi.mock('@/components/admin/claudex/common/ClaudexPageShell.vue', () => ({
  default: defineComponent({ props: ['loadError'], setup: (props, { slots }) => () => h('main', [props.loadError, slots.default?.()]) })
}))

describe('directory review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.list.mockResolvedValue({ data: [{ id: 'one', name: 'Example', kind: 'mcp', email: 'me@example.com', url: 'https://example.com', description: 'Description', examples: 'Read docs', license: 'MIT', tools: ['read'], status: 'submitted', reviewerNote: '' }] })
    api.review.mockResolvedValue({ data: {} })
  })

  it('shows submission details and sends each review decision with the reviewer note', async () => {
    const wrapper = mount(ClaudexDirectorySubmissionsView)
    await flushPromises()
    expect(wrapper.text()).toContain('Read docs')
    expect(wrapper.text()).toContain('MIT')
    expect(wrapper.text()).toContain('read')
    for (const [index, status] of ['in_review', 'approved', 'rejected'].entries()) {
      await wrapper.get('textarea').setValue('Reviewer feedback')
      await wrapper.findAll('button')[index].trigger('click')
      await flushPromises()
      expect(api.review).toHaveBeenLastCalledWith('one', status, 'Reviewer feedback')
    }
    expect(api.list).toHaveBeenCalledTimes(4)
  })

  it('surfaces a failed review instead of pretending it succeeded', async () => {
    api.review.mockRejectedValue(new Error('offline'))
    const wrapper = mount(ClaudexDirectorySubmissionsView)
    await flushPromises()
    await wrapper.findAll('button')[1].trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('admin.claudex.common.saveFailed')
    expect(api.list).toHaveBeenCalledTimes(1)
  })
})

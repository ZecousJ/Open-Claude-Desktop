import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ClaudexDirectorySubmissionsView from '../ClaudexDirectorySubmissionsView.vue'

const api = vi.hoisted(() => ({ list: vi.fn(), review: vi.fn() }))
const submission = { id: 'one', name: 'Example', kind: 'mcp', email: 'me@example.com', url: 'https://example.com', description: 'Description', examples: 'Read docs', license: 'MIT', tools: ['read'], status: 'submitted', reviewerNote: '', updatedAt: 100 }
vi.mock('@/api/admin/claudex/directory', () => ({ directory: api }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/useStepUp', () => ({ useStepUp: () => ({ run: (action: () => Promise<unknown>) => action() }), isStepUpCancelled: () => false, isStepUpBlocked: () => false }))
vi.mock('@/components/auth/TotpStepUpDialog.vue', () => ({ default: defineComponent({ setup: () => () => null }) }))
vi.mock('@/components/admin/claudex/common/ClaudexPageShell.vue', () => ({
  default: defineComponent({ props: ['loadError'], setup: (props, { slots }) => () => h('main', [props.loadError, slots.default?.()]) })
}))

describe('directory review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.list.mockResolvedValue({ data: [submission] })
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
      expect(api.review).toHaveBeenLastCalledWith('one', { status, note: 'Reviewer feedback', expectedUpdatedAt: 100 })
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

  it('reloads changed details and requires the reviewer to decide again', async () => {
    api.review.mockRejectedValueOnce({ status: 409, reason: 'DIRECTORY_SUBMISSION_CHANGED' })
    const wrapper = mount(ClaudexDirectorySubmissionsView)
    await flushPromises()
    api.list.mockResolvedValueOnce({ data: [{ ...submission, description: 'Updated details', updatedAt: 200 }] })
    await wrapper.findAll('button')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('admin.claudex.directory.reviewChanged')
    expect(wrapper.text()).toContain('Updated details')
    expect(api.review).toHaveBeenCalledTimes(1)
    await wrapper.findAll('button')[1].trigger('click')
    await flushPromises()
    expect(api.review).toHaveBeenLastCalledWith('one', { status: 'approved', note: '', expectedUpdatedAt: 200 })
  })

  it('shows the connector and plugin declarations a reviewer needs', async () => {
    api.list.mockResolvedValueOnce({ data: [
      { ...submission, serverUrlType: 'multiple', remoteUrlOptions: [{ url: 'https://eu.example.com/mcp', label: 'Europe' }], original: {
        submission_data: { test_setup_instructions: 'Use the test project', policy_compliance: { readGuidelines: true, firstPartyApi: false } }
      } },
      { ...submission, id: 'two', kind: 'plugin', original: {
        supported_platforms: ['claude_code', 'claude_cowork'], collects_user_data: false, privacy_policy_url: 'https://example.com/privacy'
      } }
    ] })
    const wrapper = mount(ClaudexDirectorySubmissionsView)
    await flushPromises()
    expect(wrapper.text()).toContain('Europe · https://eu.example.com/mcp')
    expect(wrapper.text()).toContain('Use the test project')
    expect(wrapper.text()).toContain('admin.claudex.directory.policies.readGuidelines · admin.claudex.directory.reviewFields.confirmed')
    expect(wrapper.text()).toContain('admin.claudex.directory.policies.firstPartyApi · admin.claudex.directory.reviewFields.unconfirmed')
    expect(wrapper.text()).toContain('admin.claudex.directory.platforms.claude_cowork')
    expect(wrapper.text()).toContain('https://example.com/privacy')
  })
})

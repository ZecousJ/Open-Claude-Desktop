import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import UserOnboardingAnswers from '../UserOnboardingAnswers.vue'

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }))

vi.mock('@/api/admin/claudex/onboarding', () => ({ getUser }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    te: () => false
  })
}))

describe('UserOnboardingAnswers', () => {
  it('shows a finished onboarding with its answers', async () => {
    getUser.mockResolvedValueOnce({
      found: true,
      started_at: '2026-10-12T09:00:00Z',
      finished_at: '2026-10-12T09:05:00Z',
      answers: {
        work_function: 'SoftwareEngineer',
        hear_about: 'social_media',
        hear_about_platform: 'reddit',
        hear_about_other: '',
        code_setup: 'desktop',
        connected_tools: ['Linear', 'Notion'],
        first_task: 'swe_review_pr'
      }
    })
    const wrapper = mount(UserOnboardingAnswers, { props: { userId: 7 } })
    await flushPromises()
    expect(getUser).toHaveBeenCalledWith(7)
    const text = wrapper.text()
    expect(text).toContain('admin.claudexOnboarding.finished')
    expect(text).toContain('SoftwareEngineer')
    expect(text).toContain('social_media · reddit')
    expect(text).toContain('Linear, Notion')
    expect(text).toContain('swe_review_pr')
  })

  it('says so when the account has no onboarding', async () => {
    getUser.mockResolvedValueOnce({
      found: false,
      started_at: null,
      finished_at: null,
      answers: { connected_tools: [] }
    })
    const wrapper = mount(UserOnboardingAnswers, { props: { userId: 8 } })
    await flushPromises()
    expect(wrapper.text()).toContain('admin.claudexOnboarding.none')
  })
})

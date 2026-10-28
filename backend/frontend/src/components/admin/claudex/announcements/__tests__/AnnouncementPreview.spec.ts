// CLAUDEX: the announcement preview draws the standard pop-up layout.
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import AnnouncementPreview from '../AnnouncementPreview.vue'
import { announcementDocument } from '../announcementDocument'
import { emptyContent, type AnnouncementContent } from '@/api/admin/claudex/announcements'

vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({ t: (key: string) => key, te: () => false })
}))

const content = (extra: Partial<AnnouncementContent> = {}): AnnouncementContent => ({
  ...emptyContent(),
  title: 'Get to finished work sooner',
  badge: 'New',
  body_html: 'One\nTwo\n\nThree',
  ...extra
})

describe('AnnouncementPreview', () => {
  it('shows the badge, the title and one paragraph per line of a text body', () => {
    const wrapper = mount(AnnouncementPreview, { props: { content: content() } })
    expect(wrapper.text()).toContain('New')
    expect(wrapper.text()).toContain('Get to finished work sooner')
    expect(wrapper.findAll('p').map((p) => p.text())).toEqual(['One', 'Two', 'Three'])
    expect(wrapper.find('iframe').exists()).toBe(false)
  })

  it('has one Done button without a link, and a main button plus Not now with one', async () => {
    const plain = mount(AnnouncementPreview, { props: { content: content() } })
    expect(plain.findAll('button').map((b) => b.text())).toEqual(['admin.claudexAnnouncements.preview.doneDefault'])
    const linked = mount(AnnouncementPreview, {
      props: { content: content({ primary_label: 'Try it', primary_url: 'https://example.com/go' }) }
    })
    expect(linked.findAll('button').map((b) => b.text())).toEqual([
      'Try it',
      'admin.claudexAnnouncements.preview.dismissDefault'
    ])
  })

  it('draws custom HTML in a frame without any permissions, and a picture on the right only for http(s) addresses', () => {
    const html = mount(AnnouncementPreview, {
      props: { content: content({ body_format: 'html', body_html: '<p>x</p>', image_url: 'https://example.com/a.png' }) }
    })
    const frame = html.find('iframe')
    expect(frame.attributes('sandbox')).toBe('')
    expect(frame.attributes('srcdoc')).toContain('<p>x</p>')
    expect(html.find('img').attributes('src')).toBe('https://example.com/a.png')
    const unsafe = mount(AnnouncementPreview, { props: { content: content({ image_url: 'javascript:alert(1)' }) } })
    expect(unsafe.find('img').exists()).toBe(false)
  })

  it('builds the frame document with the base ink first so the HTML can override it', () => {
    const doc = announcementDocument('<style>p{color:red}</style><p>x</p>', false)
    expect(doc.indexOf('color:#0b0b0b')).toBeLessThan(doc.indexOf('p{color:red}'))
    expect(announcementDocument('x', true)).toContain('color:#f0efec')
  })
})

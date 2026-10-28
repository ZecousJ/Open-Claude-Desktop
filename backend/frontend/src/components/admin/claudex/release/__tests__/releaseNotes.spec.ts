// CLAUDEX: the release notes preview renders Markdown without raw HTML or images (K4).
import { describe, expect, it } from 'vitest'
import { marked } from 'marked'

import { renderReleaseNotes } from '../releaseNotes'

function dom(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

describe('renderReleaseNotes', () => {
  it('renders ordinary Markdown', () => {
    const el = dom(renderReleaseNotes('## 1.4.0\n\n- Faster **startup**\n- `code`'))
    expect(el.querySelector('h2')?.textContent).toBe('1.4.0')
    expect(el.querySelectorAll('li')).toHaveLength(2)
    expect(el.querySelector('strong')?.textContent).toBe('startup')
    expect(el.querySelector('code')?.textContent).toBe('code')
  })

  it('shows raw HTML as text instead of rendering it', () => {
    const html = renderReleaseNotes('<script>alert(1)</script>\n\nHello <b onclick="x()">there</b>\n\n<iframe src="https://evil.example"></iframe>')
    const el = dom(html)
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.textContent).toContain('<script>alert(1)</script>')
    expect(el.textContent).toContain('<b onclick="x()">there</b>')
  })

  it('never loads images, local or remote (shows the alt text)', () => {
    const html = renderReleaseNotes('![Screenshot](https://cdn.example.com/shot.png)\n\n<img src="https://cdn.example.com/x.png" alt="x">')
    const el = dom(html)
    expect(el.querySelector('img')).toBeNull()
    expect(html).not.toContain('cdn.example.com/shot.png')
    expect(el.textContent).toContain('Screenshot')
  })

  it('keeps https and mailto links, opened in a new tab without an opener', () => {
    const el = dom(renderReleaseNotes('[Notes](https://claudex.example.com/notes "All notes") and <https://example.com/x> and [Mail](mailto:help@example.com)'))
    const links = [...el.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://claudex.example.com/notes',
      'https://example.com/x',
      'mailto:help@example.com'
    ])
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(links[0].getAttribute('title')).toBe('All notes')
  })

  it('drops links with other schemes and keeps their text', () => {
    const el = dom(renderReleaseNotes('[click](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [rel](/admin)'))
    expect(el.querySelector('a')).toBeNull()
    expect(el.textContent).toContain('click')
    expect(el.textContent).toContain('data')
    expect(el.textContent).toContain('rel')
  })

  it.each([
    ['mixed-case scheme', '[x](JaVaScRiPt:alert(1))'],
    ['entity-encoded scheme', '[x](&#106;avascript:alert(1))'],
    ['angle-bracket autolink', '<javascript:alert(1)>'],
    ['reference definition', '[x][evil]\n\n[evil]: javascript:alert(1)'],
    ['vbscript', '[x](vbscript:msgbox(1))'],
    ['protocol-relative', '[x](//evil.example/x)'],
    ['image inside a link', '[![shot](https://cdn.example.com/a.png)](javascript:alert(1))']
  ])('never produces an unsafe link or element: %s', (_name, markdown) => {
    const el = dom(renderReleaseNotes(markdown))
    for (const a of el.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').toMatch(/^(https?:|mailto:)/i)
    }
    expect(el.querySelector('img, script, iframe, svg')).toBeNull()
  })

  it('keeps attribute text inside the attribute (no breakout into event handlers)', () => {
    const el = dom(
      renderReleaseNotes('[x](https://ok.example/a "t\\" onmouseover=\\"alert(1)") [y](<https://ok.example/b" onclick="alert(1)>)')
    )
    for (const node of el.querySelectorAll('*')) {
      expect(node.getAttributeNames().filter((name) => name.startsWith('on'))).toEqual([])
    }
  })

  it('is empty for blank notes', () => {
    expect(renderReleaseNotes('')).toBe('')
    expect(renderReleaseNotes('   \n')).toBe('')
  })

  it('does not change the options of the shared marked instance', () => {
    renderReleaseNotes('<b>x</b>')
    expect(marked.parse('<b>x</b>') as string).toContain('<b>x</b>')
  })
})

/**
 * CLAUDEX: preview of the release notes Markdown the way Claudex shows it
 * (design 2.2): no raw HTML (it is shown as text), no images (remote images
 * are never loaded; the alt text is shown instead), and links only to https,
 * http or mailto targets, opened in a new tab.
 *
 * Uses its own Marked instance so the options of other Markdown renderers in
 * the console (announcements, legal pages) are not touched, and sanitizes the
 * result with DOMPurify as a second line of defence.
 */

import DOMPurify from 'dompurify'
import { Marked } from 'marked'

const SAFE_LINK = /^(?:https?:|mailto:)/i

/**
 * DOMPurify's default URI rule narrowed to https, http and mailto. DOMPurify
 * also applies it to other attribute values (target, rel), so values without
 * a scheme must still pass, exactly as in the default rule.
 */
const SANITIZER_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const releaseNotesMarked = new Marked({
  async: false,
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
    image({ text }) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens)
      const target = (href ?? '').trim()
      if (!SAFE_LINK.test(target)) return label
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(target)}"${titleAttr} target="_blank" rel="noopener noreferrer">${label}</a>`
    }
  }
})

const FORBIDDEN_TAGS = [
  'img',
  'picture',
  'source',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'style',
  'form',
  'input',
  'button',
  'textarea',
  'select'
]

/** Safe HTML for the release notes preview. */
export function renderReleaseNotes(markdown: string): string {
  if (!markdown.trim()) return ''
  const html = releaseNotesMarked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['style', 'srcset'],
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: SANITIZER_URI
  })
}

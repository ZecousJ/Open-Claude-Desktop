/**
 * CLAUDEX: the document an announcement's HTML body is drawn in. The apps
 * (Claudex desktop and web) build the same document, so the preview here is
 * what people get: base type and ink first, then the administrator's own
 * HTML and styles, which can override them. It runs in a frame with an empty
 * `sandbox`, so scripts, forms and top navigation are all off.
 */

const LIGHT = { ink: '#0b0b0b', muted: '#52514e', link: '#184f95' }
const DARK = { ink: '#f0efec', muted: '#c3c2b7', link: '#6da7ec' }

export function announcementDocument(body: string, dark: boolean): string {
  const c = dark ? DARK : LIGHT
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="color-scheme" content="' +
    (dark ? 'dark' : 'light') +
    '">' +
    '<style>html,body{margin:0;padding:0;background:transparent}' +
    'body{font:15px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:' +
    c.ink +
    ';word-wrap:break-word}' +
    'p{margin:0 0 12px}ul,ol{margin:0 0 12px;padding-left:22px}li{margin:0 0 8px}' +
    'h1,h2,h3{margin:0 0 12px;line-height:1.25}a{color:' +
    c.link +
    '}img{max-width:100%;height:auto}small,.muted{color:' +
    c.muted +
    '}</style></head><body>' +
    body +
    '</body></html>'
  )
}

import { sanitizeUrl } from '@/utils/url'

// CLAUDEX: W-CONSOLE the console is built with Vite base /admin/, so the
// bundled logo lives at /admin/logo.svg; the site root belongs to the web app.
export const DEFAULT_LOGO_URL = `${import.meta.env.BASE_URL}logo.svg`

export function updateFavicon(logoUrl: string): void {
  const sanitizedLogoUrl = sanitizeUrl(logoUrl, {
    allowRelative: true,
    allowDataUrl: true,
  })
  if (!sanitizedLogoUrl) {
    return
  }

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }

  link.type = sanitizedLogoUrl.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon'
  link.href = sanitizedLogoUrl
}

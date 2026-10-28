import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOGO_URL, updateFavicon } from '@/utils/branding'

describe('updateFavicon', () => {
  beforeEach(() => {
    document.head.innerHTML = '<link rel="icon" href="/logo.svg">'
  })

  it('replaces the default favicon with the configured logo', () => {
    updateFavicon('https://example.com/custom-logo.png')

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    expect(link?.href).toBe('https://example.com/custom-logo.png')
  })

  it('ignores unsafe logo URLs', () => {
    updateFavicon('javascript:alert(1)')

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    expect(link?.getAttribute('href')).toBe('/logo.svg')
  })

  // CLAUDEX: W-CONSOLE the default logo follows the Vite base
  it('builds the default logo URL from the Vite base', () => {
    expect(DEFAULT_LOGO_URL).toBe(`${import.meta.env.BASE_URL}logo.svg`)
    expect(DEFAULT_LOGO_URL.endsWith('/logo.svg')).toBe(true)
  })
})

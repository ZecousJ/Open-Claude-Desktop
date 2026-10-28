/**
 * CLAUDEX: which Claudex desktop build fits this browser's computer, for the
 * download button on /desktop-only (GET /api/v1/claudex/release?platform=&arch=).
 *
 * Uses User-Agent Client Hints where the browser has them and the User-Agent
 * string otherwise. Phones and tablets get no platform (there is no desktop
 * build for them). The architecture stays unknown when the browser does not
 * tell it reliably (macOS Safari and Firefox report "Intel" on Apple silicon),
 * and the server then decides which download to offer.
 */

export type DesktopPlatformName = 'darwin' | 'win32' | 'linux'
export type DesktopArch = 'arm64' | 'x64'

export interface DesktopPlatform {
  platform?: DesktopPlatformName
  arch?: DesktopArch
}

interface HighEntropyValues {
  architecture?: string
  bitness?: string
}

interface UserAgentDataLike {
  mobile?: boolean
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<HighEntropyValues>
}

export interface NavigatorLike {
  userAgent?: string
  maxTouchPoints?: number
  userAgentData?: UserAgentDataLike
}

function platformFromHint(name: string | undefined): DesktopPlatformName | undefined {
  switch ((name || '').toLowerCase()) {
    case 'macos':
      return 'darwin'
    case 'windows':
      return 'win32'
    case 'linux':
      return 'linux'
    default:
      return undefined
  }
}

function archFromHint(values: HighEntropyValues): DesktopArch | undefined {
  const architecture = (values.architecture || '').toLowerCase()
  if (values.bitness && values.bitness !== '64') return undefined
  if (architecture === 'arm') return 'arm64'
  if (architecture === 'x86') return 'x64'
  return undefined
}

function isMobileUserAgent(ua: string, maxTouchPoints: number): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  return /Macintosh/i.test(ua) && maxTouchPoints > 1
}

function platformFromUserAgent(ua: string): DesktopPlatformName | undefined {
  if (/Windows/i.test(ua)) return 'win32'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'darwin'
  if (/CrOS/i.test(ua)) return undefined
  if (/Linux|X11/i.test(ua)) return 'linux'
  return undefined
}

function archFromUserAgent(ua: string, platform: DesktopPlatformName): DesktopArch | undefined {
  // macOS browsers report "Intel Mac OS X" on every Mac, so the string says nothing there.
  if (platform === 'darwin') return undefined
  if (/aarch64|arm64/i.test(ua)) return 'arm64'
  if (/x86_64|x64|Win64|WOW64|amd64/i.test(ua)) return 'x64'
  return undefined
}

/** `nav` defaults to the browser's navigator; null means there is none. */
export async function detectDesktopPlatform(
  nav: NavigatorLike | null = typeof navigator === 'undefined' ? null : (navigator as NavigatorLike)
): Promise<DesktopPlatform> {
  if (!nav) return {}
  const ua = nav.userAgent || ''
  const hints = nav.userAgentData
  if (hints?.mobile || isMobileUserAgent(ua, nav.maxTouchPoints ?? 0)) return {}

  const platform = platformFromHint(hints?.platform) ?? platformFromUserAgent(ua)
  if (!platform) return {}

  let arch: DesktopArch | undefined
  if (hints?.getHighEntropyValues) {
    try {
      arch = archFromHint(await hints.getHighEntropyValues(['architecture', 'bitness']))
    } catch {
      arch = undefined
    }
  }
  return { platform, arch: arch ?? archFromUserAgent(ua, platform) }
}

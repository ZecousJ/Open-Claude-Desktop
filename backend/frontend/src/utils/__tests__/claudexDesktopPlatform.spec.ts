// CLAUDEX: tests for detectDesktopPlatform (download button on /desktop-only).
import { describe, expect, it } from 'vitest'
import { detectDesktopPlatform } from '@/utils/claudexDesktopPlatform'

const UA = {
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  winChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  linuxArm: 'Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0',
  iPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  chromeOS:
    'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
}

describe('detectDesktopPlatform', () => {
  it('uses client hints for the platform and the architecture', async () => {
    const nav = {
      userAgent: UA.macChrome,
      userAgentData: {
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: async () => ({ architecture: 'arm', bitness: '64' })
      }
    }
    expect(await detectDesktopPlatform(nav)).toEqual({ platform: 'darwin', arch: 'arm64' })
  })

  it('maps x86 client hints to x64', async () => {
    const nav = {
      userAgent: UA.winChrome,
      userAgentData: { platform: 'Windows', getHighEntropyValues: async () => ({ architecture: 'x86', bitness: '64' }) }
    }
    expect(await detectDesktopPlatform(nav)).toEqual({ platform: 'win32', arch: 'x64' })
  })

  it('leaves the Mac architecture unknown without client hints', async () => {
    expect(await detectDesktopPlatform({ userAgent: UA.macSafari, maxTouchPoints: 0 })).toEqual({
      platform: 'darwin',
      arch: undefined
    })
  })

  it('reads Windows and Linux from the user agent', async () => {
    expect(await detectDesktopPlatform({ userAgent: UA.winChrome })).toEqual({ platform: 'win32', arch: 'x64' })
    expect(await detectDesktopPlatform({ userAgent: UA.linuxFirefox })).toEqual({ platform: 'linux', arch: 'x64' })
    expect(await detectDesktopPlatform({ userAgent: UA.linuxArm })).toEqual({ platform: 'linux', arch: 'arm64' })
  })

  it('falls back to the user agent when client hints fail', async () => {
    const nav = {
      userAgent: UA.winChrome,
      userAgentData: {
        platform: 'Windows',
        getHighEntropyValues: async () => {
          throw new Error('denied')
        }
      }
    }
    expect(await detectDesktopPlatform(nav)).toEqual({ platform: 'win32', arch: 'x64' })
  })

  it('offers nothing to phones, tablets and Chromebooks', async () => {
    expect(await detectDesktopPlatform({ userAgent: UA.iPhone })).toEqual({})
    expect(await detectDesktopPlatform({ userAgent: UA.android })).toEqual({})
    expect(await detectDesktopPlatform({ userAgent: UA.macSafari, maxTouchPoints: 5 })).toEqual({})
    expect(await detectDesktopPlatform({ userAgent: UA.chromeOS })).toEqual({})
    expect(await detectDesktopPlatform({ userAgent: UA.android, userAgentData: { mobile: true, platform: 'Android' } })).toEqual({})
    expect(await detectDesktopPlatform(null)).toEqual({})
  })
})

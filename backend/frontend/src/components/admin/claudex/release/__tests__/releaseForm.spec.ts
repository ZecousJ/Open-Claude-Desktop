// CLAUDEX: tests for the desktop release form model and checks (K4).
import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  emptyReleaseForm,
  isValidVersion,
  publishedAtFromInput,
  releaseFormFromSetting,
  releaseNotesLength,
  releaseSettingFromForm,
  validateReleaseForm,
  RELEASE_NOTES_MAX_CHARS
} from '../releaseForm'
import { RELEASE_PLATFORMS, type ClientReleaseResponse } from '@/api/admin/claudex/release'

const SHA = 'a'.repeat(64)

function formWith(patch: Partial<ReturnType<typeof emptyReleaseForm>>) {
  return { ...emptyReleaseForm(), ...patch }
}

describe('compareVersions (mirrors core.CompareVersions)', () => {
  it.each([
    ['1.2.0', '1.2.0', 0],
    ['1.2', '1.2.0', 0],
    ['1.2.0', '1.10.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.2.0-beta.1', '1.2.0', -1],
    ['1.2.0-beta.2', '1.2.0-beta.10', -1],
    ['1.2.0-alpha', '1.2.0-beta', -1],
    ['1.2.0-1', '1.2.0-alpha', -1],
    ['1.2.0-beta', '1.2.0-beta.1', -1],
    ['0.2.8+claudex.1', '0.2.8', 0],
    ['0.2.8+claudex.9', '0.2.8+claudex.1', 0],
    ['1.0.0.1', '1.0.0', 1],
    ['nonsense', '0.0.1', -1],
    ['0.0.1', 'nonsense', 1]
  ])('%s vs %s -> %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })
})

describe('isValidVersion', () => {
  it.each(['1', '1.4', '1.4.0', '1.4.0.2', '1.4.0-beta.1', '0.2.8+claudex.1', '1.4.0-rc.1+build.5'])('accepts %s', (v) => {
    expect(isValidVersion(v)).toBe(true)
  })

  it.each(['', 'v1.4.0', '1.4.0.1.2', '1..4', '1.4.0-', '1.4.0+', 'latest', `1.${'1'.repeat(31)}`])('rejects %j', (v) => {
    expect(isValidVersion(v)).toBe(false)
  })
})

describe('validateReleaseForm', () => {
  it('accepts the empty form (no release published yet)', () => {
    expect(validateReleaseForm(emptyReleaseForm())).toEqual({})
  })

  it('requires the minimum version to be at most the latest', () => {
    expect(validateReleaseForm(formWith({ latestVersion: '1.4.0', minimumVersion: '1.2.0' }))).toEqual({})
    expect(validateReleaseForm(formWith({ latestVersion: '1.4.0', minimumVersion: '1.4.0' }))).toEqual({})
    expect(validateReleaseForm(formWith({ latestVersion: '1.4.0', minimumVersion: '1.4.0+claudex.2' }))).toEqual({})
    expect(validateReleaseForm(formWith({ latestVersion: '1.4.0-beta.1', minimumVersion: '1.4.0' }))).toEqual({
      minimum_version: 'minimumAboveLatest'
    })
    expect(validateReleaseForm(formWith({ latestVersion: '1.4.0', minimumVersion: '1.10.0' }))).toEqual({
      minimum_version: 'minimumAboveLatest'
    })
    expect(validateReleaseForm(formWith({ minimumVersion: '1.2.0' }))).toEqual({ minimum_version: 'minimumWithoutLatest' })
  })

  it('checks the version syntax', () => {
    expect(validateReleaseForm(formWith({ latestVersion: 'v1.4', minimumVersion: 'one' }))).toEqual({
      latest_version: 'version',
      minimum_version: 'version'
    })
  })

  it('accepts only https URLs for the notes link and every download', () => {
    const form = emptyReleaseForm()
    form.releaseNotesUrl = 'http://example.com/notes'
    form.downloads['darwin-arm64'].url = 'http://dl.example.com/Claudex.zip'
    form.downloads['win32-x64'].url = 'https://user:pw@dl.example.com/setup.exe'
    form.downloads['linux-x64'].url = 'https://dl.example.com/claudex.AppImage'
    form.downloads['linux-arm64'].url = `https://dl.example.com/${'a'.repeat(2000)}`
    expect(validateReleaseForm(form)).toEqual({
      release_notes_url: 'https',
      'downloads.darwin-arm64.url': 'https',
      'downloads.win32-x64.url': 'https',
      'downloads.linux-arm64.url': 'tooLong'
    })
  })

  it('checks the SHA-256 values', () => {
    const form = emptyReleaseForm()
    form.downloads['darwin-arm64'] = { url: 'https://dl.example.com/a.zip', sha256: SHA }
    form.downloads['darwin-x64'] = { url: 'https://dl.example.com/b.zip', sha256: SHA.toUpperCase() }
    form.downloads['win32-x64'] = { url: 'https://dl.example.com/c.exe', sha256: 'abc' }
    form.downloads['linux-x64'] = { url: '', sha256: SHA }
    expect(validateReleaseForm(form)).toEqual({
      'downloads.win32-x64.sha256': 'sha256',
      'downloads.linux-x64.sha256': 'sha256WithoutUrl'
    })
  })

  it('limits the release notes to 20000 characters counted as code points', () => {
    expect(releaseNotesLength('😀😀')).toBe(2)
    expect(validateReleaseForm(formWith({ releaseNotesMd: 'a'.repeat(RELEASE_NOTES_MAX_CHARS) }))).toEqual({})
    expect(validateReleaseForm(formWith({ releaseNotesMd: '😀'.repeat(RELEASE_NOTES_MAX_CHARS) }))).toEqual({})
    expect(validateReleaseForm(formWith({ releaseNotesMd: 'a'.repeat(RELEASE_NOTES_MAX_CHARS + 1) }))).toEqual({
      release_notes_md: 'notesTooLong'
    })
  })

  it('rejects a malformed published date', () => {
    expect(validateReleaseForm(formWith({ publishedAt: 'yesterday' }))).toEqual({ published_at: 'date' })
  })
})

describe('release setting <-> form', () => {
  const stored: ClientReleaseResponse = {
    channels: {
      stable: {
        latest_version: '1.4.0',
        minimum_version: '1.2.0',
        published_at: '2026-09-20T08:00:00Z',
        release_notes_url: 'https://claudex.example.com/releases/1.4.0',
        release_notes_md: '## 1.4.0\n- Faster',
        downloads: {
          'darwin-arm64': { url: 'https://dl.example.com/Claudex-1.4.0-arm64.zip', sha256: SHA },
          'win32-x64': { url: 'https://dl.example.com/Claudex-Setup-1.4.0.exe', sha256: '' },
          'linux-x64': null
        }
      }
    },
    enforce_minimum_on_gateway: true,
    updated_at: '2026-09-21T00:00:00Z'
  }

  it('round-trips a stored setting', () => {
    const form = releaseFormFromSetting(stored)
    expect(form.latestVersion).toBe('1.4.0')
    expect(form.enforceMinimumOnGateway).toBe(true)
    expect(form.downloads['linux-x64']).toEqual({ url: '', sha256: '' })
    const body = releaseSettingFromForm(form)
    expect(body).toEqual({
      channels: {
        stable: {
          latest_version: '1.4.0',
          minimum_version: '1.2.0',
          published_at: '2026-09-20T08:00:00Z',
          release_notes_url: 'https://claudex.example.com/releases/1.4.0',
          release_notes_md: '## 1.4.0\n- Faster',
          downloads: {
            'darwin-arm64': { url: 'https://dl.example.com/Claudex-1.4.0-arm64.zip', sha256: SHA },
            'win32-x64': { url: 'https://dl.example.com/Claudex-Setup-1.4.0.exe', sha256: '' }
          }
        }
      },
      enforce_minimum_on_gateway: true
    })
    expect(body).not.toHaveProperty('updated_at')
  })

  it('keeps enforcement off when the setting is missing or says nothing', () => {
    expect(releaseFormFromSetting(null).enforceMinimumOnGateway).toBe(false)
    expect(releaseFormFromSetting({ channels: {} } as never).enforceMinimumOnGateway).toBe(false)
    expect(releaseSettingFromForm(emptyReleaseForm()).enforce_minimum_on_gateway).toBe(false)
  })

  it('trims values, lowercases checksums and leaves out platforms without a URL', () => {
    const form = emptyReleaseForm()
    form.latestVersion = ' 1.4.0 '
    form.downloads['darwin-x64'] = { url: ' https://dl.example.com/x.zip ', sha256: ` ${SHA.toUpperCase()} ` }
    form.downloads['linux-arm64'] = { url: '   ', sha256: '' }
    const body = releaseSettingFromForm(form)
    expect(body.channels.stable?.latest_version).toBe('1.4.0')
    expect(body.channels.stable?.published_at).toBeNull()
    expect(body.channels.stable?.downloads).toEqual({
      'darwin-x64': { url: 'https://dl.example.com/x.zip', sha256: SHA }
    })
  })

  it('writes the published time as RFC 3339 in UTC', () => {
    const value = publishedAtFromInput('2026-09-20T10:30')
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/)
    expect(new Date(value!).getTime()).toBe(new Date(2026, 8, 20, 10, 30).getTime())
    expect(publishedAtFromInput('')).toBeNull()
  })

  it('offers every platform the server accepts', () => {
    expect(Object.keys(emptyReleaseForm().downloads)).toEqual([...RELEASE_PLATFORMS])
  })
})

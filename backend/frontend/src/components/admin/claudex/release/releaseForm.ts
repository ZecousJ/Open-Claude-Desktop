/**
 * CLAUDEX: form model and checks for the desktop release page. The rules
 * follow the server (design 2.2, internal/claudex/release and core/version.go);
 * the server checks again and is authoritative.
 */

import {
  RELEASE_PLATFORMS,
  type ClientReleaseSetting,
  type ReleaseChannel,
  type ReleaseDownload,
  type ReleasePlatform
} from '@/api/admin/claudex/release'
import { formatDateTimeLocalInput, parseDateTimeLocalInput } from '@/utils/format'
import { validateHttpsUrl } from '../common/validation'

/** core.VersionPattern: one to four numeric parts, optional pre-release and build metadata. */
export const VERSION_PATTERN = /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$/
export const VERSION_MAX_LENGTH = 32
export const RELEASE_NOTES_MAX_CHARS = 20000
export const SHA256_PATTERN = /^[0-9a-f]{64}$/

export interface ReleaseDownloadForm {
  url: string
  sha256: string
}

export interface ReleaseForm {
  latestVersion: string
  minimumVersion: string
  /** datetime-local value (local time), empty when not set. */
  publishedAt: string
  releaseNotesUrl: string
  releaseNotesMd: string
  downloads: Record<ReleasePlatform, ReleaseDownloadForm>
  enforceMinimumOnGateway: boolean
}

export type ReleaseProblem =
  | 'version'
  | 'minimumWithoutLatest'
  | 'minimumAboveLatest'
  | 'date'
  | 'https'
  | 'tooLong'
  | 'notesTooLong'
  | 'sha256'
  | 'sha256WithoutUrl'

/** Problems by server field name (latest_version, downloads.darwin-arm64.url, ...). */
export type ReleaseProblems = Record<string, ReleaseProblem>

export function emptyReleaseForm(): ReleaseForm {
  const downloads = {} as Record<ReleasePlatform, ReleaseDownloadForm>
  for (const platform of RELEASE_PLATFORMS) {
    downloads[platform] = { url: '', sha256: '' }
  }
  return {
    latestVersion: '',
    minimumVersion: '',
    publishedAt: '',
    releaseNotesUrl: '',
    releaseNotesMd: '',
    downloads,
    enforceMinimumOnGateway: false
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function publishedAtToInput(value: string | null | undefined): string {
  if (!value) return ''
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? '' : formatDateTimeLocalInput(Math.floor(ms / 1000))
}

/** RFC 3339 in UTC with whole seconds, or null when empty or not a valid date. */
export function publishedAtFromInput(value: string): string | null {
  const seconds = parseDateTimeLocalInput(value.trim())
  if (seconds === null) return null
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** The form for a stored setting (a missing setting gives the empty form). */
export function releaseFormFromSetting(setting: Partial<ClientReleaseSetting> | null | undefined): ReleaseForm {
  const form = emptyReleaseForm()
  const stable = setting?.channels?.stable
  form.enforceMinimumOnGateway = setting?.enforce_minimum_on_gateway === true
  if (!stable) return form
  form.latestVersion = text(stable.latest_version)
  form.minimumVersion = text(stable.minimum_version)
  form.publishedAt = publishedAtToInput(stable.published_at)
  form.releaseNotesUrl = text(stable.release_notes_url)
  form.releaseNotesMd = text(stable.release_notes_md)
  const downloads = stable.downloads ?? {}
  for (const platform of RELEASE_PLATFORMS) {
    const entry = downloads[platform]
    if (entry) {
      form.downloads[platform] = { url: text(entry.url), sha256: text(entry.sha256) }
    }
  }
  return form
}

function normalizeSha256(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The PUT body for a form: the whole setting (the server replaces what it
 * stores). Platforms without a download URL are left out.
 */
export function releaseSettingFromForm(form: ReleaseForm): ClientReleaseSetting {
  const downloads: Partial<Record<ReleasePlatform, ReleaseDownload>> = {}
  for (const platform of RELEASE_PLATFORMS) {
    const url = form.downloads[platform].url.trim()
    if (url) {
      downloads[platform] = { url, sha256: normalizeSha256(form.downloads[platform].sha256) }
    }
  }
  const stable: ReleaseChannel = {
    latest_version: form.latestVersion.trim(),
    minimum_version: form.minimumVersion.trim(),
    published_at: publishedAtFromInput(form.publishedAt),
    release_notes_url: form.releaseNotesUrl.trim(),
    release_notes_md: form.releaseNotesMd,
    downloads
  }
  return { channels: { stable }, enforce_minimum_on_gateway: form.enforceMinimumOnGateway }
}

export function isValidVersion(value: string): boolean {
  return value.length <= VERSION_MAX_LENGTH && VERSION_PATTERN.test(value)
}

interface ParsedVersion {
  nums: number[]
  pre: string[]
}

function parseVersion(value: string): ParsedVersion | null {
  let v = value.trim()
  if (!VERSION_PATTERN.test(v)) return null
  const plus = v.indexOf('+')
  if (plus >= 0) v = v.slice(0, plus) // build metadata never affects precedence
  let pre: string[] = []
  const dash = v.indexOf('-')
  if (dash >= 0) {
    pre = v.slice(dash + 1).split('.')
    v = v.slice(0, dash)
  }
  return { nums: v.split('.').map(Number), pre }
}

function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0
}

function comparePreIdent(a: string, b: string): -1 | 0 | 1 {
  const numA = /^\d+$/.test(a)
  const numB = /^\d+$/.test(b)
  if (numA && numB) return sign(Number(a) - Number(b))
  if (numA) return -1 // numeric identifiers sort before alphanumeric ones
  if (numB) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Semantic-version precedence like core.CompareVersions: numeric parts left
 * to right (missing parts are 0), a pre-release sorts before its release,
 * build metadata is ignored, an invalid version sorts before valid ones.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va && !vb) return a < b ? -1 : a > b ? 1 : 0
  if (!va) return -1
  if (!vb) return 1
  for (let i = 0; i < va.nums.length || i < vb.nums.length; i++) {
    const x = va.nums[i] ?? 0
    const y = vb.nums[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0
  if (va.pre.length === 0) return 1
  if (vb.pre.length === 0) return -1
  for (let i = 0; i < va.pre.length && i < vb.pre.length; i++) {
    const c = comparePreIdent(va.pre[i], vb.pre[i])
    if (c !== 0) return c
  }
  return sign(va.pre.length - vb.pre.length)
}

/** Length of the release notes as the server counts it (Unicode code points). */
export function releaseNotesLength(value: string): number {
  return Array.from(value).length
}

/** Checks the form; an empty result means it can be saved. */
export function validateReleaseForm(form: ReleaseForm): ReleaseProblems {
  const problems: ReleaseProblems = {}
  const latest = form.latestVersion.trim()
  const minimum = form.minimumVersion.trim()

  if (latest && !isValidVersion(latest)) problems.latest_version = 'version'
  if (minimum) {
    if (!isValidVersion(minimum)) problems.minimum_version = 'version'
    else if (!latest) problems.minimum_version = 'minimumWithoutLatest'
    else if (!problems.latest_version && compareVersions(minimum, latest) > 0) {
      problems.minimum_version = 'minimumAboveLatest'
    }
  }
  if (form.publishedAt.trim() && publishedAtFromInput(form.publishedAt) === null) {
    problems.published_at = 'date'
  }
  const notesUrlProblem = validateHttpsUrl(form.releaseNotesUrl)
  if (notesUrlProblem) problems.release_notes_url = notesUrlProblem === 'tooLong' ? 'tooLong' : 'https'
  if (releaseNotesLength(form.releaseNotesMd) > RELEASE_NOTES_MAX_CHARS) {
    problems.release_notes_md = 'notesTooLong'
  }
  for (const platform of RELEASE_PLATFORMS) {
    const entry = form.downloads[platform]
    const url = entry.url.trim()
    const sha = normalizeSha256(entry.sha256)
    const urlProblem = validateHttpsUrl(url)
    if (urlProblem) problems[`downloads.${platform}.url`] = urlProblem === 'tooLong' ? 'tooLong' : 'https'
    if (sha) {
      if (!SHA256_PATTERN.test(sha)) problems[`downloads.${platform}.sha256`] = 'sha256'
      else if (!url) problems[`downloads.${platform}.sha256`] = 'sha256WithoutUrl'
    }
  }
  return problems
}

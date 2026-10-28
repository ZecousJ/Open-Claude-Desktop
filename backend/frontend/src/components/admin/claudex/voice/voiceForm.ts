/**
 * CLAUDEX: form model and checks for the voice (dictation) page. Dictation
 * relays the desktop app's microphone audio to a realtime transcription
 * service over WebSocket (owner decisions 18/19; server
 * internal/claudex/voice). The rules follow the server, which checks again
 * and is authoritative.
 *
 * The upstream API key is write-only: the form never holds the stored key,
 * only a new one typed in (sent as api_key) or a request to remove the
 * stored one (clear_api_key). The per-session audio limit is stored in bytes
 * of 16 kHz mono 16-bit PCM and edited in seconds of audio.
 */

import type { VoiceSettingResponse, VoiceUpdate } from '@/api/admin/claudex/voice'
import { integerInRange, toNumber } from '../general/pageSupport'

export const DEFAULT_UPSTREAM_URL = ''
export const UPSTREAM_URL_MAX_LENGTH = 2048
/** pcm_s16le, 16 kHz, mono: one second of audio. */
export const BYTES_PER_SECOND = 32000
export const MIN_SESSION_SECONDS = 10
export const MAX_SESSION_SECONDS = 3600
export const MIN_AUDIO_SECONDS = 1
export const MAX_AUDIO_SECONDS = 3600
export const MIN_AUDIO_BYTES = MIN_AUDIO_SECONDS * BYTES_PER_SECOND
export const MAX_AUDIO_BYTES = MAX_AUDIO_SECONDS * BYTES_PER_SECOND
export const MIN_IDLE_SECONDS = 5
export const MAX_IDLE_SECONDS = 300
export const API_KEY_MIN_LENGTH = 8
export const API_KEY_MAX_LENGTH = 512

/** Server defaults, used when a value is missing. Dictation is off until a key is stored. */
export const VOICE_DEFAULTS = {
  enabled: false,
  upstream_url: DEFAULT_UPSTREAM_URL,
  max_session_seconds: 300,
  max_bytes: 300 * BYTES_PER_SECOND,
  idle_timeout_seconds: 30
}

export interface VoiceForm {
  enabled: boolean
  upstreamUrl: string
  /** A new upstream key typed in; '' keeps the stored one. Never the stored key. */
  apiKey: string
  /** Remove the stored key on save (this also turns dictation off). */
  clearKey: boolean
  /** Number inputs may hand back strings or ''. */
  maxSessionSeconds: number | string | null
  /** Max audio per session, in seconds of audio (3 decimals). */
  maxAudioSeconds: number | string | null
  idleTimeoutSeconds: number | string | null
  /** What the server said about the stored key. */
  keyConfigured: boolean
  keyMasked: string
  /** The stored byte count and how it was shown, so an untouched value is saved unchanged. */
  loadedBytes: number
  loadedAudioSeconds: number
}

export type VoiceProblem = 'upstreamUrl' | 'apiKey' | 'keyRequired' | 'sessionSeconds' | 'audioSeconds' | 'idleSeconds'

/** Problems by server field name (transcription.upstream_url, ...). */
export type VoiceProblems = Record<string, VoiceProblem>

export function bytesToAudioSeconds(bytes: number): number {
  return Math.round((bytes / BYTES_PER_SECOND) * 1000) / 1000
}

export function audioSecondsToBytes(seconds: number): number {
  return Math.round(seconds * BYTES_PER_SECOND)
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function voiceFormFromSetting(setting: Partial<VoiceSettingResponse> | null | undefined): VoiceForm {
  const tr = setting?.transcription
  const bytes = positive(tr?.max_bytes, VOICE_DEFAULTS.max_bytes)
  const audioSeconds = bytesToAudioSeconds(bytes)
  const keyConfigured = tr?.api_key_configured === true
  return {
    enabled: tr?.enabled === true,
    upstreamUrl: typeof tr?.upstream_url === 'string' ? tr.upstream_url : VOICE_DEFAULTS.upstream_url,
    apiKey: '',
    clearKey: false,
    maxSessionSeconds: positive(tr?.max_session_seconds, VOICE_DEFAULTS.max_session_seconds),
    maxAudioSeconds: audioSeconds,
    idleTimeoutSeconds: positive(tr?.idle_timeout_seconds, VOICE_DEFAULTS.idle_timeout_seconds),
    keyConfigured,
    keyMasked: keyConfigured && typeof tr?.api_key_masked === 'string' ? tr.api_key_masked : '',
    loadedBytes: bytes,
    loadedAudioSeconds: audioSeconds
  }
}

function audioBytes(form: VoiceForm): number | null {
  const seconds = toNumber(form.maxAudioSeconds)
  if (seconds === null) return null
  return seconds === form.loadedAudioSeconds ? form.loadedBytes : audioSecondsToBytes(seconds)
}

/** True when dictation would have an upstream key after saving. */
export function keyAvailable(form: VoiceForm): boolean {
  return form.apiKey.trim() !== '' || (form.keyConfigured && !form.clearKey)
}

/** The PUT body for a form (call after validateVoiceForm found no problems). */
export function voiceUpdateFromForm(form: VoiceForm): VoiceUpdate {
  const transcription: VoiceUpdate['transcription'] = {
    enabled: form.enabled,
    upstream_url: form.upstreamUrl.trim(),
    max_session_seconds: toNumber(form.maxSessionSeconds) ?? 0,
    max_bytes: audioBytes(form) ?? 0,
    idle_timeout_seconds: toNumber(form.idleTimeoutSeconds) ?? 0
  }
  const key = form.apiKey.trim()
  if (key !== '') transcription.api_key = key
  else if (form.clearKey) transcription.clear_api_key = true
  return { transcription }
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/**
 * Like the server: an absolute wss:// URL (ws:// only for localhost), at most
 * 2048 characters, without credentials, a fragment or a key in the query.
 */
export function validUpstreamUrl(value: string): boolean {
  const raw = value.trim()
  if (raw === '' || raw.length > UPSTREAM_URL_MAX_LENGTH) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (!url.host) return false
  if (url.protocol === 'ws:') {
    if (!isLoopbackHost(url.hostname)) return false
  } else if (url.protocol !== 'wss:') {
    return false
  }
  if (url.username || url.password || raw.includes('#')) return false
  for (const name of url.searchParams.keys()) {
    if (['api_key', 'key', 'token'].includes(name.toLowerCase())) return false
  }
  return true
}

/** Like the server: 8 to 512 characters (code points) after trimming, no spaces or control characters. */
export function validApiKey(value: string): boolean {
  const key = value.trim()
  const length = Array.from(key).length
  return length >= API_KEY_MIN_LENGTH && length <= API_KEY_MAX_LENGTH && !/[\s\p{Cc}]/u.test(key)
}

/** Checks the form; an empty result means it can be saved. */
export function validateVoiceForm(form: VoiceForm): VoiceProblems {
  const problems: VoiceProblems = {}
  // No service yet is fine while dictation stays off.
  if ((form.upstreamUrl.trim() || form.enabled) && !validUpstreamUrl(form.upstreamUrl))
    problems['transcription.upstream_url'] = 'upstreamUrl'
  if (form.apiKey.trim() !== '' && !validApiKey(form.apiKey)) problems['transcription.api_key'] = 'apiKey'
  else if (form.enabled && !keyAvailable(form)) problems['transcription.api_key'] = 'keyRequired'
  if (!integerInRange(form.maxSessionSeconds, MIN_SESSION_SECONDS, MAX_SESSION_SECONDS)) {
    problems['transcription.max_session_seconds'] = 'sessionSeconds'
  }
  const bytes = audioBytes(form)
  if (bytes === null || bytes < MIN_AUDIO_BYTES || bytes > MAX_AUDIO_BYTES) {
    problems['transcription.max_bytes'] = 'audioSeconds'
  }
  if (!integerInRange(form.idleTimeoutSeconds, MIN_IDLE_SECONDS, MAX_IDLE_SECONDS)) {
    problems['transcription.idle_timeout_seconds'] = 'idleSeconds'
  }
  return problems
}

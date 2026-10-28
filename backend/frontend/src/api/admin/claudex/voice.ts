/**
 * CLAUDEX: admin API for dictation in the desktop app (/admin/claudex/voice,
 * setting claudex_voice; design 2.8 as rescoped by owner decisions 18/19).
 * Reached as adminAPI.claudex.voice.
 *
 * The desktop app streams microphone audio to the gateway's realtime
 * WebSocket (/v1/audio/realtime/transcriptions) with its device key; the
 * server relays it to the realtime transcription service with the API key
 * stored here. The key is write-only: responses only say whether one is
 * stored and show it masked. There is no read aloud (owner decision 19).
 */

import { apiClient } from '../../client'
import type { PaginatedResponse } from '@/types'

/** The transcription settings as the server shows them (without the key). */
export interface VoiceTranscriptionView {
  enabled: boolean
  /** wss:// URL of the realtime transcription service. */
  upstream_url: string
  api_key_configured: boolean
  /** "********" plus the last 4 characters of long keys; "" when none is stored. */
  api_key_masked: string
  /** Longest session in seconds (10 to 3600). */
  max_session_seconds: number
  /** Most audio relayed in one session, in bytes (32000 = 1 s of audio). */
  max_bytes: number
  /** A session closes after this many seconds without frames (5 to 300). */
  idle_timeout_seconds: number
}

/** How sessions are billed (read-only). */
export interface VoiceBillingView {
  billed_model: string
  bytes_per_second: number
  audio_format: string
  sample_rate: number
  channels: number
  /** False while the server has no fixed secret encryption key: a key can't be stored then. */
  can_store_api_key: boolean
}

/** GET and PUT /admin/claudex/voice answer. */
export interface VoiceSettingResponse {
  transcription: VoiceTranscriptionView
  billing?: VoiceBillingView | null
  /** Read-only notes: an unreadable stored key, missing group prices. */
  warnings?: string[] | null
}

/**
 * PUT /admin/claudex/voice body. Fields left out keep their stored values.
 * api_key replaces the stored key; clear_api_key removes it (and turns
 * dictation off). Never send both.
 */
export interface VoiceUpdate {
  transcription: {
    enabled?: boolean
    upstream_url?: string
    api_key?: string
    clear_api_key?: boolean
    max_session_seconds?: number
    max_bytes?: number
    idle_timeout_seconds?: number
  }
}

/**
 * One dictation session. Every session is billed from the audio it relayed
 * (bytes / 32000), so every row is an estimate (owner decision 6).
 */
export interface VoiceSession {
  request_id: string
  user_id: number
  user_email?: string | null
  api_key_id?: number | null
  group_id?: number | null
  audio_bytes: number | null
  /** May arrive as a string from a NUMERIC column. */
  estimated_seconds: number | string | null
  cost_usd?: number | null
  /** False when billing wasn't applied (duplicate request ID, zero price, error). */
  billed?: boolean | null
  duration_ms?: number | null
  end_reason?: string | null
  created_at: string
}

export interface VoiceSessionQuery {
  user_id?: number
  page?: number
  page_size?: number
}

/** GET /admin/claudex/voice */
export async function getVoice(): Promise<VoiceSettingResponse> {
  const { data } = await apiClient.get<VoiceSettingResponse>('/admin/claudex/voice')
  return data
}

/** PUT /admin/claudex/voice. Answers with the GET shape (including fresh warnings). */
export async function updateVoice(body: VoiceUpdate): Promise<VoiceSettingResponse> {
  const { data } = await apiClient.put<VoiceSettingResponse>('/admin/claudex/voice', body)
  return data
}

/** GET /admin/claudex/voice/estimated-usage (the dictation sessions, newest first). */
export async function listVoiceSessions(query: VoiceSessionQuery = {}): Promise<PaginatedResponse<VoiceSession>> {
  const { data } = await apiClient.get<PaginatedResponse<VoiceSession>>('/admin/claudex/voice/estimated-usage', {
    params: query
  })
  return data
}

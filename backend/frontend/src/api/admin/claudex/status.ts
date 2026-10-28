/**
 * CLAUDEX: admin API for the service status page (/admin/claudex/status,
 * backend internal/claudex/status). Reached as adminAPI.claudex.status.
 *
 * The apps' Service status page shows each provider's channels (Sub2API's
 * channel monitors) with a bar a day, and the incidents handled here. An
 * incident is detected when a channel fails twice in a row and waits here as
 * a draft until an administrator approves it (people see only published
 * incidents); an administrator can open one too, and moves it through investigating →
 * identified → monitoring → resolved with a message at each step.
 */

import { apiClient } from '../../client'

export type StatusLevel = 'none' | 'operational' | 'degraded' | 'outage'
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type IncidentImpact = 'degraded' | 'outage'

export const INCIDENT_STATUSES: IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved']

export interface StatusDay {
  date: string
  level: StatusLevel
  uptime: number | null
  checks: number
  degraded: number
  failed: number
  incidents: number[]
}

export interface StatusComponent {
  monitor_id: number
  name: string
  channel: string
  level: StatusLevel
  uptime: number | null
  days: StatusDay[]
}

/** One channel (a channel monitor, by its name) and the models it checks. */
export interface StatusPlatform {
  platform: string
  name: string
  provider: string
  level: StatusLevel
  uptime: number | null
  components: StatusComponent[]
  days: StatusDay[]
}

export interface IncidentUpdate {
  status: IncidentStatus
  message: string
  created_at: string
}

export interface Incident {
  id: number
  title: string
  platform: string
  impact: IncidentImpact
  status: IncidentStatus
  auto: boolean
  /** People see it; the ones the checks open wait here for approval. */
  published: boolean
  started_at: string
  resolved_at: string | null
  updated_at: string
  message: string
  updates: IncidentUpdate[]
}

export interface StatusOverview {
  timezone: string
  start: string
  end: string
  generated_at: string
  level: StatusLevel
  platforms: StatusPlatform[]
  incidents: Incident[]
}

export interface IncidentInput {
  title?: string
  platform?: string
  impact?: IncidentImpact
  status?: IncidentStatus
  message?: string
  published?: boolean
}

export const INCIDENT_LIMITS = { title: 200, message: 5000 } as const

export async function getStatus(days = 90): Promise<StatusOverview> {
  const { data } = await apiClient.get<StatusOverview>('/admin/claudex/status', { params: { days } })
  return data
}

export async function createIncident(
  body: Required<Omit<IncidentInput, 'platform' | 'published'>> & { platform: string; published: boolean }
): Promise<Incident> {
  const { data } = await apiClient.post<Incident>('/admin/claudex/status/incidents', body)
  return data
}

/** A status or a message posts an update people see; title, provider and impact only edit it. */
export async function updateIncident(id: number, body: IncidentInput): Promise<Incident> {
  const { data } = await apiClient.patch<Incident>(`/admin/claudex/status/incidents/${id}`, body)
  return data
}

export async function deleteIncident(id: number): Promise<void> {
  await apiClient.delete(`/admin/claudex/status/incidents/${id}`)
}

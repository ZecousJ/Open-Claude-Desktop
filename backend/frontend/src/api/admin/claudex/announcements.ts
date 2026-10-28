/**
 * CLAUDEX: admin API for announcements (/admin/claudex/announcements, backend
 * internal/claudex/announce). Reached as adminAPI.claudex.announcements.
 *
 * An announcement is a pop-up the Claudex apps show once to every signed-in
 * user; it is published for a number of hours and then comes down by itself.
 * E-mail notices are separate sends to chosen users.
 */

import { apiClient } from '../../client'

export type AnnouncementStatus = 'draft' | 'published' | 'withdrawn' | 'expired'

/** What an administrator writes. */
export interface AnnouncementContent {
  title: string
  badge: string
  /** The content: plain text (each line a paragraph) or, with body_format "html", HTML with its own styles drawn in a frame without scripts. */
  body_html: string
  body_format: 'text' | 'html'
  image_url: string
  primary_label: string
  primary_url: string
  dismiss_label: string
}

export interface Announcement extends AnnouncementContent {
  id: number
  status: AnnouncementStatus
  published_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
  /** How many people closed it. */
  reads: number
}

export interface AnnouncementList {
  items: Announcement[]
  /** False while the service has no SMTP settings. */
  mail_ready: boolean
}

export interface MailSend {
  id: number
  subject: string
  body_html: string
  recipients: number
  sent: number
  failed: number
  status: 'sending' | 'done'
  created_at: string
  finished_at: string | null
}

export interface MailList {
  items: MailSend[]
  mail_ready: boolean
}

export const ANNOUNCEMENT_LIMITS = {
  title: 200,
  badge: 40,
  label: 60,
  bodyBytes: 200_000,
  mailSubject: 200,
  recipients: 500
} as const

export const emptyContent = (): AnnouncementContent => ({
  title: '',
  badge: '',
  body_html: '',
  body_format: 'text',
  image_url: '',
  primary_label: '',
  primary_url: '',
  dismiss_label: ''
})

export async function listAnnouncements(): Promise<AnnouncementList> {
  const { data } = await apiClient.get<AnnouncementList>('/admin/claudex/announcements')
  return data
}

export async function createAnnouncement(body: AnnouncementContent): Promise<Announcement> {
  const { data } = await apiClient.post<Announcement>('/admin/claudex/announcements', body)
  return data
}

export async function updateAnnouncement(
  id: number,
  body: AnnouncementContent,
  resetReads = false
): Promise<Announcement> {
  const { data } = await apiClient.put<Announcement>(`/admin/claudex/announcements/${id}`, {
    ...body,
    reset_reads: resetReads
  })
  return data
}

export async function deleteAnnouncement(id: number): Promise<void> {
  await apiClient.delete(`/admin/claudex/announcements/${id}`)
}

/** Publishes (or publishes again) for `hours`; needs step-up. */
export async function publishAnnouncement(id: number, hours: number): Promise<Announcement> {
  const { data } = await apiClient.post<Announcement>(`/admin/claudex/announcements/${id}/publish`, {
    duration_hours: hours
  })
  return data
}

export async function withdrawAnnouncement(id: number): Promise<Announcement> {
  const { data } = await apiClient.post<Announcement>(`/admin/claudex/announcements/${id}/withdraw`)
  return data
}

export async function listMails(): Promise<MailList> {
  const { data } = await apiClient.get<MailList>('/admin/claudex/announcement-mails')
  return data
}

/** Sends an e-mail notice to the chosen users; needs step-up. */
export async function sendMail(body: {
  subject: string
  body_html: string
  user_ids: number[]
}): Promise<{ id: number; recipients: number }> {
  const { data } = await apiClient.post<{ id: number; recipients: number }>('/admin/claudex/announcement-mails', body)
  return data
}

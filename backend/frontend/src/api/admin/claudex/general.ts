/**
 * CLAUDEX: admin API for the web console setting (/admin/claudex/web-console,
 * design 2.2). Reached as adminAPI.claudex.general.
 *
 * `admin_only` is the public setting web_console_admin_only: when it is on,
 * the web console only serves administrators and everyone else is sent to
 * /desktop-only. `backend_mode_enabled` mirrors the upstream Backend mode
 * setting and is read-only here (it is changed under System settings).
 */

import { apiClient } from '../../client'

export interface WebConsoleSetting {
  admin_only: boolean
  backend_mode_enabled: boolean
}

export interface WebConsoleUpdate {
  admin_only: boolean
}

/** GET /admin/claudex/web-console */
export async function getWebConsole(): Promise<WebConsoleSetting> {
  const { data } = await apiClient.get<WebConsoleSetting>('/admin/claudex/web-console')
  return data
}

/** PUT /admin/claudex/web-console (step-up). Answers with the GET shape. */
export async function updateWebConsole(body: WebConsoleUpdate): Promise<WebConsoleSetting> {
  const { data } = await apiClient.put<WebConsoleSetting>('/admin/claudex/web-console', body)
  return data
}

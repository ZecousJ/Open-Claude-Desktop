/**
 * CLAUDEX: the public setting web_console_admin_only (GET /api/v1/claudex/web-console).
 *
 * When it is on (the default), the web console is for administrators only:
 * everyone else is sent to /desktop-only and uses the Claudex desktop app. The
 * setting only shapes the web routes; the JSON API is not restricted by it.
 *
 * The value starts as true and is read once per page load. A missing,
 * malformed or unreachable setting (for example a server without the setting
 * yet) keeps it true, so the console fails closed. Only an explicit
 * `admin_only: false` from the server opens the user pages.
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getWebConsoleSetting } from '@/api/claudexPublic'

export const useWebConsoleStore = defineStore('claudexWebConsole', () => {
  const adminOnly = ref(true)
  /** True once the server answered; false while unknown (and after a failed read). */
  const loaded = ref(false)
  let loading: Promise<void> | null = null

  async function load(): Promise<void> {
    try {
      const setting = await getWebConsoleSetting()
      adminOnly.value = setting?.admin_only !== false
      loaded.value = true
    } catch (error) {
      adminOnly.value = true
      console.warn('Could not read the web console setting; keeping the console for admins only', error)
    }
  }

  /** Reads the setting on first use; later calls reuse the result for this page load. Never rejects. */
  function ensureLoaded(): Promise<void> {
    if (!loading) {
      loading = load()
    }
    return loading
  }

  /** Applies a value the admin just saved, without waiting for a reload. */
  function setAdminOnly(value: boolean): void {
    adminOnly.value = value
    loaded.value = true
    loading = Promise.resolve()
  }

  return { adminOnly, loaded, ensureLoaded, setAdminOnly }
})

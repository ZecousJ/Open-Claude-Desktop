/**
 * CLAUDEX: save state for a Claudex console form (pairs with SaveBar.vue).
 *
 *   const save = useClaudexSave('claudexRelease')
 *   await save.run(() => stepUp.run(() => adminAPI.claudex.release.update(form)))
 *   <SaveBar :saving="save.saving.value" :error="save.error.value" ... @save="submit" />
 *
 * A cancelled step-up prompt is not an error. Other failures set `error` to
 * the page's localized message (see errors.ts) and keep the raw error in
 * `lastError`, so a page can react to a reason such as
 * CLAUDEX_POLICY_REVISION_CONFLICT.
 */

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { isStepUpCancelled } from '@/composables/useStepUp'
import { claudexErrorMessage, claudexErrorReason } from './errors'

export type ClaudexSaveResult<T> = { ok: true; value: T } | { ok: false; cancelled: boolean }

export function useClaudexSave(page: string | null) {
  const { t, te } = useI18n()
  const saving = ref(false)
  const saved = ref(false)
  const error = ref<string | null>(null)
  const lastError = ref<unknown>(null)
  const reason = computed(() => claudexErrorReason(lastError.value))

  async function run<T>(action: () => Promise<T>): Promise<ClaudexSaveResult<T>> {
    saving.value = true
    saved.value = false
    error.value = null
    lastError.value = null
    try {
      const value = await action()
      saved.value = true
      return { ok: true, value }
    } catch (err) {
      if (isStepUpCancelled(err)) {
        return { ok: false, cancelled: true }
      }
      lastError.value = err
      error.value = claudexErrorMessage(err, t, te, page, t('admin.claudex.common.saveFailed'))
      return { ok: false, cancelled: false }
    } finally {
      saving.value = false
    }
  }

  /** Clears the status, e.g. when the form changes again. */
  function reset(): void {
    saved.value = false
    error.value = null
    lastError.value = null
  }

  return { saving, saved, error, lastError, reason, run, reset }
}

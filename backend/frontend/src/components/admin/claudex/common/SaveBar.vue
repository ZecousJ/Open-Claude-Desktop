<!-- CLAUDEX: save row for a Claudex console form: status text and the Save button. -->
<template>
  <div
    class="flex flex-col gap-3 border-t border-gray-100 pt-4 dark:border-dark-700 sm:flex-row sm:items-center sm:justify-end"
    data-testid="claudex-save-bar"
  >
    <p
      v-if="error"
      role="alert"
      class="text-sm text-red-600 dark:text-red-400 sm:mr-auto"
      data-testid="claudex-save-error"
    >
      {{ error }}
    </p>
    <p
      v-else-if="statusText"
      role="status"
      class="text-sm sm:mr-auto"
      :class="statusClass"
      data-testid="claudex-save-status"
    >
      {{ statusText }}
    </p>
    <slot name="extra" />
    <button
      type="button"
      class="btn btn-primary"
      :disabled="saving || disabled"
      data-testid="claudex-save-button"
      @click="emit('save')"
    >
      <Icon v-if="saving" name="refresh" size="sm" class="mr-2 animate-spin" />
      {{ saving ? t('admin.claudex.common.saving') : saveLabel || t('admin.claudex.common.save') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'

const props = withDefaults(
  defineProps<{
    saving?: boolean
    /** The form differs from what was last loaded or saved. */
    dirty?: boolean
    /** The last save succeeded (and nothing changed since). */
    saved?: boolean
    error?: string | null
    disabled?: boolean
    saveLabel?: string
  }>(),
  { saving: false, dirty: false, saved: false, error: null, disabled: false, saveLabel: '' }
)

const emit = defineEmits<{ (e: 'save'): void }>()

const { t } = useI18n()

const statusText = computed(() => {
  if (props.saving) return ''
  if (props.dirty) return t('admin.claudex.common.unsavedChanges')
  if (props.saved) return t('admin.claudex.common.saved')
  return ''
})

const statusClass = computed(() =>
  props.dirty ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'
)
</script>

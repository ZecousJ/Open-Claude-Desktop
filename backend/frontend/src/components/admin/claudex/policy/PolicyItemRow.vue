<!--
  CLAUDEX: one item of the client policy editor: label, hint, the "Inherit"
  checkbox and the control. While the item inherits, the control shows the
  inherited value and is disabled (a disabled fieldset), and the item is left
  out of the patch.
-->
<template>
  <div class="py-4" :data-testid="testId" :data-inherited="inherited ? 'true' : 'false'">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0 flex-1">
        <p :id="labelId" class="text-sm font-medium text-gray-900 dark:text-white">{{ label }}</p>
        <p v-if="hint" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ hint }}</p>
      </div>
      <div class="flex flex-shrink-0 items-center gap-4">
        <fieldset
          v-if="$slots.inline"
          :disabled="inherited"
          class="min-w-0"
          :class="{ 'opacity-60': inherited }"
          :aria-labelledby="labelId"
        >
          <slot name="inline" />
        </fieldset>
        <label
          class="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300"
          :title="inheritHint"
        >
          <input
            type="checkbox"
            class="h-3.5 w-3.5 rounded border-gray-300 text-primary-500 focus:ring-primary-500 dark:border-dark-500"
            :checked="inherited"
            :aria-describedby="inheritHint ? `${labelId}-inherit` : undefined"
            data-testid="policy-inherit"
            @change="emit('update:inherited', ($event.target as HTMLInputElement).checked)"
          />
          {{ t('admin.claudexPolicy.editor.inherit') }}
          <span v-if="inheritHint" :id="`${labelId}-inherit`" class="sr-only">{{ inheritHint }}</span>
        </label>
      </div>
    </div>
    <fieldset
      v-if="$slots.default"
      :disabled="inherited"
      class="mt-3 min-w-0"
      :class="{ 'opacity-60': inherited }"
      :aria-labelledby="labelId"
    >
      <slot />
    </fieldset>
    <p v-if="error" role="alert" class="input-error-text mt-1.5" data-testid="policy-item-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'

withDefaults(
  defineProps<{
    label: string
    hint?: string
    inherited: boolean
    inheritHint?: string
    error?: string | null
    testId?: string
  }>(),
  { hint: '', inheritHint: '', error: null, testId: undefined }
)

const emit = defineEmits<{ (e: 'update:inherited', value: boolean): void }>()

const { t } = useI18n()
const labelId = `policy-item-${useId()}`
</script>

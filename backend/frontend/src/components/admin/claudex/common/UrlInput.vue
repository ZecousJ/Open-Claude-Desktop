<!--
  CLAUDEX: text field for an https URL. Shows the problem after the field
  loses focus (or when `showError` is set, e.g. after a save attempt); pages
  check the whole form with validateHttpsUrl() before saving.
-->
<template>
  <div class="w-full">
    <label v-if="label" :for="inputId" class="input-label mb-1.5 block">
      {{ label }}
      <span v-if="required" class="text-red-500">*</span>
    </label>
    <input
      :id="inputId"
      type="url"
      inputmode="url"
      autocomplete="off"
      spellcheck="false"
      class="input w-full"
      :class="{ 'input-error': visibleProblem }"
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      :aria-invalid="visibleProblem ? 'true' : 'false'"
      :aria-describedby="visibleProblem || hint ? `${inputId}-note` : undefined"
      @input="onInput"
      @blur="touched = true"
    />
    <p
      v-if="visibleProblem"
      :id="`${inputId}-note`"
      class="input-error-text mt-1.5"
      data-testid="claudex-url-error"
    >
      {{ t(urlProblemMessageKey(visibleProblem)) }}
    </p>
    <p v-else-if="hint" :id="`${inputId}-note`" class="input-hint mt-1.5">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { CLAUDEX_URL_MAX_LENGTH, urlProblemMessageKey, validateHttpsUrl } from './validation'

const props = withDefaults(
  defineProps<{
    modelValue: string | null | undefined
    label?: string
    placeholder?: string
    hint?: string
    required?: boolean
    disabled?: boolean
    maxLength?: number
    /** Show the problem even before the field was touched. */
    showError?: boolean
    id?: string
  }>(),
  {
    label: '',
    placeholder: 'https://',
    hint: '',
    required: false,
    disabled: false,
    maxLength: CLAUDEX_URL_MAX_LENGTH,
    showError: false,
    id: undefined
  }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const { t } = useI18n()
const generatedId = useId()
const inputId = computed(() => props.id || `claudex-url-${generatedId}`)
const touched = ref(false)

const problem = computed(() =>
  validateHttpsUrl(props.modelValue, { required: props.required, maxLength: props.maxLength })
)
const visibleProblem = computed(() => (touched.value || props.showError ? problem.value : null))

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

defineExpose({ problem })
</script>

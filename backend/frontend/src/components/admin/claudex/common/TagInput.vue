<!--
  CLAUDEX: list-of-strings field (domains, model patterns, voices...). Enter,
  comma or leaving the field adds the typed value; each chip has a remove
  button; Backspace in an empty field removes the last value. `validate`
  returns an i18n key for a value it rejects.
-->
<template>
  <div class="w-full">
    <label v-if="label" :for="inputId" class="input-label mb-1.5 block">{{ label }}</label>
    <div
      class="input flex min-h-[2.5rem] w-full flex-wrap items-center gap-1.5 py-1.5"
      :class="{ 'input-error': message, 'cursor-not-allowed opacity-60': disabled }"
      @click="focusInput"
    >
      <span
        v-for="(value, index) in modelValue"
        :key="`${index}:${value}`"
        class="inline-flex max-w-full items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-800 dark:bg-dark-700 dark:text-gray-100"
        data-testid="claudex-tag"
      >
        <span class="truncate font-mono">{{ value }}</span>
        <button
          v-if="!disabled"
          type="button"
          class="rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          :aria-label="t('admin.claudex.common.tags.remove', { value })"
          data-testid="claudex-tag-remove"
          @click.stop="removeAt(index)"
        >
          <Icon name="x" size="xs" />
        </button>
      </span>
      <input
        :id="inputId"
        ref="inputRef"
        v-model="draft"
        type="text"
        autocomplete="off"
        spellcheck="false"
        class="min-w-[8rem] flex-1 border-0 bg-transparent p-0 text-sm focus:outline-none focus:ring-0"
        :placeholder="placeholderText"
        :disabled="disabled"
        :aria-invalid="message ? 'true' : 'false'"
        :aria-describedby="message || hint ? `${inputId}-note` : undefined"
        data-testid="claudex-tag-input"
        @keydown="onKeydown"
        @blur="commitDraft"
      />
    </div>
    <p v-if="message" :id="`${inputId}-note`" class="input-error-text mt-1.5" data-testid="claudex-tag-error">
      {{ message }}
    </p>
    <p v-else-if="hint" :id="`${inputId}-note`" class="input-hint mt-1.5">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    label?: string
    placeholder?: string
    hint?: string
    /** Most values allowed (0 = no limit). */
    max?: number
    /** Compare values case-insensitively when rejecting duplicates. */
    caseInsensitive?: boolean
    /** Returns an i18n key when the value is not acceptable. */
    validate?: (value: string) => string | null
    disabled?: boolean
    id?: string
  }>(),
  {
    label: '',
    placeholder: '',
    hint: '',
    max: 0,
    caseInsensitive: false,
    validate: undefined,
    disabled: false,
    id: undefined
  }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string[]): void }>()

const { t } = useI18n()
const generatedId = useId()
const inputId = computed(() => props.id || `claudex-tags-${generatedId}`)
const inputRef = ref<HTMLInputElement | null>(null)
const draft = ref('')
const message = ref('')

const atLimit = computed(() => props.max > 0 && props.modelValue.length >= props.max)
const placeholderText = computed(() =>
  atLimit.value ? '' : props.placeholder || t('admin.claudex.common.tags.placeholder')
)

function normalized(value: string): string {
  return props.caseInsensitive ? value.toLowerCase() : value
}

/**
 * Adds the typed values (a pasted "a, b" adds both). Values before the first
 * rejected one are added; the rejected one and the rest stay in the field
 * with the reason shown. Returns the text left in the field.
 */
function add(raw: string): string {
  const parts = raw.split(/[,\n]/)
  const next = [...props.modelValue]
  let rest = ''
  message.value = ''
  for (let i = 0; i < parts.length; i++) {
    const value = parts[i].trim()
    if (!value) continue
    let problem = ''
    if (props.max > 0 && next.length >= props.max) {
      problem = t('admin.claudex.common.tags.limit', { max: props.max })
    } else if (next.some((existing) => normalized(existing) === normalized(value))) {
      problem = t('admin.claudex.common.tags.duplicate')
    } else {
      const problemKey = props.validate?.(value)
      if (problemKey) problem = t(problemKey)
    }
    if (problem) {
      message.value = problem
      rest = parts.slice(i).join(',').trim()
      break
    }
    next.push(value)
  }
  if (next.length !== props.modelValue.length) {
    emit('update:modelValue', next)
  }
  return rest
}

function commitDraft() {
  draft.value = add(draft.value)
}

function removeAt(index: number) {
  message.value = ''
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index)
  )
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault()
    commitDraft()
    return
  }
  if (event.key === 'Backspace' && !draft.value && props.modelValue.length > 0) {
    removeAt(props.modelValue.length - 1)
  }
}

function focusInput() {
  inputRef.value?.focus()
}
</script>

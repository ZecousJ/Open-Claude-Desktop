<!--
  CLAUDEX: release notes Markdown with a live preview rendered the way the
  Claudex desktop app shows it (no raw HTML, no images; see releaseNotes.ts).
-->
<template>
  <div class="grid gap-4 lg:grid-cols-2" data-testid="claudex-release-notes">
    <div class="min-w-0">
      <label :for="inputId" class="input-label mb-1.5 block">
        {{ t('admin.claudexRelease.notes.markdown') }}
      </label>
      <textarea
        :id="inputId"
        :value="modelValue"
        rows="14"
        spellcheck="true"
        class="input w-full font-mono text-sm"
        :class="{ 'input-error': tooLong }"
        :aria-invalid="tooLong ? 'true' : 'false'"
        :aria-describedby="`${inputId}-note`"
        :placeholder="t('admin.claudexRelease.notes.placeholder')"
        data-testid="claudex-release-notes-input"
        @input="onInput"
      ></textarea>
      <p
        :id="`${inputId}-note`"
        class="mt-1.5 flex justify-between gap-4 text-xs"
        :class="tooLong ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'"
      >
        <span>{{ tooLong ? t('admin.claudexRelease.problems.notesTooLong', { max: maxChars }) : t('admin.claudexRelease.notes.hint') }}</span>
        <span class="flex-shrink-0 tabular-nums" data-testid="claudex-release-notes-count">
          {{ t('admin.claudexRelease.notes.count', { count: length, max: maxChars }) }}
        </span>
      </p>
    </div>
    <div class="min-w-0">
      <p class="input-label mb-1.5 block">{{ t('admin.claudexRelease.notes.preview') }}</p>
      <div
        class="markdown-body min-h-[14rem] overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-dark-700 dark:bg-dark-900/40"
        data-testid="claudex-release-notes-preview"
      >
        <!-- Sanitized by renderReleaseNotes: no raw HTML, no images, safe links only. -->
        <div v-if="html" v-html="html"></div>
        <p v-else class="text-gray-400 dark:text-gray-500">{{ t('admin.claudexRelease.notes.previewEmpty') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import '@/styles/announcement-markdown.css'
import { RELEASE_NOTES_MAX_CHARS, releaseNotesLength } from './releaseForm'
import { renderReleaseNotes } from './releaseNotes'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const { t } = useI18n()
const inputId = `claudex-release-notes-${useId()}`
const maxChars = RELEASE_NOTES_MAX_CHARS

const length = computed(() => releaseNotesLength(props.modelValue))
const tooLong = computed(() => length.value > maxChars)
const html = computed(() => renderReleaseNotes(props.modelValue))

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}
</script>

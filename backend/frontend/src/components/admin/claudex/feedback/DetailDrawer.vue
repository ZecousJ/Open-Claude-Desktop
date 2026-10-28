<!--
  CLAUDEX: side drawer for the details of one diagnostic report or feedback
  entry. Escape, the close button or the backdrop close it.
-->
<template>
  <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-50 flex justify-end" data-testid="claudex-detail-drawer">
      <div class="absolute inset-0 bg-black/40" aria-hidden="true" @click="emit('close')"></div>
      <section
        ref="panelRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        class="relative flex h-full w-full max-w-xl flex-col bg-white shadow-xl outline-none dark:bg-dark-800"
        @keydown.esc="emit('close')"
      >
        <header class="flex items-center justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 :id="titleId" class="text-base font-semibold text-gray-900 dark:text-white">{{ title }}</h3>
          <button
            type="button"
            class="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            :aria-label="t('admin.claudexFeedback.drawer.close')"
            data-testid="claudex-detail-drawer-close"
            @click="emit('close')"
          >
            <Icon name="x" size="md" />
          </button>
        </header>
        <div class="flex-1 overflow-y-auto px-6 py-5">
          <div v-if="loading" class="flex justify-center py-10">
            <Icon name="refresh" size="lg" class="animate-spin text-gray-400" />
          </div>
          <p
            v-else-if="error"
            role="alert"
            class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
            data-testid="claudex-detail-drawer-error"
          >
            {{ error }}
          </p>
          <slot v-else />
        </div>
        <footer v-if="$slots.footer" class="flex justify-end gap-3 border-t border-gray-100 px-6 py-4 dark:border-dark-700">
          <slot name="footer" />
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'

const props = withDefaults(
  defineProps<{
    show: boolean
    title: string
    loading?: boolean
    error?: string | null
  }>(),
  { loading: false, error: null }
)

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const titleId = `claudex-detail-drawer-${useId()}`
const panelRef = ref<HTMLElement | null>(null)

watch(
  () => props.show,
  async (open) => {
    if (!open) return
    await nextTick()
    panelRef.value?.focus()
  }
)
</script>

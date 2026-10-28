<!--
  CLAUDEX: frame of a Claudex console page: the admin layout, the page title
  and description, a load error with retry, and slots for the content, header
  actions and the save row (SaveBar.vue).
-->
<template>
  <AppLayout>
    <div class="space-y-6" :data-testid="testId">
      <section
        class="flex flex-col gap-4 border-b border-gray-200 pb-5 dark:border-dark-700 sm:flex-row sm:items-end sm:justify-between"
      >
        <div class="min-w-0">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">{{ title }}</h2>
          <p v-if="description" class="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
            {{ description }}
          </p>
        </div>
        <div v-if="$slots.actions" class="flex flex-shrink-0 items-center gap-2">
          <slot name="actions" />
        </div>
      </section>

      <div
        v-if="loadError"
        role="alert"
        class="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300 sm:flex-row sm:items-center sm:justify-between"
        data-testid="claudex-page-load-error"
      >
        <span>{{ t('admin.claudex.common.loadFailed') }}: {{ loadError }}</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="emit('retry')">
          {{ t('admin.claudex.common.retry') }}
        </button>
      </div>

      <div v-if="loading" class="flex justify-center py-12" data-testid="claudex-page-loading">
        <Icon name="refresh" size="lg" class="animate-spin text-gray-400" />
        <span class="sr-only">{{ t('admin.claudex.common.loading') }}</span>
      </div>
      <template v-else>
        <slot />
        <slot name="footer" />
      </template>
    </div>
  </AppLayout>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import Icon from '@/components/icons/Icon.vue'

withDefaults(
  defineProps<{
    title: string
    description?: string
    loading?: boolean
    /** Message of a failed load; shows a retry button. */
    loadError?: string | null
    testId?: string
  }>(),
  { description: '', loading: false, loadError: null, testId: undefined }
)

const emit = defineEmits<{ (e: 'retry'): void }>()

const { t } = useI18n()
</script>

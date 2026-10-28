<!--
  CLAUDEX: the request ID of a report, with a copy button and a link to the
  Ops page where the request can be looked up in the system logs (by client
  request ID).
-->
<template>
  <div class="min-w-0" data-testid="claudex-request-id">
    <template v-if="requestId">
      <div class="flex min-w-0 items-center gap-2">
        <span class="truncate font-mono text-xs text-gray-900 dark:text-gray-100" :title="requestId">{{ requestId }}</span>
        <button
          type="button"
          class="flex-shrink-0 rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          :aria-label="t('admin.claudexFeedback.requestId.copy')"
          data-testid="claudex-request-id-copy"
          @click="copy"
        >
          <Icon name="copy" size="sm" />
        </button>
      </div>
      <router-link
        to="/admin/ops"
        class="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:underline dark:text-primary-400"
        data-testid="claudex-request-id-ops"
      >
        {{ t('admin.claudexFeedback.requestId.openOps') }}
        <Icon name="arrowRight" size="xs" />
      </router-link>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ t('admin.claudexFeedback.requestId.opsHint') }}</p>
    </template>
    <span v-else class="text-sm text-gray-400">--</span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import { useClipboard } from '@/composables/useClipboard'

const props = defineProps<{ requestId: string | null | undefined }>()

const { t } = useI18n()
const { copyToClipboard } = useClipboard()

function copy() {
  if (props.requestId) void copyToClipboard(props.requestId, t('admin.claudexFeedback.requestId.copied'))
}
</script>

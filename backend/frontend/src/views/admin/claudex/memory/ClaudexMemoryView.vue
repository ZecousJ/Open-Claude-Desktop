<!--
  CLAUDEX: /admin/claudex/memory (R3 user memory, backend R3-S1). Usage
  numbers, a warning when the server can't store memory (no fixed encryption
  key), and one user's memory metadata with clearing. Administrators never
  see memory text: the server doesn't send it. The memory policy itself is
  edited on the client policy page (POL). A server without the memory
  feature answers 404 and the page says it isn't available.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexMemory.title')"
    :description="t('admin.claudexMemory.description')"
    :loading="loading && !stats && !unavailable"
    :load-error="loadError"
    test-id="claudex-memory-page"
    @retry="load"
  >
    <template v-if="!unavailable" #actions>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="loading"
        :title="t('admin.claudexMemory.refresh')"
        :aria-label="t('admin.claudexMemory.refresh')"
        data-testid="claudex-memory-refresh"
        @click="load"
      >
        <Icon name="refresh" size="sm" :class="{ 'animate-spin': loading }" />
      </button>
    </template>

    <ClaudexUnavailable v-if="unavailable" />

    <div v-else-if="stats" class="space-y-6">
      <div
        v-if="!stats.encryption_key_ready"
        role="alert"
        class="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/50 dark:bg-amber-900/20"
        data-testid="claudex-memory-key-missing"
      >
        <Icon name="exclamationTriangle" size="md" class="mt-0.5 flex-shrink-0 text-amber-500" />
        <div class="text-sm text-amber-800 dark:text-amber-200">
          <p class="font-medium">{{ t('admin.claudexMemory.keyMissing.title') }}</p>
          <p class="mt-1 text-amber-700 dark:text-amber-300">{{ t('admin.claudexMemory.keyMissing.body') }}</p>
        </div>
      </div>

      <div
        class="flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-800/50 dark:bg-blue-900/20 sm:flex-row sm:items-center sm:justify-between"
        data-testid="claudex-memory-policy-note"
      >
        <div class="flex items-start gap-3 text-blue-800 dark:text-blue-200">
          <Icon name="infoCircle" size="md" class="mt-0.5 flex-shrink-0 text-blue-500" />
          <span>{{ t('admin.claudexMemory.policyNote') }}</span>
        </div>
        <RouterLink
          to="/admin/claudex/policy"
          class="flex-shrink-0 font-medium text-primary-600 hover:underline dark:text-primary-400"
          data-testid="claudex-memory-policy-link"
        >
          {{ t('admin.claudexMemory.policyLink') }}
        </RouterLink>
      </div>

      <MemoryStatsCard :stats="stats" />
      <UserMemoryCard :step-up="stepUp" :confirm="confirm" @cleared="load" />
    </div>
  </ClaudexPageShell>

  <ConfirmDialog
    :show="confirm.state.show"
    :title="confirm.state.title"
    :message="confirm.state.message"
    :confirm-text="confirm.state.confirmText || undefined"
    :danger="confirm.state.danger"
    :z-index="55"
    @confirm="confirm.accept"
    @cancel="confirm.cancel"
  />
  <TotpStepUpDialog :controller="stepUp" />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import ClaudexUnavailable from '@/components/admin/claudex/common/ClaudexUnavailable.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import Icon from '@/components/icons/Icon.vue'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { useConfirm } from '@/components/admin/claudex/devices/useConfirm'
import { isMissingEndpoint } from '@/components/admin/claudex/general/pageSupport'
import { useStepUp } from '@/composables/useStepUp'
import { getStats, type MemoryStats } from '@/api/admin/claudex/memory'
import MemoryStatsCard from './MemoryStatsCard.vue'
import UserMemoryCard from './UserMemoryCard.vue'

const { t, te } = useI18n()
const stepUp = useStepUp()
const confirm = useConfirm()

const stats = ref<MemoryStats | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)
const unavailable = ref(false)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    stats.value = await getStats()
    unavailable.value = false
  } catch (err) {
    if (isMissingEndpoint(err)) {
      unavailable.value = true
      stats.value = null
    } else {
      loadError.value = claudexErrorMessage(err, t, te, 'claudexMemory', t('admin.claudex.common.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

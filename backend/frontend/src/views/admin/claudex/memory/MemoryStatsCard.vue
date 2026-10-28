<!--
  CLAUDEX: usage numbers of user memory (GET /admin/claudex/memory/stats).
  Counts and sizes only; the console never receives memory text.
-->
<template>
  <section class="card" data-testid="claudex-memory-stats">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        {{ t('admin.claudexMemory.stats.title') }}
      </h3>
    </div>
    <dl class="grid grid-cols-2 gap-x-6 gap-y-5 p-6 sm:grid-cols-3 xl:grid-cols-6">
      <div v-for="item in items" :key="item.key" :data-testid="`claudex-memory-stat-${item.key}`">
        <dt class="text-xs text-gray-500 dark:text-gray-400" :title="item.hint || undefined">
          {{ item.label }}
        </dt>
        <dd class="mt-1 text-xl font-semibold tabular-nums" :class="item.tone">
          {{ item.value }}
        </dd>
      </div>
    </dl>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MemoryStats } from '@/api/admin/claudex/memory'
import { formatBytes, formatNumber } from '@/utils/format'

const props = defineProps<{ stats: MemoryStats }>()

const { t } = useI18n()

const plain = 'text-gray-900 dark:text-white'

const items = computed(() => [
  {
    key: 'opted-in',
    label: t('admin.claudexMemory.stats.optedIn'),
    hint: t('admin.claudexMemory.stats.optedInHint'),
    value: formatNumber(props.stats.users_opted_in),
    tone: plain
  },
  {
    key: 'with-memory',
    label: t('admin.claudexMemory.stats.withMemory'),
    hint: '',
    value: formatNumber(props.stats.users_with_memory),
    tone: plain
  },
  {
    key: 'documents',
    label: t('admin.claudexMemory.stats.documents'),
    hint: '',
    value: formatNumber(props.stats.documents),
    tone: plain
  },
  {
    key: 'edits',
    label: t('admin.claudexMemory.stats.edits'),
    hint: '',
    value: formatNumber(props.stats.edits),
    tone: plain
  },
  {
    key: 'size',
    label: t('admin.claudexMemory.stats.size'),
    hint: '',
    value: formatBytes(props.stats.total_bytes, 1),
    tone: plain
  },
  {
    key: 'key',
    label: t('admin.claudexMemory.stats.keyReady'),
    hint: '',
    value: props.stats.encryption_key_ready
      ? t('admin.claudexMemory.stats.ready')
      : t('admin.claudexMemory.stats.missing'),
    tone: props.stats.encryption_key_ready
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-amber-600 dark:text-amber-400'
  }
])
</script>

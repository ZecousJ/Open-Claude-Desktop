<template>
  <HelpTooltip
    v-if="balance != null"
    class="-ml-1"
    width-class="w-max max-w-[calc(100vw-2rem)]"
    data-testid="upstream-balance-details"
  >
    <template #trigger>
      <span
        class="cursor-help border-b border-dotted border-gray-300 font-mono text-sm font-medium dark:border-dark-600"
        :class="stale ? 'text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'"
        data-testid="upstream-balance"
      >
        {{ formatBalance(balance) }}
      </span>
    </template>
    <div class="space-y-1">
      <p>{{ t('admin.accounts.upstreamBalance.updatedAt', { value: formatDate(snapshot?.received_at) }) }}</p>
      <p v-if="stale" class="text-amber-300" data-testid="upstream-balance-stale">
        {{ t('admin.accounts.upstreamBalance.stale') }}
      </p>
      <p class="text-gray-300">{{ t('admin.accounts.upstreamBalance.shared') }}</p>
    </div>
  </HelpTooltip>
  <span v-else class="text-sm text-gray-400 dark:text-dark-500" data-testid="upstream-balance-empty">-</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import HelpTooltip from '@/components/common/HelpTooltip.vue'
import type { Account, UpstreamBillingProbeSnapshot } from '@/types'

// Claudex: the upstream wallet the account's API key draws on. Each billing
// probe of a Sub2API upstream also reads the key's /v1/usage and keeps its
// "balance" in the snapshot (wallet_balance); accounts on one upstream site
// share it.
const props = defineProps<{
  account: Account
  now: number
}>()

const { t } = useI18n()
const snapshot = computed<UpstreamBillingProbeSnapshot | undefined>(() =>
  props.account.type === 'apikey' ? props.account.extra?.upstream_billing_probe : undefined
)
const balance = computed(() => {
  const value = snapshot.value?.data?.wallet_balance
  return typeof value === 'number' && Number.isFinite(value) ? value : null
})
// A balance read before the snapshot's fresh window ended is still current.
const stale = computed(() => {
  const freshUntil = Date.parse(snapshot.value?.fresh_until ?? '')
  return Number.isFinite(freshUntil) && props.now > freshUntil
})
const formatBalance = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const formatDate = (value?: string) => value
  ? new Date(value).toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  : '-'
</script>

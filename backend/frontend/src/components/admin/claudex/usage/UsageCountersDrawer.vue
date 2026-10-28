<!--
  CLAUDEX: side panel with one rule's usage counters, one row per user in
  their current (or last) window (GET /admin/claudex/usage-rules/:id/counters).
  Resetting a counter asks for confirmation and goes through step-up.
-->
<template>
  <Teleport to="body">
    <div v-if="show && rule" class="fixed inset-0 z-50 flex justify-end" data-testid="claudex-counters-drawer">
      <div class="absolute inset-0 bg-black/40" @click="emit('close')"></div>
      <aside
        class="relative flex h-full w-full max-w-3xl flex-col bg-white shadow-xl dark:bg-dark-900"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
      >
        <header class="flex items-start justify-between gap-4 border-b border-gray-200 p-5 dark:border-dark-700">
          <div class="min-w-0">
            <h3 :id="titleId" class="truncate text-base font-semibold text-gray-900 dark:text-white">
              {{ t('admin.claudexUsageRules.counters.title', { label: rule.label }) }}
            </h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{
                t('admin.claudexUsageRules.counters.summary', {
                  limit: formatUsd(rule.limit_usd),
                  window: windowText(rule.window_seconds)
                })
              }}
            </p>
          </div>
          <button
            type="button"
            class="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-dark-700"
            :aria-label="t('admin.claudexUsageRules.counters.close')"
            @click="emit('close')"
          >
            <Icon name="x" size="md" />
          </button>
        </header>

        <div class="flex-1 space-y-4 overflow-y-auto p-5">
          <UserSearchSelect v-model="userFilter" :label="t('admin.claudexUsageRules.counters.filterUser')" />

          <div
            v-if="loadError"
            role="alert"
            class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
          >
            {{ loadError }}
          </div>

          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('admin.claudexUsageRules.counters.user') }}</th>
                  <th>{{ t('admin.claudexUsageRules.counters.used') }}</th>
                  <th>{{ t('admin.claudexUsageRules.counters.requests') }}</th>
                  <th>{{ t('admin.claudexUsageRules.counters.window') }}</th>
                  <th class="text-right">{{ t('admin.claudexUsageRules.columns.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loading && counters.length === 0">
                  <td colspan="5" class="py-6 text-center text-gray-500">{{ t('admin.claudex.common.loading') }}</td>
                </tr>
                <tr v-else-if="counters.length === 0">
                  <td colspan="5" class="py-6 text-center text-gray-500" data-testid="claudex-counters-empty">
                    {{ t('admin.claudexUsageRules.counters.empty') }}
                  </td>
                </tr>
                <tr v-for="counter in counters" :key="counter.user_id" data-testid="claudex-counter-row">
                  <td class="max-w-[14rem]">
                    <span class="block truncate">{{ counter.user_email || `#${counter.user_id}` }}</span>
                    <span class="text-xs text-gray-400">#{{ counter.user_id }}</span>
                  </td>
                  <td class="whitespace-nowrap">
                    <span :class="isOver(counter) ? 'font-medium text-red-600 dark:text-red-400' : ''">{{
                      formatUsd(counter.used_usd)
                    }}</span>
                    <span class="text-xs text-gray-400"> / {{ formatUsd(rule.limit_usd) }}</span>
                  </td>
                  <td class="whitespace-nowrap">{{ counter.request_count }}</td>
                  <td class="min-w-[11rem] text-xs">
                    <template v-if="isActive(counter)">
                      <span class="block">{{
                        t('admin.claudexUsageRules.counters.resetsAt', { time: formatDateTime(counter.window_end) })
                      }}</span>
                      <span class="block text-gray-400">{{
                        t('admin.claudexUsageRules.counters.startedAt', { time: formatDateTime(counter.window_start) })
                      }}</span>
                    </template>
                    <template v-else>
                      <span class="block text-gray-500">{{
                        t('admin.claudexUsageRules.counters.windowEnded', { time: formatDateTime(counter.window_end) })
                      }}</span>
                      <span class="block text-gray-400">{{ t('admin.claudexUsageRules.counters.nextWindow') }}</span>
                    </template>
                  </td>
                  <td class="whitespace-nowrap text-right">
                    <button
                      type="button"
                      class="btn btn-secondary btn-sm"
                      data-testid="claudex-counter-reset"
                      @click="reset(counter)"
                    >
                      {{ t('admin.claudexUsageRules.counters.reset') }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <Pagination
            v-if="total > pageSize"
            :total="total"
            :page="page"
            :page-size="pageSize"
            :show-page-size-selector="false"
            @update:page="load"
          />
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import Pagination from '@/components/common/Pagination.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import type { StepUpController } from '@/composables/useStepUp'
import { useAppStore } from '@/stores'
import { listCounters, resetCounter, type UsageCounter, type UsageRule } from '@/api/admin/claudex/usageRules'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { formatDateTime } from '@/utils/format'
import UserSearchSelect from '@/components/admin/claudex/devices/UserSearchSelect.vue'
import type { ConfirmController } from '@/components/admin/claudex/devices/useConfirm'
import type { PickedUser } from '@/components/admin/claudex/devices/types'
import { formatUsd, windowLabel } from './rules'

const props = defineProps<{
  show: boolean
  rule: UsageRule | null
  stepUp: StepUpController
  confirm: ConfirmController
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { t, te } = useI18n()
const appStore = useAppStore()
const action = useClaudexSave('claudexUsageRules')
const titleId = `claudex-counters-${useId()}`

const counters = ref<UsageCounter[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const loadError = ref('')
const userFilter = ref<PickedUser | null>(null)
let seq = 0

function windowText(seconds: number): string {
  const label = windowLabel(seconds)
  return t(label.key, label.params ?? {})
}

function isActive(counter: UsageCounter): boolean {
  return new Date(counter.window_end).getTime() > Date.now()
}

function isOver(counter: UsageCounter): boolean {
  return !!props.rule && isActive(counter) && Number(counter.used_usd) >= Number(props.rule.limit_usd)
}

async function load(toPage?: number) {
  if (!props.rule) return
  if (typeof toPage === 'number') page.value = toPage
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const result = await listCounters(props.rule.id, {
      user_id: userFilter.value?.id ?? null,
      page: page.value,
      page_size: pageSize
    })
    if (mine !== seq) return
    counters.value = result.items ?? []
    total.value = result.total ?? counters.value.length
  } catch (err) {
    if (mine !== seq) return
    loadError.value = claudexErrorMessage(err, t, te, 'claudexUsageRules', t('admin.claudexUsageRules.counters.loadFailed'))
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(
  () => [props.show, props.rule?.id] as const,
  ([show]) => {
    if (!show) return
    userFilter.value = null
    counters.value = []
    void load(1)
  },
  { immediate: true }
)

watch(
  () => userFilter.value?.id,
  () => {
    if (props.show) void load(1)
  }
)

async function reset(counter: UsageCounter) {
  const rule = props.rule
  if (!rule) return
  const ok = await props.confirm.ask({
    title: t('admin.claudexUsageRules.counters.confirmTitle'),
    message: t('admin.claudexUsageRules.counters.confirmMessage', {
      user: counter.user_email || `#${counter.user_id}`,
      label: rule.label
    }),
    confirmText: t('admin.claudexUsageRules.counters.reset'),
    danger: true
  })
  if (!ok) return
  const result = await action.run(() => props.stepUp.run(() => resetCounter(rule.id, counter.user_id)))
  if (result.ok) {
    appStore.showSuccess(t('admin.claudexUsageRules.counters.resetDone'))
    await load()
  } else if (!result.cancelled && action.error.value) {
    appStore.showError(action.error.value)
  }
}
</script>

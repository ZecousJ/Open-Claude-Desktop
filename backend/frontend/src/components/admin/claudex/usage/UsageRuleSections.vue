<!--
  CLAUDEX: usage rules in one table, one section per group ("All groups"
  first). Emits the row actions; the page does the work.
-->
<template>
  <div class="table-container" data-testid="claudex-rule-table">
    <table class="table">
      <thead>
        <tr>
          <th>{{ t('admin.claudexUsageRules.columns.label') }}</th>
          <th>{{ t('admin.claudexUsageRules.columns.kind') }}</th>
          <th>{{ t('admin.claudexUsageRules.columns.models') }}</th>
          <th>{{ t('admin.claudexUsageRules.columns.window') }}</th>
          <th>{{ t('admin.claudexUsageRules.columns.limit') }}</th>
          <th>{{ t('admin.claudexUsageRules.columns.state') }}</th>
          <th>{{ t('admin.claudexUsageRules.columns.sort') }}</th>
          <th class="text-right">{{ t('admin.claudexUsageRules.columns.actions') }}</th>
        </tr>
      </thead>
      <tbody v-for="section in sections" :key="section.groupId ?? 'all'" data-testid="claudex-rule-section">
        <tr class="bg-gray-50 dark:bg-dark-800/60">
          <td colspan="8" class="py-2">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
                {{ section.groupName }}
                <span
                  v-if="section.groupDeleted"
                  class="badge badge-danger ml-1 normal-case tracking-normal"
                  data-testid="claudex-rule-section-deleted"
                  >{{ t('admin.claudexUsageRules.groupDeleted') }}</span
                >
              </span>
              <button
                v-if="!section.groupDeleted"
                type="button"
                class="btn btn-ghost btn-sm"
                :data-testid="`claudex-rule-add-${section.groupId ?? 'all'}`"
                @click="emit('create', section.groupId)"
              >
                <Icon name="plus" size="sm" class="mr-1" />{{ t('admin.claudexUsageRules.addToGroup') }}
              </button>
            </div>
          </td>
        </tr>
        <tr v-if="section.rules.length === 0">
          <td colspan="8" class="py-4 text-center text-sm text-gray-500" data-testid="claudex-rule-section-empty">
            {{ t('admin.claudexUsageRules.sectionEmpty') }}
          </td>
        </tr>
        <tr v-for="rule in section.rules" :key="rule.id" data-testid="claudex-rule-row">
          <td class="max-w-[14rem]">
            <span class="block truncate font-medium text-gray-900 dark:text-white" :title="rule.label">{{
              rule.label
            }}</span>
            <span class="text-xs text-gray-400">#{{ rule.id }}</span>
          </td>
          <td class="whitespace-nowrap">{{ t(`admin.claudexUsageRules.kinds.${rule.kind}`) }}</td>
          <td class="max-w-[16rem]">
            <span v-if="rule.kind !== 'models'" class="text-gray-500">{{
              t('admin.claudexUsageRules.allModels')
            }}</span>
            <span v-else class="block truncate font-mono text-xs" :title="rule.model_patterns.join(', ')">{{
              rule.model_patterns.join(', ')
            }}</span>
          </td>
          <td class="whitespace-nowrap" data-testid="claudex-rule-window-cell">{{ windowText(rule.window_seconds) }}</td>
          <td class="whitespace-nowrap">{{ formatUsd(rule.limit_usd) }}</td>
          <td class="whitespace-nowrap">
            <span class="badge" :class="rule.enabled ? 'badge-success' : 'badge-gray'">{{
              rule.enabled ? t('admin.claudexUsageRules.enabled') : t('admin.claudexUsageRules.disabled')
            }}</span>
            <span v-if="rule.show_in_client" class="badge badge-primary ml-1">{{
              t('admin.claudexUsageRules.shownInClaudex')
            }}</span>
          </td>
          <td class="whitespace-nowrap">{{ rule.sort_order }}</td>
          <td class="whitespace-nowrap text-right">
            <div class="inline-flex items-center gap-1">
              <button
                type="button"
                class="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-dark-600 dark:hover:text-gray-300"
                :title="t('admin.claudexUsageRules.actions.counters')"
                :aria-label="t('admin.claudexUsageRules.actions.counters')"
                data-testid="claudex-rule-counters"
                @click="emit('counters', rule)"
              >
                <Icon name="chartBar" size="sm" />
              </button>
              <button
                type="button"
                class="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-dark-600 dark:hover:text-gray-300"
                :title="t('admin.claudexUsageRules.actions.edit')"
                :aria-label="t('admin.claudexUsageRules.actions.edit')"
                data-testid="claudex-rule-edit"
                @click="emit('edit', rule)"
              >
                <Icon name="edit" size="sm" />
              </button>
              <button
                type="button"
                class="rounded-lg p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                :title="t('admin.claudexUsageRules.actions.delete')"
                :aria-label="t('admin.claudexUsageRules.actions.delete')"
                data-testid="claudex-rule-delete"
                @click="emit('delete', rule)"
              >
                <Icon name="trash" size="sm" />
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import type { UsageRule } from '@/api/admin/claudex/usageRules'
import { formatUsd, windowLabel, type RuleSection } from './rules'

defineProps<{ sections: RuleSection[] }>()

const emit = defineEmits<{
  (e: 'create', groupId: number | null): void
  (e: 'edit', rule: UsageRule): void
  (e: 'counters', rule: UsageRule): void
  (e: 'delete', rule: UsageRule): void
}>()

const { t } = useI18n()

function windowText(seconds: number): string {
  const label = windowLabel(seconds)
  return t(label.key, label.params ?? {})
}
</script>

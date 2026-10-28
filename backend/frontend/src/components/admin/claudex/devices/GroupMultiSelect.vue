<!--
  CLAUDEX: checkbox list of groups (the provisioning card's "Allowed groups").
  Ids that are no longer in the list (deleted or inactive groups) stay
  selected and are shown so they can be removed.
-->
<template>
  <div>
    <div class="flex items-center justify-between">
      <span class="input-label">{{ label }}</span>
      <span class="text-xs text-gray-400">{{
        modelValue.length === 0
          ? t('admin.claudexDevices.provisioning.allowedGroupsAll')
          : t('admin.claudexDevices.provisioning.allowedGroupsCount', { count: modelValue.length })
      }}</span>
    </div>
    <input
      v-if="groups.length > 8"
      v-model="search"
      type="search"
      class="input mt-1.5 w-full"
      :placeholder="t('admin.claudexDevices.provisioning.groupSearch')"
      data-testid="claudex-group-search"
    />
    <div
      class="mt-1.5 grid max-h-44 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-dark-600 dark:bg-dark-800 sm:grid-cols-2"
    >
      <label
        v-for="group in visibleGroups"
        :key="group.id"
        class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-white dark:hover:bg-dark-700"
        data-testid="claudex-group-option"
      >
        <input
          type="checkbox"
          class="h-3.5 w-3.5 rounded border-gray-300 text-primary-500 focus:ring-primary-500 dark:border-dark-500"
          :checked="modelValue.includes(group.id)"
          :value="group.id"
          @change="toggle(group.id, ($event.target as HTMLInputElement).checked)"
        />
        <GroupBadge
          :name="group.name"
          :platform="group.platform"
          :subscription-type="group.subscription_type || undefined"
          :show-rate="false"
          class="min-w-0 flex-1"
        />
      </label>
      <label
        v-for="id in missingIds"
        :key="`missing-${id}`"
        class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-amber-700 hover:bg-white dark:text-amber-400 dark:hover:bg-dark-700"
      >
        <input
          type="checkbox"
          class="h-3.5 w-3.5 rounded border-gray-300 text-primary-500 focus:ring-primary-500 dark:border-dark-500"
          checked
          @change="toggle(id, ($event.target as HTMLInputElement).checked)"
        />
        {{ t('admin.claudexDevices.provisioning.missingGroup', { id }) }}
      </label>
      <p v-if="groups.length === 0 && missingIds.length === 0" class="col-span-full py-2 text-center text-sm text-gray-500">
        {{ t('admin.claudexDevices.provisioning.noGroups') }}
      </p>
    </div>
    <p v-if="hint" class="input-hint mt-1.5">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import GroupBadge from '@/components/common/GroupBadge.vue'
import type { AdminGroup } from '@/types'

const props = withDefaults(
  defineProps<{
    modelValue: number[]
    groups: AdminGroup[]
    label: string
    hint?: string
  }>(),
  { hint: '' }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: number[]): void }>()

const { t } = useI18n()
const search = ref('')

const visibleGroups = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.groups
  return props.groups.filter((g) => g.name.toLowerCase().includes(q) || props.modelValue.includes(g.id))
})

const missingIds = computed(() => props.modelValue.filter((id) => !props.groups.some((g) => g.id === id)))

function toggle(id: number, checked: boolean) {
  const next = props.modelValue.filter((value) => value !== id)
  if (checked) next.push(id)
  emit('update:modelValue', next)
}
</script>

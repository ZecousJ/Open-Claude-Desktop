<!--
  CLAUDEX: user search for the client policy page (user overrides and the
  preview). Searches /admin/users by email or name as the admin types and
  emits the chosen user.
-->
<template>
  <div class="relative" data-testid="policy-user-picker">
    <label v-if="label" :for="inputId" class="input-label mb-1.5 block">{{ label }}</label>
    <input
      :id="inputId"
      v-model="query"
      type="text"
      autocomplete="off"
      spellcheck="false"
      class="input w-full"
      :placeholder="t('admin.claudexPolicy.users.searchPlaceholder')"
      :disabled="disabled"
      role="combobox"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="`${inputId}-list`"
      data-testid="policy-user-search"
      @input="onInput"
      @focus="open = results.length > 0"
      @keydown.escape="open = false"
    />
    <div
      v-if="open"
      :id="`${inputId}-list`"
      role="listbox"
      class="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-dark-500 dark:bg-dark-700"
    >
      <p v-if="searching" class="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.users.searching') }}
      </p>
      <p v-else-if="results.length === 0" class="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.users.noResults') }}
      </p>
      <template v-else>
        <button
          v-for="user in results"
          :key="user.id"
          type="button"
          role="option"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-dark-600"
          :disabled="excludedIds.includes(user.id)"
          :aria-selected="false"
          data-testid="policy-user-option"
          @click="choose(user)"
        >
          <span class="text-gray-400">#{{ user.id }}</span>
          <span class="min-w-0 truncate text-gray-900 dark:text-white">{{ user.email }}</span>
          <span v-if="user.username" class="truncate text-xs text-gray-400">{{ user.username }}</span>
          <span v-if="excludedIds.includes(user.id)" class="ml-auto text-xs text-gray-400">
            {{ t('admin.claudexPolicy.users.alreadyAdded') }}
          </span>
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { list as listUsers } from '@/api/admin/users'
import type { PickedUser } from './policyForm'

withDefaults(
  defineProps<{
    label?: string
    /** Users that can't be chosen (they already have an override). */
    excludedIds?: number[]
    disabled?: boolean
  }>(),
  { label: '', excludedIds: () => [], disabled: false }
)

const emit = defineEmits<{ (e: 'select', user: PickedUser): void }>()

const { t } = useI18n()
const inputId = `policy-user-${useId()}`
const query = ref('')
const results = ref<PickedUser[]>([])
const open = ref(false)
const searching = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let sequence = 0

function onInput(): void {
  clearTimeout(timer)
  const text = query.value.trim()
  if (!text) {
    results.value = []
    open.value = false
    return
  }
  timer = setTimeout(() => void search(text), 300)
}

async function search(text: string): Promise<void> {
  const current = ++sequence
  searching.value = true
  open.value = true
  try {
    const page = await listUsers(1, 10, { search: text })
    if (current !== sequence) return
    results.value = (page.items ?? []).map((user) => ({ id: user.id, email: user.email, username: user.username }))
  } catch {
    if (current === sequence) results.value = []
  } finally {
    if (current === sequence) searching.value = false
  }
}

function choose(user: PickedUser): void {
  emit('select', user)
  query.value = ''
  results.value = []
  open.value = false
}

onBeforeUnmount(() => clearTimeout(timer))

defineExpose({ search })
</script>

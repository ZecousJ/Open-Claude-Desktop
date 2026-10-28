<!--
  CLAUDEX: pick one user by email, name or user ID (admin user search). Used by
  the devices page (filter, device limit) and the usage rules page (counters,
  usage status).
-->
<template>
  <div ref="rootRef" class="relative w-full">
    <label v-if="label" :for="inputId" class="input-label mb-1.5 block">{{ label }}</label>
    <div
      v-if="modelValue"
      class="input flex min-h-[2.5rem] w-full items-center justify-between gap-2 py-1.5"
      data-testid="claudex-user-selected"
    >
      <span class="min-w-0 truncate text-sm">
        <span class="font-medium text-gray-900 dark:text-white">{{ selectedText }}</span>
        <span class="ml-1 text-xs text-gray-400">#{{ modelValue.id }}</span>
      </span>
      <button
        type="button"
        class="rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        :aria-label="t('admin.claudexDevices.userSearch.clear')"
        data-testid="claudex-user-clear"
        @click="clear"
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
    <input
      v-else
      :id="inputId"
      v-model="query"
      type="search"
      autocomplete="off"
      spellcheck="false"
      class="input w-full"
      :placeholder="placeholder || t('admin.claudexDevices.userSearch.placeholder')"
      :aria-expanded="open ? 'true' : 'false'"
      data-testid="claudex-user-search"
      @input="onInput"
      @focus="open = options.length > 0"
      @keydown.escape="open = false"
    />
    <ul
      v-if="open && !modelValue"
      class="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-dark-600 dark:bg-dark-800"
      role="listbox"
      data-testid="claudex-user-options"
    >
      <li v-if="searching" class="px-3 py-2 text-sm text-gray-500">{{ t('admin.claudex.common.loading') }}</li>
      <li
        v-else-if="options.length === 0"
        class="px-3 py-2 text-sm text-gray-500"
        data-testid="claudex-user-no-results"
      >
        {{ t('admin.claudexDevices.userSearch.noResults') }}
      </li>
      <li v-for="option in options" :key="option.id">
        <button
          type="button"
          role="option"
          class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-dark-700"
          data-testid="claudex-user-option"
          @click="select(option)"
        >
          <span class="min-w-0 truncate">
            <span class="text-gray-900 dark:text-white">{{
              option.email || t('admin.claudexDevices.userSearch.userId', { id: option.id })
            }}</span>
            <span v-if="option.username" class="ml-1 text-xs text-gray-400">{{ option.username }}</span>
          </span>
          <span class="flex-shrink-0 text-xs text-gray-400">#{{ option.id }}</span>
        </button>
      </li>
    </ul>
    <p v-if="error" class="input-error-text mt-1.5">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import { list as listUsers } from '@/api/admin/users'
import { extractApiErrorMessage } from '@/utils/apiError'
import type { PickedUser } from './types'

const props = withDefaults(
  defineProps<{
    modelValue: PickedUser | null
    label?: string
    placeholder?: string
    id?: string
    /** Milliseconds to wait after typing before searching. */
    debounce?: number
  }>(),
  { label: '', placeholder: '', id: undefined, debounce: 300 }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: PickedUser | null): void }>()

const { t } = useI18n()
const generatedId = useId()
const inputId = computed(() => props.id || `claudex-user-${generatedId}`)
const rootRef = ref<HTMLElement | null>(null)
const query = ref('')
const options = ref<PickedUser[]>([])
const open = ref(false)
const searching = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const selectedText = computed(() =>
  props.modelValue?.email || t('admin.claudexDevices.userSearch.userId', { id: props.modelValue?.id ?? '' })
)

function onInput() {
  if (timer) clearTimeout(timer)
  const text = query.value.trim()
  error.value = ''
  if (!text) {
    options.value = []
    open.value = false
    return
  }
  timer = setTimeout(() => void search(text), props.debounce)
}

async function search(text: string) {
  const mine = ++seq
  searching.value = true
  open.value = true
  const byId: PickedUser[] = /^\d{1,15}$/.test(text) && Number(text) > 0 ? [{ id: Number(text), email: '' }] : []
  try {
    const page = await listUsers(1, 8, { search: text })
    if (mine !== seq) return
    const found = (page.items ?? []).map((u) => ({ id: u.id, email: u.email, username: u.username }))
    options.value = [...byId.filter((b) => !found.some((f) => f.id === b.id)), ...found]
  } catch (err) {
    if (mine !== seq) return
    options.value = byId
    error.value = extractApiErrorMessage(err, t('admin.claudexDevices.userSearch.failed'))
  } finally {
    if (mine === seq) searching.value = false
  }
}

function select(option: PickedUser) {
  emit('update:modelValue', option)
  open.value = false
  query.value = ''
  options.value = []
}

function clear() {
  emit('update:modelValue', null)
}

function onDocumentClick(event: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(event.target as Node)) open.value = false
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  if (timer) clearTimeout(timer)
})
</script>

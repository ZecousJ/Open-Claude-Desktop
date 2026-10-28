<!--
  CLAUDEX: one user's memory metadata (GET /admin/claudex/memory/users/:id)
  and clearing it (DELETE, confirmed first, then step-up). The server sends
  sizes, revisions, sources and dates only, never memory text, so nothing
  here can show what a user's memory says.
-->
<template>
  <section class="card" data-testid="claudex-memory-user-card">
    <div class="card-header">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        {{ t('admin.claudexMemory.user.title') }}
      </h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexMemory.user.description') }}
      </p>
    </div>
    <div class="card-body space-y-4">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,24rem)_auto] md:items-end">
        <UserSearchSelect v-model="user" :label="t('admin.claudexMemory.user.pick')" />
        <div v-if="user" class="flex flex-wrap gap-2">
          <button
            type="button"
            class="btn btn-danger"
            :disabled="!meta || !hasMemory || clearing.saving.value"
            data-testid="claudex-memory-clear"
            @click="clearMemory"
          >
            {{ t('admin.claudexMemory.user.clear') }}
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="loading"
            :title="t('admin.claudex.common.reload')"
            :aria-label="t('admin.claudex.common.reload')"
            data-testid="claudex-memory-user-reload"
            @click="load"
          >
            <Icon name="refresh" size="md" :class="loading ? 'animate-spin' : ''" />
          </button>
        </div>
      </div>

      <p v-if="!user" class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-memory-user-pick">
        {{ t('admin.claudexMemory.user.pickHint') }}
      </p>
      <template v-else>
        <div
          v-if="error"
          role="alert"
          class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
          data-testid="claudex-memory-user-error"
        >
          {{ error }}
        </div>
        <div v-if="loading && !meta" class="py-6 text-center text-sm text-gray-500">
          {{ t('admin.claudex.common.loading') }}
        </div>

        <template v-if="meta">
          <div
            class="flex flex-col gap-3 rounded-lg border border-gray-100 p-4 dark:border-dark-700 sm:flex-row sm:items-start sm:justify-between"
            data-testid="claudex-memory-user-prefs"
          >
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-white">
                {{ t('admin.claudexMemory.user.switches') }}
              </p>
              <p v-if="meta.prefs.set && meta.prefs.updated_at" class="mt-0.5 text-xs text-gray-400">
                {{ t('admin.claudexMemory.user.changed', { time: formatDateTime(meta.prefs.updated_at) }) }}
              </p>
            </div>
            <dl class="space-y-1 text-sm sm:text-right">
              <div class="flex justify-between gap-6 sm:justify-end">
                <dt class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexMemory.user.searchChats') }}</dt>
                <dd class="text-gray-900 dark:text-gray-100" data-testid="claudex-memory-pref-search">
                  {{ switchText(meta.prefs.set, meta.prefs.search_chats) }}
                </dd>
              </div>
              <div class="flex justify-between gap-6 sm:justify-end">
                <dt class="text-gray-500 dark:text-gray-400">{{ t('admin.claudexMemory.user.generate') }}</dt>
                <dd class="text-gray-900 dark:text-gray-100" data-testid="claudex-memory-pref-generate">
                  {{ switchText(meta.prefs.set, meta.prefs.generate) }}
                </dd>
              </div>
            </dl>
          </div>

          <p class="text-sm text-gray-600 dark:text-gray-300" data-testid="claudex-memory-user-summary">
            {{
              t('admin.claudexMemory.user.summary', {
                documents: meta.documents,
                edits: meta.edits,
                size: formatBytes(meta.total_bytes, 1)
              })
            }}
          </p>

          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('admin.claudexMemory.columns.scope') }}</th>
                  <th>{{ t('admin.claudexMemory.columns.document') }}</th>
                  <th>{{ t('admin.claudexMemory.columns.source') }}</th>
                  <th class="text-right">{{ t('admin.claudexMemory.columns.revision') }}</th>
                  <th class="text-right">{{ t('admin.claudexMemory.columns.edits') }}</th>
                  <th>{{ t('admin.claudexMemory.columns.updated') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="meta.scopes.length === 0">
                  <td colspan="6" class="py-6 text-center text-gray-500" data-testid="claudex-memory-user-empty">
                    {{ t('admin.claudexMemory.user.empty') }}
                  </td>
                </tr>
                <tr v-for="scope in meta.scopes" :key="scope.scope" data-testid="claudex-memory-scope-row">
                  <td class="whitespace-nowrap">
                    <span class="font-medium text-gray-900 dark:text-white" :title="scope.scope">
                      {{ scopeLabel(scope.scope) }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap tabular-nums">
                    {{ scope.has_document ? formatBytes(scope.content_bytes, 1) : t('admin.claudexMemory.noDocument') }}
                  </td>
                  <td class="whitespace-nowrap">
                    <span>{{ sourceLabel(scope) }}</span>
                    <span v-if="scope.generated_at" class="block text-xs text-gray-400">
                      {{ t('admin.claudexMemory.generatedAt', { time: formatDateTime(scope.generated_at) }) }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap text-right tabular-nums">
                    {{ scope.has_document ? scope.revision : '—' }}
                  </td>
                  <td class="whitespace-nowrap text-right tabular-nums">
                    {{ scope.edits }}
                    <span v-if="scope.edits > 0" class="text-xs text-gray-400">
                      ({{ formatBytes(scope.edit_bytes, 1) }})
                    </span>
                  </td>
                  <td class="whitespace-nowrap">
                    {{ scope.updated_at ? formatDateTime(scope.updated_at) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import UserSearchSelect from '@/components/admin/claudex/devices/UserSearchSelect.vue'
import type { PickedUser } from '@/components/admin/claudex/devices/types'
import type { ConfirmController } from '@/components/admin/claudex/devices/useConfirm'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import type { StepUpController } from '@/composables/useStepUp'
import { clearUser, getUser, type MemoryScopeMeta, type MemoryUserMeta } from '@/api/admin/claudex/memory'
import { useAppStore } from '@/stores'
import { formatBytes, formatDateTime } from '@/utils/format'

const props = defineProps<{
  stepUp: StepUpController
  confirm: ConfirmController
}>()

const emit = defineEmits<{ (e: 'cleared'): void }>()

const { t, te } = useI18n()
const appStore = useAppStore()

const user = ref<PickedUser | null>(null)
const meta = ref<MemoryUserMeta | null>(null)
const loading = ref(false)
const error = ref('')
const clearing = useClaudexSave('claudexMemory')
let seq = 0

const hasMemory = computed(() => !!meta.value && (meta.value.documents > 0 || meta.value.edits > 0))

async function load() {
  const picked = user.value
  const mine = ++seq
  error.value = ''
  if (!picked) {
    meta.value = null
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = await getUser(picked.id)
    if (mine !== seq) return
    meta.value = result
  } catch (err) {
    if (mine !== seq) return
    meta.value = null
    error.value = claudexErrorMessage(err, t, te, 'claudexMemory', t('admin.claudexMemory.user.loadFailed'))
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(
  () => user.value?.id,
  () => {
    // Never show (or clear) the previous user's memory under the new user.
    meta.value = null
    void load()
  }
)

function switchText(set: boolean, value: boolean | null): string {
  if (!set || value === null) return t('admin.claudexMemory.user.notSet')
  return value ? t('admin.claudexMemory.user.on') : t('admin.claudexMemory.user.off')
}

function scopeLabel(scope: string): string {
  if (scope === 'global') return t('admin.claudexMemory.scope.global')
  if (scope.startsWith('project:')) {
    return t('admin.claudexMemory.scope.project', { id: scope.slice('project:'.length, 'project:'.length + 8) })
  }
  return scope
}

function sourceLabel(scope: MemoryScopeMeta): string {
  if (!scope.has_document || !scope.source) return t('admin.claudexMemory.source.none')
  const key = `admin.claudexMemory.source.${scope.source}`
  return te(key) ? t(key) : scope.source
}

async function clearMemory() {
  const picked = user.value
  if (!picked || !meta.value) return
  const ok = await props.confirm.ask({
    title: t('admin.claudexMemory.user.clearTitle'),
    message: t('admin.claudexMemory.user.clearMessage', {
      user: picked.email || t('admin.claudexMemory.user.userId', { id: picked.id })
    }),
    confirmText: t('admin.claudexMemory.user.clear'),
    danger: true
  })
  if (!ok || user.value?.id !== picked.id) return
  const result = await clearing.run(() => runWithStepUp(props.stepUp, () => clearUser(picked.id), t))
  if (result.ok) {
    appStore.showSuccess(
      t('admin.claudexMemory.user.cleared', {
        documents: result.value?.deleted_docs ?? 0,
        edits: result.value?.deleted_edits ?? 0
      })
    )
    emit('cleared')
  } else if (!result.cancelled && clearing.error.value) {
    appStore.showError(clearing.error.value)
  }
  if (user.value?.id === picked.id) await load()
}
</script>

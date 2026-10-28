<!--
  CLAUDEX: runners of the web app (GET /admin/claudex/web/runners): the local
  runner next to the server and the runners registered with a token. An
  administrator adds a runner (its token is shown once), renames it, switches
  it off or on, drains it (it finishes current work and takes no new users) or
  revokes its token for good. Every write is confirmed first where it cuts a
  runner off, and goes through step-up.
-->
<template>
  <section class="card" data-testid="claudex-web-runners">
    <div class="card-header flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexWeb.runners.title') }}</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexWeb.runners.description') }}</p>
      </div>
      <div class="flex flex-shrink-0 gap-2">
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="loading"
          :title="t('admin.claudex.common.reload')"
          data-testid="claudex-web-runners-reload"
          @click="load()"
        >
          <Icon name="refresh" size="md" :class="loading ? 'animate-spin' : ''" />
        </button>
        <button type="button" class="btn btn-primary" data-testid="claudex-web-runners-add" @click="openCreate">
          <Icon name="plus" size="md" class="mr-1.5" />
          {{ t('admin.claudexWeb.runners.add') }}
        </button>
      </div>
    </div>

    <div class="card-body space-y-4">
      <div
        v-if="loadError"
        role="alert"
        class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
        data-testid="claudex-web-runners-error"
      >
        {{ loadError }}
      </div>
      <div
        v-if="actionError"
        role="alert"
        class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
        data-testid="claudex-web-runners-action-error"
      >
        {{ actionError }}
      </div>

      <p v-if="view" class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-web-runners-summary">
        {{
          t('admin.claudexWeb.runners.summary', {
            runs: view.active_runs,
            tabs: view.users_with_open_tabs
          })
        }}
      </p>

      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('admin.claudexWeb.runners.name') }}</th>
              <th>{{ t('admin.claudexWeb.runners.status') }}</th>
              <th>{{ t('admin.claudexWeb.runners.version') }}</th>
              <th>{{ t('admin.claudexWeb.runners.capacity') }}</th>
              <th>{{ t('admin.claudexWeb.runners.users') }}</th>
              <th>{{ t('admin.claudexWeb.runners.lastSeen') }}</th>
              <th class="text-right">{{ t('admin.claudexWeb.runners.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading && runners.length === 0">
              <td colspan="7" class="py-8 text-center text-gray-500">{{ t('admin.claudex.common.loading') }}</td>
            </tr>
            <tr v-else-if="runners.length === 0">
              <td colspan="7" class="py-8 text-center text-gray-500" data-testid="claudex-web-runners-empty">
                {{ t('admin.claudexWeb.runners.empty') }}
              </td>
            </tr>
            <tr
              v-for="runner in runners"
              :key="runner.id"
              :class="runner.revoked_at ? 'opacity-60' : ''"
              data-testid="claudex-web-runner-row"
            >
              <td class="max-w-[16rem]">
                <span class="block truncate font-medium text-gray-900 dark:text-white" :title="runner.name">
                  {{ runner.name || runner.id }}
                </span>
                <span class="text-xs text-gray-400">
                  {{
                    runner.local
                      ? t('admin.claudexWeb.runners.localRunner')
                      : t('admin.claudexWeb.runners.created', { date: formatDateTime(runner.created_at) })
                  }}
                </span>
              </td>
              <td class="whitespace-nowrap">
                <span class="badge" :class="statusBadge(runner)" data-testid="claudex-web-runner-status">
                  {{ statusLabel(runner) }}
                </span>
                <span
                  v-if="runner.draining && !runner.revoked_at"
                  class="badge badge-warning ml-1"
                  data-testid="claudex-web-runner-draining"
                >
                  {{ t('admin.claudexWeb.runners.statusDraining') }}
                </span>
              </td>
              <td class="whitespace-nowrap font-mono text-xs">{{ runner.version || '—' }}</td>
              <td class="whitespace-nowrap tabular-nums" data-testid="claudex-web-runner-capacity">
                {{ capacityText(runner) }}
              </td>
              <td class="whitespace-nowrap tabular-nums">{{ runner.assigned_users }}</td>
              <td class="whitespace-nowrap">
                <span v-if="runner.connected">{{ t('admin.claudexWeb.runners.now') }}</span>
                <span v-else-if="runner.last_seen_at" :title="formatDateTime(runner.last_seen_at)">
                  {{ formatRelativeTime(runner.last_seen_at) }}
                </span>
                <span v-else class="text-gray-400">{{ t('admin.claudexWeb.runners.neverSeen') }}</span>
              </td>
              <td class="whitespace-nowrap text-right">
                <div class="inline-flex items-center gap-1">
                  <button
                    v-if="canRename(runner)"
                    type="button"
                    class="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-dark-600 dark:hover:text-gray-300"
                    :title="t('admin.claudexWeb.runners.rename.action')"
                    :aria-label="t('admin.claudexWeb.runners.rename.action')"
                    :disabled="busy"
                    data-testid="claudex-web-runner-rename"
                    @click="openRename(runner)"
                  >
                    <Icon name="edit" size="sm" />
                  </button>
                  <button
                    v-if="canDisable(runner)"
                    type="button"
                    class="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-dark-600 dark:hover:text-gray-300"
                    :title="runner.disabled ? t('admin.claudexWeb.runners.enable') : t('admin.claudexWeb.runners.disable')"
                    :aria-label="runner.disabled ? t('admin.claudexWeb.runners.enable') : t('admin.claudexWeb.runners.disable')"
                    :disabled="busy"
                    data-testid="claudex-web-runner-toggle"
                    @click="toggleDisabled(runner)"
                  >
                    <Icon :name="runner.disabled ? 'play' : 'ban'" size="sm" />
                  </button>
                  <button
                    v-if="canDrain(runner)"
                    type="button"
                    class="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-dark-600 dark:hover:text-gray-300"
                    :title="t('admin.claudexWeb.runners.drain.action')"
                    :aria-label="t('admin.claudexWeb.runners.drain.action')"
                    :disabled="busy"
                    data-testid="claudex-web-runner-drain"
                    @click="drain(runner)"
                  >
                    <Icon name="arrowsUpDown" size="sm" />
                  </button>
                  <button
                    v-if="canRevoke(runner)"
                    type="button"
                    class="rounded-lg p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                    :title="t('admin.claudexWeb.runners.revoke.action')"
                    :aria-label="t('admin.claudexWeb.runners.revoke.action')"
                    :disabled="busy"
                    data-testid="claudex-web-runner-revoke"
                    @click="revoke(runner)"
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="view && !view.local_token_configured" class="input-hint" data-testid="claudex-web-runners-no-local">
        {{ t('admin.claudexWeb.runners.noLocal') }}
      </p>
    </div>
  </section>

  <RunnerNameDialog
    :show="dialog.open"
    :mode="dialog.mode"
    :runner="dialog.runner"
    :step-up="stepUp"
    @close="dialog.open = false"
    @created="onCreated"
    @renamed="onRenamed"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import type { ConfirmController } from '@/components/admin/claudex/devices/useConfirm'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import {
  drainRunner,
  listRunners,
  revokeRunner,
  updateRunner,
  type CreatedRunner,
  type WebRunner,
  type WebRunnersView
} from '@/api/admin/claudex/web'
import type { StepUpController } from '@/composables/useStepUp'
import { useAppStore } from '@/stores'
import { formatDateTime, formatRelativeTime } from '@/utils/format'
import RunnerNameDialog from './RunnerNameDialog.vue'

const props = defineProps<{ stepUp: StepUpController; confirm: ConfirmController }>()

const { t, te } = useI18n()
const appStore = useAppStore()
const action = useClaudexSave('claudexWeb')

/** How often the list refreshes itself (online state and last seen change). */
const REFRESH_MS = 30_000

const view = ref<WebRunnersView | null>(null)
const loading = ref(false)
const loadError = ref('')
const actionError = ref('')
const dialog = reactive<{ open: boolean; mode: 'create' | 'rename'; runner: { recordId: number; name: string } | null }>({
  open: false,
  mode: 'create',
  runner: null
})
let timer: ReturnType<typeof setInterval> | undefined
let seq = 0

const runners = computed(() => view.value?.items ?? [])
const busy = computed(() => action.saving.value)

async function load(silent = false) {
  const mine = ++seq
  if (!silent) loading.value = true
  try {
    const next = await listRunners()
    if (mine !== seq) return
    view.value = next
    loadError.value = ''
  } catch (err) {
    if (mine !== seq) return
    if (!silent) loadError.value = claudexErrorMessage(err, t, te, 'claudexWeb', t('admin.claudex.common.loadFailed'))
  } finally {
    if (mine === seq) loading.value = false
  }
}

function isStored(runner: WebRunner): boolean {
  return !runner.local && typeof runner.record_id === 'number' && runner.record_id > 0
}
const canRename = (r: WebRunner) => isStored(r) && !r.revoked_at
const canDisable = (r: WebRunner) => isStored(r) && !r.revoked_at
const canRevoke = (r: WebRunner) => isStored(r) && !r.revoked_at
const canDrain = (r: WebRunner) => r.connected && !r.draining && !r.revoked_at

function statusKey(r: WebRunner): 'revoked' | 'disabled' | 'online' | 'offline' {
  if (r.revoked_at) return 'revoked'
  if (r.disabled) return 'disabled'
  return r.connected ? 'online' : 'offline'
}

function statusLabel(r: WebRunner): string {
  return t(`admin.claudexWeb.runners.status_${statusKey(r)}`)
}

function statusBadge(r: WebRunner): string {
  switch (statusKey(r)) {
    case 'online':
      return 'badge-success'
    case 'revoked':
      return 'badge-danger'
    default:
      return 'badge-gray'
  }
}

/** Capacity as the runner reported it, with the load it last sent while connected. */
function capacityText(r: WebRunner): string {
  const cap = r.capacity
  if (!cap || (!cap.engines && !cap.users)) return '—'
  const base = t('admin.claudexWeb.runners.capacityValue', { engines: cap.engines, users: cap.users })
  if (!r.connected || !r.load) return base
  return `${t('admin.claudexWeb.runners.loadValue', { engines: r.load.engines, users: r.load.users })} / ${base}`
}

function openCreate() {
  dialog.mode = 'create'
  dialog.runner = null
  dialog.open = true
}

function openRename(r: WebRunner) {
  if (!r.record_id) return
  dialog.mode = 'rename'
  dialog.runner = { recordId: r.record_id, name: r.name }
  dialog.open = true
}

function onCreated(_runner: CreatedRunner['runner']) {
  void load(true)
}

function onRenamed() {
  appStore.showSuccess(t('admin.claudexWeb.runners.rename.done'))
  void load(true)
}

/** Runs one write; a runner that is already gone counts as done. */
async function write(run: () => Promise<unknown>, success: string) {
  actionError.value = ''
  const result = await action.run(() => runWithStepUp(props.stepUp, run, t))
  if (result.ok) {
    appStore.showSuccess(success)
  } else if (!result.cancelled && action.error.value) {
    actionError.value = action.error.value
  }
  await load(true)
}

async function toggleDisabled(r: WebRunner) {
  const recordId = r.record_id
  if (!recordId) return
  const off = !r.disabled
  if (off) {
    const ok = await props.confirm.ask({
      title: t('admin.claudexWeb.runners.disableTitle'),
      message: t('admin.claudexWeb.runners.disableMessage', { name: r.name }),
      confirmText: t('admin.claudexWeb.runners.disable'),
      danger: true
    })
    if (!ok) return
  }
  await write(
    () => updateRunner(recordId, { disabled: off }),
    t(off ? 'admin.claudexWeb.runners.disabledDone' : 'admin.claudexWeb.runners.enabledDone', { name: r.name })
  )
}

async function drain(r: WebRunner) {
  const ok = await props.confirm.ask({
    title: t('admin.claudexWeb.runners.drain.title'),
    message: t('admin.claudexWeb.runners.drain.message', { name: r.name }),
    confirmText: t('admin.claudexWeb.runners.drain.action')
  })
  if (!ok) return
  await write(() => drainRunner(r.local ? 'local' : (r.record_id ?? 0)), t('admin.claudexWeb.runners.drain.done', { name: r.name }))
}

async function revoke(r: WebRunner) {
  const recordId = r.record_id
  if (!recordId) return
  const ok = await props.confirm.ask({
    title: t('admin.claudexWeb.runners.revoke.title'),
    message: t('admin.claudexWeb.runners.revoke.message', { name: r.name }),
    confirmText: t('admin.claudexWeb.runners.revoke.action'),
    danger: true
  })
  if (!ok) return
  await write(() => revokeRunner(recordId), t('admin.claudexWeb.runners.revoke.done', { name: r.name }))
}

onMounted(() => {
  void load()
  timer = setInterval(() => void load(true), REFRESH_MS)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

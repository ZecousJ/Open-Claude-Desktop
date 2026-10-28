<!--
  CLAUDEX: /admin/claudex/status. What the apps' Service status page shows:
  each provider's channels (the channel monitors) with a bar a day, and the
  incidents. An incident is detected when a channel keeps failing and waits
  here as a draft: people see it only once it is approved. Here an
  administrator approves or opens one, posts updates as it is handled
  (investigating → identified → monitoring → resolved), takes it offline,
  edits or deletes it.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexStatus.title')"
    :description="t('admin.claudexStatus.description')"
    :loading="loading && !loaded"
    :load-error="loadError"
    test-id="claudex-status-page"
    @retry="load"
  >
    <ClaudexUnavailable v-if="unavailable" />

    <div v-else-if="loaded && overview" class="space-y-6">
      <!-- Channels -->
      <div class="card" data-testid="claudex-status-channels">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h2 class="font-medium text-gray-900 dark:text-white">{{ t('admin.claudexStatus.channels.title') }}</h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexStatus.channels.hint') }}</p>
        </div>
        <p v-if="!overview.platforms.length" class="px-6 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
          {{ t('admin.claudexStatus.channels.none') }}
        </p>
        <div
          v-for="platform in overview.platforms"
          :key="platform.platform"
          class="border-b border-gray-100 px-6 py-4 last:border-b-0 dark:border-dark-700"
          data-testid="claudex-status-platform"
        >
          <div class="flex flex-wrap items-center gap-3">
            <span class="font-medium text-gray-900 dark:text-white">{{ platform.name }}</span>
            <span class="rounded px-1.5 py-0.5 text-xs" :class="levelClass(platform.level)">
              {{ t(`admin.claudexStatus.level.${platform.level}`) }}
            </span>
            <span class="text-sm text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexStatus.channels.components', { n: platform.components.length }) }}
            </span>
            <span v-if="platform.uptime !== null" class="ml-auto text-sm text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexStatus.channels.uptime', { x: percent(platform.uptime) }) }}
            </span>
          </div>
          <div class="mt-3 flex h-4 gap-0.5">
            <span
              v-for="day in platform.days"
              :key="day.date"
              class="min-w-px flex-1 rounded-sm"
              :class="barClass(day.level)"
              :title="`${day.date} · ${t(`admin.claudexStatus.level.${day.level}`)}${day.uptime !== null ? ` · ${percent(day.uptime)}` : ''}`"
            />
          </div>
          <ul class="mt-3 space-y-1 text-sm text-gray-600 dark:text-gray-300">
            <li v-for="c in platform.components" :key="`${c.monitor_id}:${c.name}`" class="flex items-center gap-2">
              <span class="h-2 w-2 flex-shrink-0 rounded-full" :class="barClass(c.level)" />
              <span>{{ c.name }}</span>
              <span class="text-gray-400">{{ c.channel }}</span>
              <span v-if="c.uptime !== null" class="ml-auto text-gray-500 dark:text-gray-400">
                {{ t('admin.claudexStatus.channels.uptime', { x: percent(c.uptime) }) }}
              </span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Incidents -->
      <div class="card" data-testid="claudex-status-incidents">
        <div class="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <div>
            <h2 class="font-medium text-gray-900 dark:text-white">{{ t('admin.claudexStatus.incidents.title') }}</h2>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexStatus.incidents.hint') }}</p>
          </div>
          <button
            v-if="!creating"
            type="button"
            class="btn btn-primary flex-shrink-0"
            data-testid="claudex-status-new"
            @click="startNew"
          >
            {{ t('admin.claudexStatus.incidents.new') }}
          </button>
        </div>

        <form
          v-if="creating"
          class="space-y-4 border-b border-gray-100 px-6 py-5 dark:border-dark-700"
          data-testid="claudex-status-form"
          @submit.prevent="create"
        >
          <div>
            <label class="input-label" for="st-title">{{ t('admin.claudexStatus.fields.title') }}</label>
            <input id="st-title" v-model="draft.title" class="input" :maxlength="INCIDENT_LIMITS.title" required />
          </div>
          <div class="grid gap-4 sm:grid-cols-3">
            <div>
              <label class="input-label" for="st-platform">{{ t('admin.claudexStatus.fields.platform') }}</label>
              <select id="st-platform" v-model="draft.platform" class="input">
                <option value="">{{ t('admin.claudexStatus.fields.allServices') }}</option>
                <option v-for="p in overview.platforms" :key="p.platform" :value="p.platform">{{ p.name }}</option>
              </select>
            </div>
            <div>
              <label class="input-label" for="st-impact">{{ t('admin.claudexStatus.fields.impact') }}</label>
              <select id="st-impact" v-model="draft.impact" class="input">
                <option value="degraded">{{ t('admin.claudexStatus.impact.degraded') }}</option>
                <option value="outage">{{ t('admin.claudexStatus.impact.outage') }}</option>
              </select>
            </div>
            <div>
              <label class="input-label" for="st-status">{{ t('admin.claudexStatus.fields.status') }}</label>
              <select id="st-status" v-model="draft.status" class="input">
                <option v-for="s in INCIDENT_STATUSES" :key="s" :value="s">{{ t(`admin.claudexStatus.status.${s}`) }}</option>
              </select>
            </div>
          </div>
          <div>
            <label class="input-label" for="st-message">{{ t('admin.claudexStatus.fields.message') }}</label>
            <textarea id="st-message" v-model="draft.message" class="input" rows="3" :maxlength="INCIDENT_LIMITS.message" />
            <p class="input-hint">{{ t('admin.claudexStatus.fields.messageHint') }}</p>
          </div>
          <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input v-model="draft.published" type="checkbox" class="rounded" />
            {{ t('admin.claudexStatus.fields.publishNow') }}
          </label>
          <p v-if="formError" class="input-error-text" role="alert">{{ formError }}</p>
          <div class="flex gap-2">
            <button type="submit" class="btn btn-primary" :disabled="busy || !draft.title.trim()">
              {{ t('admin.claudexStatus.actions.create') }}
            </button>
            <button type="button" class="btn btn-secondary" @click="creating = false">
              {{ t('admin.claudexStatus.actions.cancel') }}
            </button>
          </div>
        </form>

        <p v-if="!overview.incidents.length" class="px-6 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
          {{ t('admin.claudexStatus.incidents.none') }}
        </p>
        <ul v-else class="divide-y divide-gray-100 dark:divide-dark-700">
          <li
            v-for="incident in overview.incidents"
            :key="incident.id"
            class="px-6 py-4"
            data-testid="claudex-status-incident"
          >
            <div class="flex flex-wrap items-start gap-x-6 gap-y-2">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-medium text-gray-900 dark:text-white">{{ incident.title }}</span>
                  <span class="rounded px-1.5 py-0.5 text-xs" :class="statusClass(incident.status)">
                    {{ t(`admin.claudexStatus.status.${incident.status}`) }}
                  </span>
                  <span class="rounded px-1.5 py-0.5 text-xs" :class="levelClass(incident.impact)">
                    {{ t(`admin.claudexStatus.impact.${incident.impact}`) }}
                  </span>
                  <span
                    v-if="!incident.published"
                    class="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                    data-testid="claudex-status-draft"
                  >
                    {{ t('admin.claudexStatus.incidents.draft') }}
                  </span>
                  <span
                    v-if="incident.auto"
                    class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-dark-700 dark:text-gray-300"
                  >
                    {{ t('admin.claudexStatus.incidents.auto') }}
                  </span>
                </div>
                <p v-if="incident.message" class="mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
                  {{ incident.message }}
                </p>
                <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {{ platformName(incident.platform) }} ·
                  {{ t('admin.claudexStatus.incidents.started', { date: formatDate(incident.started_at) }) }}
                  <template v-if="incident.resolved_at">
                    · {{ t('admin.claudexStatus.incidents.resolved', { date: formatDate(incident.resolved_at) }) }}
                  </template>
                </p>
              </div>
              <div class="flex flex-shrink-0 items-center gap-2">
                <button
                  v-if="!incident.published"
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="busy"
                  data-testid="claudex-status-approve"
                  @click="setPublished(incident, true)"
                >
                  {{ t('admin.claudexStatus.incidents.approve') }}
                </button>
                <button
                  v-else-if="!incident.resolved_at"
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :disabled="busy"
                  @click="setPublished(incident, false)"
                >
                  {{ t('admin.claudexStatus.incidents.unpublish') }}
                </button>
                <button type="button" class="btn btn-primary btn-sm" @click="openUpdate(incident, 'post')">
                  {{ t('admin.claudexStatus.incidents.post') }}
                </button>
                <button type="button" class="btn btn-secondary btn-sm" @click="openUpdate(incident, 'edit')">
                  {{ t('admin.claudexStatus.incidents.edit') }}
                </button>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :aria-label="t('common.delete')"
                  @click="removing = incident"
                >
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </div>

            <!-- Post an update / edit -->
            <form
              v-if="updating?.id === incident.id"
              class="mt-4 space-y-3 rounded-lg border border-gray-200 p-4 dark:border-dark-600"
              data-testid="claudex-status-update-form"
              @submit.prevent="submitUpdate"
            >
              <template v-if="mode === 'post'">
                <div class="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label class="input-label">{{ t('admin.claudexStatus.fields.status') }}</label>
                    <select v-model="update.status" class="input">
                      <option v-for="s in INCIDENT_STATUSES" :key="s" :value="s">
                        {{ t(`admin.claudexStatus.status.${s}`) }}
                      </option>
                    </select>
                  </div>
                  <div>
                    <label class="input-label">{{ t('admin.claudexStatus.fields.impact') }}</label>
                    <select v-model="update.impact" class="input">
                      <option value="degraded">{{ t('admin.claudexStatus.impact.degraded') }}</option>
                      <option value="outage">{{ t('admin.claudexStatus.impact.outage') }}</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label class="input-label">{{ t('admin.claudexStatus.fields.updateMessage') }}</label>
                  <textarea v-model="update.message" class="input" rows="3" :maxlength="INCIDENT_LIMITS.message" />
                </div>
              </template>
              <template v-else>
                <div>
                  <label class="input-label">{{ t('admin.claudexStatus.fields.title') }}</label>
                  <input v-model="update.title" class="input" :maxlength="INCIDENT_LIMITS.title" />
                </div>
                <div class="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label class="input-label">{{ t('admin.claudexStatus.fields.platform') }}</label>
                    <select v-model="update.platform" class="input">
                      <option value="">{{ t('admin.claudexStatus.fields.allServices') }}</option>
                      <option v-for="p in overview.platforms" :key="p.platform" :value="p.platform">{{ p.name }}</option>
                    </select>
                  </div>
                  <div>
                    <label class="input-label">{{ t('admin.claudexStatus.fields.impact') }}</label>
                    <select v-model="update.impact" class="input">
                      <option value="degraded">{{ t('admin.claudexStatus.impact.degraded') }}</option>
                      <option value="outage">{{ t('admin.claudexStatus.impact.outage') }}</option>
                    </select>
                  </div>
                </div>
              </template>
              <p v-if="formError" class="input-error-text" role="alert">{{ formError }}</p>
              <div class="flex gap-2">
                <button type="submit" class="btn btn-primary btn-sm" :disabled="busy">
                  {{ mode === 'post' ? t('admin.claudexStatus.actions.post') : t('admin.claudexStatus.actions.save') }}
                </button>
                <button type="button" class="btn btn-secondary btn-sm" @click="updating = null">
                  {{ t('admin.claudexStatus.actions.cancel') }}
                </button>
              </div>
            </form>

            <details v-if="incident.updates.length" class="mt-3 text-sm">
              <summary class="cursor-pointer text-gray-500 dark:text-gray-400">
                {{ t('admin.claudexStatus.incidents.history', { n: incident.updates.length }) }}
              </summary>
              <ol class="mt-2 space-y-2 border-l border-gray-200 pl-4 dark:border-dark-600">
                <li v-for="(u, i) in incident.updates" :key="i">
                  <span class="font-medium text-gray-800 dark:text-gray-200">
                    {{ t(`admin.claudexStatus.status.${u.status}`) }}
                  </span>
                  <span class="text-xs text-gray-500 dark:text-gray-400"> · {{ formatDate(u.created_at) }}</span>
                  <p v-if="u.message" class="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{{ u.message }}</p>
                </li>
              </ol>
            </details>
          </li>
        </ul>
      </div>
    </div>

    <ConfirmDialog
      :show="!!removing"
      :title="t('admin.claudexStatus.incidents.deleteTitle')"
      :message="t('admin.claudexStatus.incidents.deleteMessage')"
      :confirm-text="t('common.delete')"
      danger
      @confirm="remove"
      @cancel="removing = null"
    />
  </ClaudexPageShell>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import ClaudexUnavailable from '@/components/admin/claudex/common/ClaudexUnavailable.vue'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { isMissingEndpoint } from '@/components/admin/claudex/general/pageSupport'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import Icon from '@/components/icons/Icon.vue'
import {
  INCIDENT_LIMITS,
  INCIDENT_STATUSES,
  createIncident,
  deleteIncident,
  getStatus,
  updateIncident,
  type Incident,
  type IncidentImpact,
  type IncidentStatus,
  type StatusOverview
} from '@/api/admin/claudex/status'
import { useAppStore } from '@/stores/app'

const PAGE = 'claudexStatus'
const { t, te } = useI18n()
const appStore = useAppStore()

const loading = ref(false)
const loaded = ref(false)
const loadError = ref<string | null>(null)
const unavailable = ref(false)
const busy = ref(false)
const overview = ref<StatusOverview | null>(null)

const creating = ref(false)
const draft = ref({
  title: '',
  platform: '',
  impact: 'degraded' as IncidentImpact,
  status: 'investigating' as IncidentStatus,
  message: '',
  published: true
})
const updating = ref<Incident | null>(null)
const mode = ref<'post' | 'edit'>('post')
const update = ref({ title: '', platform: '', impact: 'degraded' as IncidentImpact, status: 'investigating' as IncidentStatus, message: '' })
const formError = ref('')
const removing = ref<Incident | null>(null)

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const percent = (value: number) => `${(Math.floor(value * 100) / 100).toFixed(2)}%`

function platformName(platform: string) {
  if (!platform) return t('admin.claudexStatus.fields.allServices')
  return overview.value?.platforms.find((p) => p.platform === platform)?.name ?? platform
}

const levelClass = (level: string) =>
  ({
    operational: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    degraded: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    outage: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    none: 'bg-gray-100 text-gray-500 dark:bg-dark-700 dark:text-gray-400'
  })[level] ?? ''

const statusClass = (status: string) =>
  status === 'resolved'
    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'

// The apps' bar colours (#23c19a, #fbbf23, #f5785c).
const barClass = (level: string) =>
  ({
    operational: 'bg-[#23c19a]',
    degraded: 'bg-[#fbbf23]',
    outage: 'bg-[#f5785c]',
    none: 'bg-gray-200 dark:bg-dark-600'
  })[level] ?? ''

function problem(err: unknown, fallback: string): string {
  return claudexErrorMessage(err, t, te, PAGE, fallback)
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    overview.value = await getStatus(90)
    unavailable.value = false
    loaded.value = true
  } catch (err) {
    if (isMissingEndpoint(err)) {
      unavailable.value = true
      loaded.value = true
    } else {
      loadError.value = problem(err, t('admin.claudex.common.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

function startNew() {
  draft.value = { title: '', platform: '', impact: 'degraded', status: 'investigating', message: '', published: true }
  formError.value = ''
  creating.value = true
}

async function create() {
  busy.value = true
  formError.value = ''
  try {
    await createIncident({ ...draft.value, title: draft.value.title.trim() })
    creating.value = false
    appStore.showSuccess(t('admin.claudexStatus.saved'))
    await load()
  } catch (err) {
    formError.value = problem(err, t('admin.claudex.common.saveFailed'))
  } finally {
    busy.value = false
  }
}

function openUpdate(incident: Incident, next: 'post' | 'edit') {
  updating.value = incident
  mode.value = next
  formError.value = ''
  update.value = {
    title: incident.title,
    platform: incident.platform,
    impact: incident.impact,
    status: incident.status,
    message: ''
  }
}

async function submitUpdate() {
  const incident = updating.value
  if (!incident) return
  busy.value = true
  formError.value = ''
  try {
    const body =
      mode.value === 'post'
        ? { status: update.value.status, impact: update.value.impact, message: update.value.message.trim() }
        : { title: update.value.title.trim(), platform: update.value.platform, impact: update.value.impact }
    await updateIncident(incident.id, body)
    updating.value = null
    appStore.showSuccess(t('admin.claudexStatus.saved'))
    await load()
  } catch (err) {
    formError.value = problem(err, t('admin.claudex.common.saveFailed'))
  } finally {
    busy.value = false
  }
}

/** Approves a detected incident (people see it from now on), or takes one offline. */
async function setPublished(incident: Incident, published: boolean) {
  busy.value = true
  try {
    await updateIncident(incident.id, { published })
    appStore.showSuccess(t('admin.claudexStatus.saved'))
    await load()
  } catch (err) {
    appStore.showError(problem(err, t('admin.claudex.common.saveFailed')))
  } finally {
    busy.value = false
  }
}

async function remove() {
  const incident = removing.value
  removing.value = null
  if (!incident) return
  try {
    await deleteIncident(incident.id)
    await load()
  } catch (err) {
    appStore.showError(problem(err, t('admin.claudex.common.saveFailed')))
  }
}

// The channels move every few minutes: the page follows while it is open.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void load()
  timer = setInterval(() => {
    if (!creating.value && !updating.value) void load()
  }, 60_000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

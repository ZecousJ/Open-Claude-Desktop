<!-- CLAUDEX: /admin/claudex/overview, status of the Claudex server build. -->
<template>
  <AppLayout>
    <div class="space-y-6">
      <section
        class="flex flex-col gap-4 border-b border-gray-200 pb-5 dark:border-dark-700 sm:flex-row sm:items-end sm:justify-between"
      >
        <div class="min-w-0">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudex.overview.title') }}
          </h2>
          <p class="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudex.overview.description') }}
          </p>
        </div>
        <button
          type="button"
          class="btn btn-secondary flex-shrink-0"
          :disabled="loading"
          :title="t('admin.claudex.overview.refresh')"
          data-testid="claudex-overview-refresh"
          @click="load"
        >
          <Icon name="refresh" size="sm" :class="{ 'animate-spin': loading }" />
          <span class="sr-only">{{ t('admin.claudex.overview.refresh') }}</span>
        </button>
      </section>

      <p
        v-if="error"
        class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
        data-testid="claudex-overview-error"
      >
        {{ t('admin.claudex.overview.loadFailed') }}: {{ error }}
      </p>

      <div v-if="loading && !overview" class="flex justify-center py-12">
        <Icon name="refresh" size="lg" class="animate-spin text-gray-400" />
      </div>

      <template v-if="overview">
        <div
          v-if="memoryKeyMissing"
          role="alert"
          class="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-800/50 dark:bg-amber-900/20 sm:flex-row sm:items-center sm:justify-between"
          data-testid="claudex-overview-memory-key"
        >
          <div class="flex items-start gap-3">
            <Icon name="exclamationTriangle" size="md" class="mt-0.5 flex-shrink-0 text-amber-500" />
            <div class="text-amber-800 dark:text-amber-200">
              <p class="font-medium">{{ t('admin.claudexMemory.overviewWarning.title') }}</p>
              <p class="mt-1 text-amber-700 dark:text-amber-300">
                {{ t('admin.claudexMemory.overviewWarning.body') }}
              </p>
            </div>
          </div>
          <RouterLink
            to="/admin/claudex/memory"
            class="flex-shrink-0 font-medium text-primary-600 hover:underline dark:text-primary-400"
          >
            {{ t('admin.claudexMemory.overviewWarning.link') }}
          </RouterLink>
        </div>

        <div class="grid gap-6 lg:grid-cols-2">
          <div class="card p-6" data-testid="claudex-overview-server">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
              {{ t('admin.claudex.overview.server') }}
            </h3>
            <dl class="mt-4 space-y-3 text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-gray-500 dark:text-gray-400">
                  {{ t('admin.claudex.overview.serverVersion') }}
                </dt>
                <dd class="font-mono text-gray-900 dark:text-gray-100">
                  {{ overview.server.version || '--' }}
                </dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-gray-500 dark:text-gray-400">
                  {{ t('admin.claudex.overview.buildType') }}
                </dt>
                <dd class="font-mono text-gray-900 dark:text-gray-100">
                  {{ overview.server.build_type || '--' }}
                </dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-gray-500 dark:text-gray-400">
                  {{ t('admin.claudex.overview.apiVersion') }}
                </dt>
                <dd class="font-mono text-gray-900 dark:text-gray-100">
                  {{ overview.api_version }}
                </dd>
              </div>
            </dl>
            <div
              v-if="overview.self_update_disabled"
              class="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800/50 dark:bg-blue-900/20"
              data-testid="claudex-overview-self-update"
            >
              <p class="text-sm font-medium text-blue-700 dark:text-blue-300">
                {{ t('admin.claudex.selfUpdate.disabled') }}
              </p>
              <p class="mt-1 text-xs text-blue-600 dark:text-blue-400">
                {{ t('admin.claudex.selfUpdate.disabledHint') }}
              </p>
            </div>
          </div>

          <div class="card p-6" data-testid="claudex-overview-upstream">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
              {{ t('admin.claudex.overview.upstream') }}
            </h3>
            <dl class="mt-4 space-y-3 text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-gray-500 dark:text-gray-400">
                  {{ t('admin.claudex.overview.upstreamCommit') }}
                </dt>
                <dd class="min-w-0">
                  <a
                    :href="upstreamCommitUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="font-mono text-primary-600 hover:underline dark:text-primary-400"
                    :title="overview.upstream.commit"
                    >{{ overview.upstream.commit.slice(0, 7) }}</a
                  >
                </dd>
              </div>
            </dl>
            <p class="mt-4 text-xs text-gray-500 dark:text-gray-400">
              {{ t('admin.claudex.overview.license') }}
            </p>
          </div>
        </div>

        <div class="card p-6" data-testid="claudex-overview-features">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">
            {{ t('admin.claudex.overview.features') }}
          </h3>
          <p
            v-if="overview.features.length === 0"
            class="mt-3 text-sm text-gray-500 dark:text-gray-400"
          >
            {{ t('admin.claudex.overview.featuresEmpty') }}
          </p>
          <ul v-else class="mt-3 divide-y divide-gray-100 dark:divide-dark-700">
            <li
              v-for="feature in overview.features"
              :key="feature.name"
              class="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <span class="font-mono text-sm text-gray-900 dark:text-gray-100">{{
                feature.name
              }}</span>
              <span class="text-xs text-gray-500 dark:text-gray-400">
                {{ t('admin.claudex.overview.settingKeys') }}:
                {{
                  feature.setting_keys.length
                    ? feature.setting_keys.join(', ')
                    : t('admin.claudex.overview.noSettings')
                }}
              </span>
            </li>
          </ul>
        </div>
      </template>
    </div>
  </AppLayout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import Icon from '@/components/icons/Icon.vue'
import { getOverview, type ClaudexOverview } from '@/api/admin/claudex/overview'
import { getStats as getMemoryStats } from '@/api/admin/claudex/memory'
import { extractApiErrorMessage } from '@/utils/apiError'

const { t } = useI18n()

const overview = ref<ClaudexOverview | null>(null)
const loading = ref(false)
const error = ref('')
// R3: memory can't be stored without a fixed encryption key; warn here too.
const memoryKeyMissing = ref(false)
let memorySeq = 0

const upstreamCommitUrl = computed(() => {
  if (!overview.value) return ''
  const { repository, commit } = overview.value.upstream
  return `${repository.replace(/\/+$/, '')}/commit/${commit}`
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    overview.value = await getOverview()
    void checkMemoryKey(overview.value)
  } catch (err: unknown) {
    error.value = extractApiErrorMessage(err, t('admin.claudex.overview.loadFailed'))
  } finally {
    loading.value = false
  }
}

// Asked only when the server has the memory feature. A failure here never
// affects the overview; the Memory page shows its own errors.
async function checkMemoryKey(current: ClaudexOverview | null) {
  const mine = ++memorySeq
  if (!current?.features?.some((feature) => feature.name === 'memory')) {
    memoryKeyMissing.value = false
    return
  }
  try {
    const stats = await getMemoryStats()
    if (mine === memorySeq) memoryKeyMissing.value = stats?.encryption_key_ready === false
  } catch {
    if (mine === memorySeq) memoryKeyMissing.value = false
  }
}

onMounted(load)
</script>

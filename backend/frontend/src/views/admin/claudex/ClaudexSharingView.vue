<!--
  CLAUDEX: /admin/claudex/sharing (R1-K, design R1 2.4 and 3.4). Settings of
  the hosted shares (claudex_sharing: off by default, per-kind switches,
  public and content addresses, usage policy link, limits, expiry, report
  button) and the moderation lists: shared links (review the snapshot as plain
  text, open the public page, take down / restore / delete, block the
  author), visitor reports (dismiss or take down), the app's artifact reports
  (review the artifact copy as plain text, dismiss or mark resolved) and
  blocked users (unblock,
  take down all of a user's links). Every write is confirmed and goes through
  step-up; the server keeps all of this behind the admin compliance gate.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexSharing.title')"
    :description="t('admin.claudexSharing.description')"
    :loading="loading"
    :load-error="loadError"
    test-id="claudex-sharing-page"
    @retry="load"
  >
    <ClaudexUnavailable v-if="unavailable" />

    <template v-else-if="loaded">
      <div
        v-if="!effective.storage_available"
        role="alert"
        class="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-200"
        data-testid="claudex-sharing-storage-unavailable"
      >
        <Icon name="exclamationTriangle" size="md" class="mt-0.5 flex-shrink-0" />
        <span>{{ t('admin.claudexSharing.storageUnavailable') }}</span>
      </div>

      <div
        class="flex items-start gap-3 rounded-lg border p-4 text-sm"
        :class="
          savedEnabled
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-200'
            : 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800/50 dark:bg-blue-900/20 dark:text-blue-200'
        "
        data-testid="claudex-sharing-state-note"
      >
        <Icon name="infoCircle" size="md" class="mt-0.5 flex-shrink-0" />
        <span>{{ savedEnabled ? t('admin.claudexSharing.onNote') : t('admin.claudexSharing.offNote') }}</span>
      </div>

      <!-- Switches -->
      <div class="card" data-testid="claudex-sharing-switches">
        <div class="flex items-start justify-between gap-6 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <div class="min-w-0">
            <h3 id="claudex-sharing-enabled-title" class="text-base font-semibold text-gray-900 dark:text-white">
              {{ t('admin.claudexSharing.settings.enabled') }}
            </h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexSharing.settings.description') }}
            </p>
          </div>
          <Toggle
            v-model="form.enabled"
            aria-labelledby="claudex-sharing-enabled-title"
            data-testid="claudex-sharing-enabled"
          />
        </div>
        <div class="divide-y divide-gray-100 px-6 dark:divide-dark-700">
          <div v-for="item in switchRows" :key="item.key" class="flex items-start justify-between gap-6 py-4">
            <div class="min-w-0">
              <p :id="`claudex-sharing-${item.key}-label`" class="text-sm font-medium text-gray-900 dark:text-white">
                {{ item.label }}
              </p>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ item.hint }}</p>
            </div>
            <Toggle
              v-model="form[item.key]"
              :aria-labelledby="`claudex-sharing-${item.key}-label`"
              :data-testid="`claudex-sharing-${item.key}`"
            />
          </div>
        </div>
      </div>

      <!-- Links -->
      <div class="card" data-testid="claudex-sharing-links">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexSharing.links.title') }}</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexSharing.links.description') }}</p>
        </div>
        <div class="space-y-5 p-6">
          <div v-for="field in urlFields" :key="field.key">
            <label :for="`claudex-sharing-${field.key}`" class="input-label mb-1.5 block">{{ field.label }}</label>
            <input
              :id="`claudex-sharing-${field.key}`"
              v-model="form[field.model]"
              type="url"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              class="input w-full"
              :class="{ 'input-error': fieldProblem(field.key) }"
              :placeholder="field.placeholder"
              :aria-invalid="fieldProblem(field.key) ? 'true' : 'false'"
              :aria-describedby="`claudex-sharing-${field.key}-note`"
              :data-testid="`claudex-sharing-${field.key}`"
              @blur="touched[field.key] = true"
            />
            <p
              v-if="fieldProblem(field.key)"
              :id="`claudex-sharing-${field.key}-note`"
              class="input-error-text mt-1.5"
              :data-testid="`claudex-sharing-${field.key}-error`"
            >
              {{ fieldProblem(field.key) }}
            </p>
            <p v-else :id="`claudex-sharing-${field.key}-note`" class="input-hint mt-1.5">{{ field.hint }}</p>
            <p
              v-if="field.key === 'public_base_url'"
              class="mt-1.5 text-xs text-gray-500 dark:text-gray-400"
              data-testid="claudex-sharing-effective-base"
            >
              <template v-if="effective.public_base_url">
                {{ t('admin.claudexSharing.links.effective', { url: effective.public_base_url }) }}
              </template>
              {{ baseSourceText }}
            </p>
            <p
              v-if="field.key === 'usage_policy_url'"
              class="mt-1.5 text-xs text-gray-500 dark:text-gray-400"
              data-testid="claudex-sharing-effective-policy"
            >
              {{
                effectivePolicy
                  ? t('admin.claudexSharing.links.effectivePolicy', { url: effectivePolicy })
                  : t('admin.claudexSharing.links.noPolicy')
              }}
            </p>
          </div>
        </div>
      </div>

      <!-- Limits -->
      <div class="card" data-testid="claudex-sharing-limits">
        <div class="border-b border-gray-100 px-6 py-4 dark:border-dark-700">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexSharing.limits.title') }}</h3>
        </div>
        <div class="grid gap-5 p-6 sm:grid-cols-2">
          <div v-for="field in numberFields" :key="field.key">
            <label :for="`claudex-sharing-${field.key}`" class="input-label mb-1.5 block">{{ field.label }}</label>
            <input
              :id="`claudex-sharing-${field.key}`"
              v-model.number="form[field.model]"
              type="number"
              :min="field.min"
              :max="field.max"
              step="1"
              class="input w-full"
              :class="{ 'input-error': fieldProblem(field.key) }"
              :data-testid="`claudex-sharing-${field.key}`"
            />
            <p v-if="fieldProblem(field.key)" class="input-error-text mt-1.5" :data-testid="`claudex-sharing-${field.key}-error`">
              {{ fieldProblem(field.key) }}
            </p>
            <p v-else-if="field.hint" class="input-hint mt-1.5">{{ field.hint }}</p>
          </div>
        </div>
      </div>

      <SaveBar
        :saving="save.saving.value"
        :dirty="dirty"
        :saved="save.saved.value"
        :error="formError || save.error.value"
        :disabled="!dirty"
        @save="submit"
      />

      <!-- Moderation -->
      <div v-if="effective.storage_available" class="card" data-testid="claudex-sharing-moderation">
        <div class="border-b border-gray-100 px-6 dark:border-dark-700">
          <nav class="-mb-px flex gap-6" role="tablist">
            <button
              v-for="tab in tabs"
              :id="`claudex-sharing-tab-${tab}`"
              :key="tab"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab"
              :aria-controls="`claudex-sharing-panel-${tab}`"
              class="inline-flex items-center gap-2 border-b-2 py-3 text-sm font-medium"
              :class="
                activeTab === tab
                  ? 'border-primary-600 text-primary-600 dark:border-primary-400 dark:text-primary-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              "
              :data-testid="`claudex-sharing-tab-${tab}`"
              @click="selectTab(tab)"
            >
              {{ t(`admin.claudexSharing.tabs.${tab}`) }}
              <span
                v-if="tab === 'reports' && openReports > 0"
                class="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300"
                data-testid="claudex-sharing-open-reports"
              >
                {{ openReports }}
              </span>
              <span
                v-if="tab === 'artifactReports' && openArtifactReports > 0"
                class="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300"
                data-testid="claudex-sharing-open-artifact-reports"
              >
                {{ openArtifactReports }}
              </span>
            </button>
          </nav>
        </div>

        <div
          :id="`claudex-sharing-panel-${activeTab}`"
          role="tabpanel"
          :aria-labelledby="`claudex-sharing-tab-${activeTab}`"
          class="space-y-4 p-6"
        >
          <p
            v-if="listError"
            role="alert"
            class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300"
            data-testid="claudex-sharing-list-error"
          >
            {{ listError }}
          </p>

          <!-- Shared links -->
          <template v-if="activeTab === 'shares'">
            <form
              class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              data-testid="claudex-sharing-share-filters"
              @submit.prevent="applyShareFilters"
            >
              <div>
                <label for="claudex-share-status" class="input-label mb-1.5 block">{{ t('admin.claudexSharing.filters.status') }}</label>
                <select id="claudex-share-status" v-model="shareFilters.status" class="input w-full" data-testid="claudex-share-filter-status">
                  <option value="">{{ t('admin.claudexSharing.filters.liveStatuses') }}</option>
                  <option v-for="s in SHARE_STATUSES" :key="s" :value="s">{{ t(`admin.claudexSharing.statuses.${s}`) }}</option>
                </select>
              </div>
              <div>
                <label for="claudex-share-kind" class="input-label mb-1.5 block">{{ t('admin.claudexSharing.filters.kind') }}</label>
                <select id="claudex-share-kind" v-model="shareFilters.kind" class="input w-full" data-testid="claudex-share-filter-kind">
                  <option value="">{{ t('admin.claudexSharing.filters.anyKind') }}</option>
                  <option value="conversation">{{ t('admin.claudexSharing.kinds.conversation') }}</option>
                  <option value="artifact">{{ t('admin.claudexSharing.kinds.artifact') }}</option>
                </select>
              </div>
              <div>
                <label for="claudex-share-user" class="input-label mb-1.5 block">{{ t('admin.claudexSharing.filters.userId') }}</label>
                <input
                  id="claudex-share-user"
                  v-model="shareFilters.userId"
                  type="number"
                  min="1"
                  step="1"
                  inputmode="numeric"
                  class="input w-full"
                  :placeholder="t('admin.claudexSharing.filters.any')"
                  data-testid="claudex-share-filter-user"
                />
              </div>
              <div>
                <label for="claudex-share-q" class="input-label mb-1.5 block">{{ t('admin.claudexSharing.filters.search') }}</label>
                <input
                  id="claudex-share-q"
                  v-model="shareFilters.q"
                  type="search"
                  maxlength="200"
                  class="input w-full"
                  :placeholder="t('admin.claudexSharing.filters.searchPlaceholder')"
                  data-testid="claudex-share-filter-q"
                />
              </div>
              <div class="flex gap-2 sm:col-span-2 lg:col-span-4">
                <button type="submit" class="btn btn-secondary" :disabled="listLoading" data-testid="claudex-share-apply">
                  {{ t('admin.claudexSharing.filters.apply') }}
                </button>
                <button type="button" class="btn btn-ghost" :disabled="listLoading" @click="resetShareFilters">
                  {{ t('admin.claudexSharing.filters.reset') }}
                </button>
              </div>
            </form>

            <DataTable :columns="shareColumns" :data="shares" :loading="listLoading" row-key="id">
              <template #cell-title="{ row }">
                <div class="min-w-0 max-w-xs" :data-testid="`claudex-share-row-${row.id}`">
                  <p class="truncate text-sm font-medium text-gray-900 dark:text-white" :title="row.title">
                    {{ row.title || t('admin.claudexSharing.fields.untitled') }}
                  </p>
                  <p class="text-xs text-gray-500 dark:text-gray-400">{{ t(`admin.claudexSharing.kinds.${row.kind}`) }}</p>
                </div>
              </template>
              <template #cell-author="{ row }">
                <span class="text-sm">{{ userLabel(row.user_id, row.user_email) }}</span>
              </template>
              <template #cell-status="{ row }">
                <div class="space-y-1">
                  <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" :class="statusClass(shareState(row))">
                    {{ t(`admin.claudexSharing.statuses.${shareState(row)}`) }}
                  </span>
                  <p
                    v-if="row.status === 'disabled' && row.disabled_reason"
                    class="max-w-[12rem] truncate text-xs text-gray-500 dark:text-gray-400"
                    :title="row.disabled_reason"
                  >
                    {{ t('admin.claudexSharing.shares.takenDownReason', { reason: row.disabled_reason }) }}
                  </p>
                </div>
              </template>
              <template #cell-view_count="{ value }">
                <span class="text-sm tabular-nums">{{ value ?? 0 }}</span>
              </template>
              <template #cell-open_reports="{ value }">
                <span class="text-sm tabular-nums" :class="{ 'font-semibold text-red-600 dark:text-red-400': value > 0 }">
                  {{ value ?? 0 }}
                </span>
              </template>
              <template #cell-content_bytes="{ value }">
                <span class="whitespace-nowrap text-sm">{{ formatBytes(value || 0, 1) }}</span>
              </template>
              <template #cell-created_at="{ value }">
                <span class="whitespace-nowrap text-sm">{{ formatDateTime(value) }}</span>
              </template>
              <template #cell-expires_at="{ value }">
                <span class="whitespace-nowrap text-sm">{{ value ? formatDateTime(value) : t('admin.claudexSharing.fields.never') }}</span>
              </template>
              <template #cell-actions="{ row }">
                <div v-if="row.status !== 'revoked'" class="flex flex-wrap items-center gap-1">
                  <a
                    :href="linkOf(row.url, row.path)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="btn btn-ghost btn-sm"
                    :data-testid="`claudex-share-open-${row.id}`"
                  >
                    {{ t('admin.claudexSharing.actions.open') }}
                  </a>
                  <button type="button" class="btn btn-ghost btn-sm" :data-testid="`claudex-share-review-${row.id}`" @click="openContent(row.id)">
                    {{ t('admin.claudexSharing.actions.review') }}
                  </button>
                  <button
                    v-if="row.status === 'active'"
                    type="button"
                    class="btn btn-ghost btn-sm text-amber-700 dark:text-amber-400"
                    :data-testid="`claudex-share-takedown-${row.id}`"
                    @click="takeDown(row)"
                  >
                    {{ t('admin.claudexSharing.actions.takeDown') }}
                  </button>
                  <button
                    v-else
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :data-testid="`claudex-share-restore-${row.id}`"
                    @click="restore(row)"
                  >
                    {{ t('admin.claudexSharing.actions.restore') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm text-red-600 dark:text-red-400"
                    :data-testid="`claudex-share-delete-${row.id}`"
                    @click="remove(row)"
                  >
                    {{ t('admin.claudexSharing.actions.delete') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :data-testid="`claudex-share-block-${row.id}`"
                    @click="block(row.user_id, row.user_email)"
                  >
                    {{ t('admin.claudexSharing.actions.blockAuthor') }}
                  </button>
                </div>
                <span v-else class="text-sm text-gray-400">--</span>
              </template>
              <template #empty>
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-sharing-shares-empty">
                  {{ t('admin.claudexSharing.shares.empty') }}
                </p>
              </template>
            </DataTable>
          </template>

          <!-- Reports -->
          <template v-else-if="activeTab === 'reports'">
            <p
              v-if="!savedSettings?.allow_reports"
              class="text-sm text-gray-500 dark:text-gray-400"
              data-testid="claudex-sharing-reports-off"
            >
              {{ t('admin.claudexSharing.reports.reportsOff') }}
            </p>
            <div class="flex items-end gap-3">
              <div class="w-56">
                <label for="claudex-report-status" class="input-label mb-1.5 block">{{ t('admin.claudexSharing.filters.status') }}</label>
                <select
                  id="claudex-report-status"
                  v-model="reportStatus"
                  class="input w-full"
                  data-testid="claudex-report-filter-status"
                  @change="changeReportStatus"
                >
                  <option value="">{{ t('admin.claudexSharing.filters.anyStatus') }}</option>
                  <option v-for="s in REPORT_STATUSES" :key="s" :value="s">{{ t(`admin.claudexSharing.reports.statuses.${s}`) }}</option>
                </select>
              </div>
            </div>

            <DataTable :columns="reportColumns" :data="reports" :loading="listLoading" row-key="id">
              <template #cell-created_at="{ value }">
                <span class="whitespace-nowrap text-sm">{{ formatDateTime(value) }}</span>
              </template>
              <template #cell-share="{ row }">
                <div class="min-w-0 max-w-xs" :data-testid="`claudex-report-row-${row.id}`">
                  <a
                    v-if="row.share_status !== 'revoked' && (row.share_url || row.share_path)"
                    :href="linkOf(row.share_url, row.share_path)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="block truncate text-sm font-medium text-primary-600 hover:underline dark:text-primary-400"
                    :title="row.share_title"
                  >
                    {{ row.share_title || t('admin.claudexSharing.fields.untitled') }}
                  </a>
                  <p v-else class="truncate text-sm font-medium text-gray-900 dark:text-white">
                    {{ row.share_title || t('admin.claudexSharing.fields.untitled') }}
                  </p>
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    {{ t(`admin.claudexSharing.statuses.${row.share_status}`) }} · {{ userLabel(row.share_user_id, '') }}
                  </p>
                </div>
              </template>
              <template #cell-reason="{ row, value }">
                <span class="text-sm">{{ reasonLabel(value) }}</span>
                <p v-if="row.category" class="text-xs text-gray-500 dark:text-gray-400" :data-testid="`claudex-report-category-${row.id}`">
                  {{ categoryLabel(row.category) }}
                </p>
              </template>
              <template #cell-detail="{ row, value }">
                <span class="block max-w-xs whitespace-pre-wrap break-words text-sm" :class="{ 'text-gray-400': !value }">
                  {{ value || t('admin.claudexSharing.reports.noDetail') }}
                </span>
                <p
                  v-if="reporterLabel(row)"
                  class="mt-1 max-w-xs break-words text-xs text-gray-500 dark:text-gray-400"
                  :data-testid="`claudex-report-reporter-${row.id}`"
                >
                  {{ t('admin.claudexSharing.reports.reporter', { who: reporterLabel(row) }) }}
                </p>
                <span
                  v-if="row.opt_out_of_training"
                  class="mt-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                  :title="t('admin.claudexSharing.reports.optedOutHint')"
                  :data-testid="`claudex-report-opt-out-${row.id}`"
                >
                  {{ t('admin.claudexSharing.reports.optedOut') }}
                </span>
              </template>
              <template #cell-status="{ value }">
                <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" :class="reportStatusClass(value)">
                  {{ t(`admin.claudexSharing.reports.statuses.${value}`) }}
                </span>
              </template>
              <template #cell-actions="{ row }">
                <div class="flex flex-wrap items-center gap-1">
                  <button
                    v-if="row.share_status !== 'revoked'"
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :data-testid="`claudex-report-review-${row.id}`"
                    @click="openContent(row.share_id)"
                  >
                    {{ t('admin.claudexSharing.actions.review') }}
                  </button>
                  <template v-if="row.status === 'open'">
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      :data-testid="`claudex-report-dismiss-${row.id}`"
                      @click="dismissReport(row)"
                    >
                      {{ t('admin.claudexSharing.actions.dismiss') }}
                    </button>
                    <button
                      v-if="row.share_status === 'active'"
                      type="button"
                      class="btn btn-ghost btn-sm text-amber-700 dark:text-amber-400"
                      :data-testid="`claudex-report-takedown-${row.id}`"
                      @click="takeDownReported(row)"
                    >
                      {{ t('admin.claudexSharing.actions.takeDown') }}
                    </button>
                  </template>
                </div>
              </template>
              <template #empty>
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-sharing-reports-empty">
                  {{ t('admin.claudexSharing.reports.empty') }}
                </p>
              </template>
            </DataTable>
          </template>

          <!-- Artifact reports (the app's Report artifact) -->
          <template v-else-if="activeTab === 'artifactReports'">
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexSharing.artifactReports.description') }}</p>
            <p
              v-if="!savedSettings?.allow_reports"
              class="text-sm text-gray-500 dark:text-gray-400"
              data-testid="claudex-sharing-artifact-reports-off"
            >
              {{ t('admin.claudexSharing.artifactReports.reportsOff') }}
            </p>
            <div class="flex items-end gap-3">
              <div class="w-56">
                <label for="claudex-artifact-report-status" class="input-label mb-1.5 block">{{
                  t('admin.claudexSharing.filters.status')
                }}</label>
                <select
                  id="claudex-artifact-report-status"
                  v-model="artifactReportStatus"
                  class="input w-full"
                  data-testid="claudex-artifact-report-filter-status"
                  @change="changeReportStatus"
                >
                  <option value="">{{ t('admin.claudexSharing.filters.anyStatus') }}</option>
                  <option v-for="s in REPORT_STATUSES" :key="s" :value="s">
                    {{ t(`admin.claudexSharing.artifactReports.statuses.${s}`) }}
                  </option>
                </select>
              </div>
            </div>

            <DataTable :columns="artifactReportColumns" :data="artifactReports" :loading="listLoading" row-key="id">
              <template #cell-created_at="{ value }">
                <span class="whitespace-nowrap text-sm">{{ formatDateTime(value) }}</span>
              </template>
              <template #cell-artifact="{ row }">
                <div class="min-w-0 max-w-xs" :data-testid="`claudex-artifact-report-row-${row.id}`">
                  <p class="truncate text-sm font-medium text-gray-900 dark:text-white" :title="row.title">
                    {{ row.title || t('admin.claudexSharing.fields.untitled') }}
                  </p>
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    <span class="font-mono">{{ row.language || '--' }}</span> · {{ formatBytes(row.content_bytes) }} ·
                    {{ userLabel(row.user_id, row.user_email) }}
                  </p>
                </div>
              </template>
              <template #cell-reason="{ row }">
                <span class="text-sm">{{ categoryLabel(row.category) }}</span>
              </template>
              <template #cell-detail="{ row }">
                <span class="block max-w-xs whitespace-pre-wrap break-words text-sm" :class="{ 'text-gray-400': !row.notes }">
                  {{ row.notes || t('admin.claudexSharing.reports.noDetail') }}
                </span>
                <p
                  v-if="reporterLabel(row)"
                  class="mt-1 max-w-xs break-words text-xs text-gray-500 dark:text-gray-400"
                  :data-testid="`claudex-artifact-report-reporter-${row.id}`"
                >
                  {{ t('admin.claudexSharing.reports.reporter', { who: reporterLabel(row) }) }}
                </p>
              </template>
              <template #cell-status="{ value }">
                <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" :class="reportStatusClass(value)">
                  {{ t(`admin.claudexSharing.artifactReports.statuses.${value}`) }}
                </span>
              </template>
              <template #cell-actions="{ row }">
                <div class="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :data-testid="`claudex-artifact-report-review-${row.id}`"
                    @click="openArtifactCopy(row.id)"
                  >
                    {{ t('admin.claudexSharing.actions.review') }}
                  </button>
                  <template v-if="row.status === 'open'">
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      :data-testid="`claudex-artifact-report-dismiss-${row.id}`"
                      @click="settleArtifactReport(row, 'dismiss')"
                    >
                      {{ t('admin.claudexSharing.actions.dismiss') }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      :data-testid="`claudex-artifact-report-resolve-${row.id}`"
                      @click="settleArtifactReport(row, 'resolve')"
                    >
                      {{ t('admin.claudexSharing.actions.resolve') }}
                    </button>
                  </template>
                </div>
              </template>
              <template #empty>
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-sharing-artifact-reports-empty">
                  {{ t('admin.claudexSharing.artifactReports.empty') }}
                </p>
              </template>
            </DataTable>
          </template>

          <!-- Blocked users -->
          <template v-else>
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexSharing.blocks.description') }}</p>
            <form class="flex flex-col gap-3 sm:flex-row sm:items-end" data-testid="claudex-sharing-block-form" @submit.prevent="blockFromForm">
              <div class="sm:w-40">
                <label for="claudex-block-user" class="input-label mb-1.5 block">{{ t('admin.claudexSharing.blocks.userId') }}</label>
                <input
                  id="claudex-block-user"
                  v-model="blockUserId"
                  type="number"
                  min="1"
                  step="1"
                  inputmode="numeric"
                  class="input w-full"
                  data-testid="claudex-block-user"
                />
              </div>
              <button type="submit" class="btn btn-secondary" :disabled="!blockUserValid" data-testid="claudex-block-submit">
                {{ t('admin.claudexSharing.actions.block') }}
              </button>
            </form>

            <DataTable :columns="blockColumns" :data="blocks" :loading="listLoading" row-key="user_id">
              <template #cell-user="{ row }">
                <span class="text-sm" :data-testid="`claudex-block-row-${row.user_id}`">{{ userLabel(row.user_id, row.user_email) }}</span>
              </template>
              <template #cell-reason="{ value }">
                <span class="block max-w-xs truncate text-sm" :title="value">{{ value || '--' }}</span>
              </template>
              <template #cell-created_at="{ value }">
                <span class="whitespace-nowrap text-sm">{{ formatDateTime(value) }}</span>
              </template>
              <template #cell-actions="{ row }">
                <div class="flex flex-wrap items-center gap-1">
                  <button type="button" class="btn btn-ghost btn-sm" :data-testid="`claudex-block-remove-${row.user_id}`" @click="unblock(row)">
                    {{ t('admin.claudexSharing.actions.unblock') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm text-amber-700 dark:text-amber-400"
                    :data-testid="`claudex-block-takedown-all-${row.user_id}`"
                    @click="takeDownAll(row)"
                  >
                    {{ t('admin.claudexSharing.actions.takeDownAll') }}
                  </button>
                </div>
              </template>
              <template #empty>
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-sharing-blocks-empty">
                  {{ t('admin.claudexSharing.blocks.empty') }}
                </p>
              </template>
            </DataTable>
          </template>

          <Pagination
            v-if="listTotal > PAGE_SIZE"
            :total="listTotal"
            :page="listPage"
            :page-size="PAGE_SIZE"
            :show-page-size-selector="false"
            @update:page="changePage"
          />
        </div>
      </div>
    </template>

    <DetailDrawer
      :show="contentOpen"
      :title="t('admin.claudexSharing.content.title')"
      :loading="contentLoading"
      :error="contentError"
      @close="closeContent"
    >
      <div v-if="content" class="space-y-5 text-sm" data-testid="claudex-sharing-content">
        <div>
          <p class="text-base font-semibold text-gray-900 dark:text-white">
            {{ content.snapshot.title || t('admin.claudexSharing.fields.untitled') }}
          </p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {{ t(`admin.claudexSharing.kinds.${content.snapshot.kind}`) }}
            <template v-if="content.snapshot.mode"> · {{ t('admin.claudexSharing.content.mode') }}: {{ content.snapshot.mode }}</template>
            <template v-if="content.snapshot.model_label">
              · {{ t('admin.claudexSharing.content.model') }}: {{ content.snapshot.model_label }}
            </template>
          </p>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ t('admin.claudexSharing.content.note') }}</p>
        </div>

        <template v-if="content.snapshot.kind === 'conversation'">
          <p v-if="!content.snapshot.messages?.length" class="text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexSharing.content.empty') }}
          </p>
          <div
            v-for="(message, index) in content.snapshot.messages ?? []"
            :key="index"
            class="rounded-lg p-3"
            :class="message.role === 'user' ? 'bg-gray-50 dark:bg-dark-900/40' : 'border border-gray-100 dark:border-dark-700'"
            data-testid="claudex-sharing-content-message"
          >
            <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {{ message.role === 'user' ? t('admin.claudexSharing.content.user') : t('admin.claudexSharing.content.assistant') }}
            </p>
            <p class="whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">{{ message.text }}</p>
            <p v-if="message.activity?.length" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexSharing.content.activity') }}: {{ message.activity.join(' · ') }}
            </p>
            <p v-if="message.artifacts?.length" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ message.artifacts.map((n) => t('admin.claudexSharing.content.artifactRef', { n: n + 1 })).join(', ') }}
            </p>
          </div>
        </template>

        <div v-if="content.snapshot.artifacts?.length" class="space-y-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexSharing.content.artifacts') }}
          </p>
          <div
            v-for="(artifact, index) in content.snapshot.artifacts"
            :key="index"
            class="rounded-lg border border-gray-100 dark:border-dark-700"
            data-testid="claudex-sharing-content-artifact"
          >
            <p class="border-b border-gray-100 px-3 py-2 text-xs text-gray-600 dark:border-dark-700 dark:text-gray-300">
              {{ t('admin.claudexSharing.content.artifactRef', { n: index + 1 }) }} ·
              <span class="font-medium text-gray-900 dark:text-white">{{ artifact.title || t('admin.claudexSharing.fields.untitled') }}</span>
              · <span class="font-mono">{{ artifact.code_language || artifact.language }}</span>
            </p>
            <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-gray-900 dark:text-gray-100">{{
              artifact.content
            }}</pre>
          </div>
        </div>
      </div>
    </DetailDrawer>

    <DetailDrawer
      :show="artifactCopyOpen"
      :title="t('admin.claudexSharing.artifactReports.reviewTitle')"
      :loading="artifactCopyLoading"
      :error="artifactCopyError"
      @close="closeArtifactCopy"
    >
      <div v-if="artifactCopy" class="space-y-4 text-sm" data-testid="claudex-artifact-report-copy">
        <div>
          <p class="text-base font-semibold text-gray-900 dark:text-white">
            {{ artifactCopy.title || t('admin.claudexSharing.fields.untitled') }}
          </p>
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            <span class="font-mono">{{ artifactCopy.language || '--' }}</span> ·
            {{ userLabel(artifactCopy.user_id, artifactCopy.user_email) }}
          </p>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ t('admin.claudexSharing.artifactReports.reviewNote') }}</p>
          <p
            v-if="artifactCopy.content_truncated"
            class="mt-1 text-xs text-amber-700 dark:text-amber-400"
            data-testid="claudex-artifact-report-copy-cut"
          >
            {{
              artifactCopy.content
                ? t('admin.claudexSharing.artifactReports.copyCut', {
                    size: formatBytes(copyBytes(artifactCopy.content)),
                    total: formatBytes(artifactCopy.content_bytes)
                  })
                : t('admin.claudexSharing.artifactReports.noCopy', { total: formatBytes(artifactCopy.content_bytes) })
            }}
          </p>
        </div>
        <pre
          v-if="artifactCopy.content"
          class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-100 p-3 font-mono text-xs text-gray-900 dark:border-dark-700 dark:text-gray-100"
          >{{ artifactCopy.content }}</pre
        >
      </div>
    </DetailDrawer>

    <ConfirmDialog
      :show="ask.show"
      :title="ask.title"
      :message="ask.message"
      :confirm-text="ask.confirmText || undefined"
      :danger="ask.danger"
      :z-index="55"
      @confirm="settleAsk(true)"
      @cancel="settleAsk(false)"
    >
      <div v-if="ask.withReason" data-testid="claudex-sharing-reason">
        <label for="claudex-sharing-reason-input" class="input-label mb-1.5 block">{{ t('admin.claudexSharing.reason.label') }}</label>
        <textarea
          id="claudex-sharing-reason-input"
          v-model="ask.reason"
          rows="3"
          class="input w-full"
          :class="{ 'input-error': reasonTooLong }"
          :placeholder="t('admin.claudexSharing.reason.placeholder')"
          data-testid="claudex-sharing-reason-input"
        ></textarea>
        <p v-if="reasonTooLong" class="input-error-text mt-1.5">{{ t('admin.claudexSharing.reason.tooLong') }}</p>
        <p v-else class="input-hint mt-1.5">{{ t('admin.claudexSharing.reason.hint') }}</p>
      </div>
    </ConfirmDialog>
    <TotpStepUpDialog :controller="stepUp" />
  </ClaudexPageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import ClaudexUnavailable from '@/components/admin/claudex/common/ClaudexUnavailable.vue'
import SaveBar from '@/components/admin/claudex/common/SaveBar.vue'
import { useClaudexSave } from '@/components/admin/claudex/common/useClaudexSave'
import { claudexErrorMessage, claudexErrorReason } from '@/components/admin/claudex/common/errors'
import DetailDrawer from '@/components/admin/claudex/feedback/DetailDrawer.vue'
import { isMissingEndpoint, runWithStepUp, snapshot, toInteger } from '@/components/admin/claudex/general/pageSupport'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import DataTable from '@/components/common/DataTable.vue'
import Pagination from '@/components/common/Pagination.vue'
import Toggle from '@/components/common/Toggle.vue'
import type { Column } from '@/components/common/types'
import Icon from '@/components/icons/Icon.vue'
import {
  SHARING_LIMITS,
  blockUser,
  deleteShare,
  disableAllOfUser,
  disableShare,
  enableShare,
  getSettings,
  getArtifactReport,
  getShareContent,
  listArtifactReports,
  listBlocks,
  listReports,
  listShares,
  normalizeSharingSettings,
  reasonLength,
  resolveArtifactReport,
  resolveReport,
  shareLink,
  sharingFormFromSettings,
  sharingSettingsFromForm,
  unblockUser,
  updateSettings,
  validateSharingForm,
  type AdminShare,
  type ArtifactReport,
  type ArtifactReportContent,
  type ArtifactResolveAction,
  type ReportStatus,
  type ShareBlock,
  type ShareContent,
  type ShareKind,
  type ShareReport,
  type ShareStatus,
  type SharesQuery,
  type SharingEffective,
  type SharingForm,
  type SharingFormField,
  type SharingSettings,
  type SharingSettingsResponse
} from '@/api/admin/claudex/sharing'
import { isStepUpCancelled, useStepUp } from '@/composables/useStepUp'
import { useAppStore } from '@/stores/app'
import { extractApiErrorMessage, extractApiErrorMetadata } from '@/utils/apiError'
import { formatBytes, formatDateTime } from '@/utils/format'

type Tab = 'shares' | 'reports' | 'artifactReports' | 'blocks'
type SwitchKey = 'conversations' | 'artifacts' | 'allowReports'
type UrlModel = 'publicBaseUrl' | 'contentBaseUrl' | 'usagePolicyUrl'
type NumberModel = 'maxSnapshotKiB' | 'maxArtifactKiB' | 'maxActivePerUser' | 'defaultTtlDays'

const PAGE = 'claudexSharing'
const PAGE_SIZE = 20
const SHARE_STATUSES: ShareStatus[] = ['active', 'disabled', 'revoked']
const REPORT_STATUSES: ReportStatus[] = ['open', 'resolved', 'dismissed']
const REPORT_REASONS: string[] = ['illegal', 'harmful', 'privacy', 'spam', 'other']
// The app's Report chat categories (the live claude.ai report form, 2026-10-12).
const REPORT_CATEGORIES: string[] = [
  'child_safety',
  'fraud',
  'sexually_explicit_content',
  'non_consensual_intimate_imagery',
  'violence_and_hate',
  'illegal_goods',
  'defamation',
  'other_illegal',
  'violation_of_terms'
]
const URL_FIELDS: SharingFormField[] = ['public_base_url', 'content_base_url', 'usage_policy_url']

const { t, te } = useI18n()
const stepUp = useStepUp()
const appStore = useAppStore()
const save = useClaudexSave(PAGE)

const loading = ref(false)
const loadError = ref<string | null>(null)
const unavailable = ref(false)
const loaded = ref(false)
const form = ref<SharingForm>(sharingFormFromSettings(null))
const savedSettings = ref<SharingSettings | null>(null)
const effective = ref<SharingEffective>({
  public_base_url: '',
  public_base_url_source: 'none',
  usage_policy_url: '',
  usage_policy_path: '',
  storage_available: true
})
const baseline = ref('')
const formError = ref<string | null>(null)
const attempted = ref(false)
const touched = reactive<Partial<Record<SharingFormField, boolean>>>({})
/** A field the server refused on the last save, with its message. */
const serverProblem = ref<{ field: string; message: string } | null>(null)

const problems = computed(() => validateSharingForm(form.value))
const dirty = computed(() => loaded.value && snapshot(sharingSettingsFromForm(form.value)) !== baseline.value)
const savedEnabled = computed(() => savedSettings.value?.enabled === true)

const switchRows = computed<{ key: SwitchKey; label: string; hint: string }[]>(() => [
  {
    key: 'conversations',
    label: t('admin.claudexSharing.settings.conversations'),
    hint: t('admin.claudexSharing.settings.conversationsHint')
  },
  {
    key: 'artifacts',
    label: t('admin.claudexSharing.settings.artifacts'),
    hint: t('admin.claudexSharing.settings.artifactsHint')
  },
  {
    key: 'allowReports',
    label: t('admin.claudexSharing.settings.allowReports'),
    hint: t('admin.claudexSharing.settings.allowReportsHint')
  }
])

const urlFields = computed<{ key: SharingFormField; model: UrlModel; label: string; hint: string; placeholder: string }[]>(
  () => [
    {
      key: 'public_base_url',
      model: 'publicBaseUrl',
      label: t('admin.claudexSharing.links.publicBaseUrl'),
      hint: t('admin.claudexSharing.links.publicBaseUrlHint'),
      placeholder: 'https://share.example.com'
    },
    {
      key: 'content_base_url',
      model: 'contentBaseUrl',
      label: t('admin.claudexSharing.links.contentBaseUrl'),
      hint: t('admin.claudexSharing.links.contentBaseUrlHint'),
      placeholder: 'https://content.example.net'
    },
    {
      key: 'usage_policy_url',
      model: 'usagePolicyUrl',
      label: t('admin.claudexSharing.links.usagePolicyUrl'),
      hint: t('admin.claudexSharing.links.usagePolicyUrlHint'),
      placeholder: 'https://'
    }
  ]
)

const numberFields = computed<
  { key: SharingFormField; model: NumberModel; label: string; hint?: string; min: number; max: number }[]
>(() => [
  {
    key: 'max_snapshot_bytes',
    model: 'maxSnapshotKiB',
    label: t('admin.claudexSharing.limits.maxSnapshot'),
    min: SHARING_LIMITS.minSnapshotKiB,
    max: SHARING_LIMITS.maxSnapshotKiB
  },
  {
    key: 'max_artifact_bytes',
    model: 'maxArtifactKiB',
    label: t('admin.claudexSharing.limits.maxArtifact'),
    min: SHARING_LIMITS.minArtifactKiB,
    max: SHARING_LIMITS.maxSnapshotKiB
  },
  {
    key: 'max_active_per_user',
    model: 'maxActivePerUser',
    label: t('admin.claudexSharing.limits.maxActive'),
    min: 1,
    max: SHARING_LIMITS.maxActivePerUser
  },
  {
    key: 'default_ttl_days',
    model: 'defaultTtlDays',
    label: t('admin.claudexSharing.limits.ttl'),
    hint: t('admin.claudexSharing.limits.ttlHint'),
    min: 0,
    max: SHARING_LIMITS.maxTTLDays
  }
])

const baseSourceText = computed(() => {
  const source = effective.value.public_base_url_source
  const key = `admin.claudexSharing.links.sources.${source}`
  if (source === 'setting' || source === 'frontend_url' || source === 'none') return t(key)
  return ''
})

const effectivePolicy = computed(() => {
  const e = effective.value
  if (e.usage_policy_url) return e.usage_policy_url
  if (e.usage_policy_path) return linkOf('', e.usage_policy_path)
  return ''
})

/** The message under a settings field: a server refusal, or a local problem once touched or after a save attempt. */
function fieldProblem(field: SharingFormField): string {
  if (serverProblem.value?.field === field) return serverProblem.value.message
  const problem = problems.value[field]
  if (!problem) return ''
  const isUrl = URL_FIELDS.includes(field)
  if (isUrl && !touched[field] && !attempted.value) return ''
  return t(`admin.claudexSharing.problems.${problem}`)
}

watch(
  form,
  () => {
    formError.value = null
    serverProblem.value = null
    if (dirty.value) save.reset()
  },
  { deep: true }
)

function apply(response: SharingSettingsResponse) {
  const settings = normalizeSharingSettings(response?.settings)
  form.value = sharingFormFromSettings(settings)
  savedSettings.value = settings
  baseline.value = snapshot(sharingSettingsFromForm(form.value))
  if (response?.effective) {
    effective.value = { ...effective.value, ...response.effective }
  }
  attempted.value = false
}

async function load() {
  loading.value = true
  loadError.value = null
  unavailable.value = false
  try {
    apply(await getSettings())
    loaded.value = true
    if (effective.value.storage_available) {
      void loadList()
      void refreshOpenReports()
    }
  } catch (err) {
    if (isMissingEndpoint(err)) {
      unavailable.value = true
    } else {
      loadError.value = claudexErrorMessage(err, t, te, PAGE, t('admin.claudex.common.loadFailed'))
    }
  } finally {
    loading.value = false
  }
}

async function submit() {
  attempted.value = true
  if (Object.keys(problems.value).length > 0) {
    formError.value = t('admin.claudexSharing.fixProblems')
    return
  }
  const body = sharingSettingsFromForm(form.value)
  const result = await save.run(() => runWithStepUp(stepUp, () => updateSettings(body), t))
  if (result.ok) {
    apply(result.value)
    return
  }
  const err = save.lastError.value
  if (claudexErrorReason(err) === 'CLAUDEX_SETTING_INVALID') {
    const field = extractApiErrorMetadata(err)?.field
    if (typeof field === 'string' && field) {
      serverProblem.value = { field, message: extractApiErrorMessage(err, t('admin.claudex.common.saveFailed')) }
    }
  }
}

// ---------------------------------------------------------------------------
// Moderation lists

const tabs: Tab[] = ['shares', 'reports', 'artifactReports', 'blocks']
const activeTab = ref<Tab>('shares')
const listLoading = ref(false)
const listError = ref<string | null>(null)
const listPage = ref(1)
const listTotal = ref(0)
const shares = ref<AdminShare[]>([])
const reports = ref<ShareReport[]>([])
const blocks = ref<ShareBlock[]>([])
const openReports = ref(0)
const artifactReports = ref<ArtifactReport[]>([])
const openArtifactReports = ref(0)
const artifactReportStatus = ref<'' | ReportStatus>('open')
const shareFilters = reactive({ status: '' as '' | ShareStatus, kind: '' as '' | ShareKind, userId: '' as number | string, q: '' })
const appliedShareQuery = ref<SharesQuery>({})
const reportStatus = ref<'' | ReportStatus>('open')
const blockUserId = ref<number | string>('')
let listSeq = 0

const blockUserValid = computed(() => {
  const id = toInteger(blockUserId.value)
  return id !== null && id > 0
})

const shareColumns = computed<Column[]>(() => [
  { key: 'title', label: t('admin.claudexSharing.fields.title') },
  { key: 'author', label: t('admin.claudexSharing.fields.author') },
  { key: 'status', label: t('admin.claudexSharing.fields.status') },
  { key: 'view_count', label: t('admin.claudexSharing.fields.views') },
  { key: 'open_reports', label: t('admin.claudexSharing.fields.reports') },
  { key: 'content_bytes', label: t('admin.claudexSharing.fields.size') },
  { key: 'created_at', label: t('admin.claudexSharing.fields.created') },
  { key: 'expires_at', label: t('admin.claudexSharing.fields.expires') },
  { key: 'actions', label: t('admin.claudexSharing.fields.actions') }
])

const reportColumns = computed<Column[]>(() => [
  { key: 'created_at', label: t('admin.claudexSharing.fields.reported') },
  { key: 'share', label: t('admin.claudexSharing.fields.share') },
  { key: 'reason', label: t('admin.claudexSharing.fields.reason') },
  { key: 'detail', label: t('admin.claudexSharing.fields.detail') },
  { key: 'status', label: t('admin.claudexSharing.fields.status') },
  { key: 'actions', label: t('admin.claudexSharing.fields.actions') }
])

const artifactReportColumns = computed<Column[]>(() => [
  { key: 'created_at', label: t('admin.claudexSharing.fields.reported') },
  { key: 'artifact', label: t('admin.claudexSharing.fields.artifact') },
  { key: 'reason', label: t('admin.claudexSharing.fields.reason') },
  { key: 'detail', label: t('admin.claudexSharing.fields.detail') },
  { key: 'status', label: t('admin.claudexSharing.fields.status') },
  { key: 'actions', label: t('admin.claudexSharing.fields.actions') }
])

const blockColumns = computed<Column[]>(() => [
  { key: 'user', label: t('admin.claudexSharing.fields.user') },
  { key: 'reason', label: t('admin.claudexSharing.fields.reason') },
  { key: 'created_at', label: t('admin.claudexSharing.fields.blockedAt') },
  { key: 'actions', label: t('admin.claudexSharing.fields.actions') }
])

function linkOf(url: string | null | undefined, path: string | null | undefined): string {
  return shareLink(url, path, typeof window !== 'undefined' ? window.location.origin : '')
}

function userLabel(id: number, email: string | null | undefined): string {
  return email ? `${email} (#${id})` : `#${id}`
}

function shareState(row: AdminShare): ShareStatus | 'expired' {
  if (row.status === 'active' && row.expired) return 'expired'
  return row.status
}

function statusClass(state: ShareStatus | 'expired'): string {
  switch (state) {
    case 'active':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
    case 'disabled':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-dark-700 dark:text-gray-300'
  }
}

function reportStatusClass(status: string): string {
  if (status === 'open') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (status === 'resolved') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
  return 'bg-gray-100 text-gray-600 dark:bg-dark-700 dark:text-gray-300'
}

function reasonLabel(reason: string): string {
  return REPORT_REASONS.includes(reason) ? t(`admin.claudexSharing.reports.reasons.${reason}`) : reason
}

function categoryLabel(category: string): string {
  return REPORT_CATEGORIES.includes(category) ? t(`admin.claudexSharing.reports.categories.${category}`) : category
}

/** Who sent an app report: the name and e-mail they gave, then the account. */
function reporterLabel(row: Pick<ShareReport, 'reporter_name' | 'reporter_email' | 'reporter_user_id'>): string {
  const parts = [row.reporter_name, row.reporter_email].filter((part): part is string => !!part)
  if (row.reporter_user_id) parts.push(`#${row.reporter_user_id}`)
  return parts.join(' · ')
}

async function loadList() {
  const seq = ++listSeq
  const tab = activeTab.value
  listLoading.value = true
  listError.value = null
  try {
    const paging = { page: listPage.value, page_size: PAGE_SIZE }
    if (tab === 'shares') {
      const result = await listShares({ ...appliedShareQuery.value, ...paging })
      if (seq !== listSeq) return
      shares.value = result.items ?? []
      listTotal.value = result.total ?? 0
    } else if (tab === 'reports') {
      const result = await listReports(reportStatus.value ? { status: reportStatus.value, ...paging } : paging)
      if (seq !== listSeq) return
      reports.value = result.items ?? []
      listTotal.value = result.total ?? 0
    } else if (tab === 'artifactReports') {
      const status = artifactReportStatus.value
      const result = await listArtifactReports(status ? { status, ...paging } : paging)
      if (seq !== listSeq) return
      artifactReports.value = result.items ?? []
      listTotal.value = result.total ?? 0
    } else {
      const result = await listBlocks(paging)
      if (seq !== listSeq) return
      blocks.value = result.items ?? []
      listTotal.value = result.total ?? 0
    }
  } catch (err) {
    if (seq !== listSeq) return
    listTotal.value = 0
    const fallback = t(`admin.claudexSharing.${tab}.loadFailed`)
    listError.value = claudexErrorMessage(err, t, te, PAGE, fallback)
  } finally {
    if (seq === listSeq) listLoading.value = false
  }
}

async function refreshOpenReports() {
  try {
    const result = await listReports({ status: 'open', page: 1, page_size: 1 })
    openReports.value = result.total ?? 0
  } catch {
    // The badge is only a hint; the Reports tab shows the error.
  }
  try {
    const result = await listArtifactReports({ status: 'open', page: 1, page_size: 1 })
    openArtifactReports.value = result.total ?? 0
  } catch {
    // A server before artifact reports, or a failure the tab shows.
  }
}

function selectTab(tab: Tab) {
  if (activeTab.value === tab) return
  activeTab.value = tab
  listPage.value = 1
  listTotal.value = 0
  void loadList()
}

function changePage(next: number) {
  listPage.value = next
  void loadList()
}

function applyShareFilters() {
  const query: SharesQuery = {}
  if (shareFilters.status) query.status = shareFilters.status
  if (shareFilters.kind) query.kind = shareFilters.kind
  const userId = toInteger(shareFilters.userId)
  if (userId !== null && userId > 0) query.user_id = userId
  const q = shareFilters.q.trim()
  if (q) query.q = q
  appliedShareQuery.value = query
  listPage.value = 1
  void loadList()
}

function resetShareFilters() {
  Object.assign(shareFilters, { status: '', kind: '', userId: '', q: '' })
  applyShareFilters()
}

function changeReportStatus() {
  listPage.value = 1
  void loadList()
}

// ---------------------------------------------------------------------------
// Confirmation with an optional reason

const ask = reactive({
  show: false,
  title: '',
  message: '',
  confirmText: '',
  danger: false,
  withReason: false,
  reason: ''
})
let askResolver: ((answer: { ok: boolean; reason: string }) => void) | null = null
const reasonTooLong = computed(() => reasonLength(ask.reason) > SHARING_LIMITS.maxReasonLength)

function settleAsk(ok: boolean) {
  if (ok && ask.withReason && reasonTooLong.value) return
  ask.show = false
  const resolve = askResolver
  askResolver = null
  resolve?.({ ok, reason: ask.reason.trim() })
}

function confirmAction(options: {
  title: string
  message: string
  confirmText: string
  danger?: boolean
  withReason?: boolean
}): Promise<{ ok: boolean; reason: string }> {
  settleAsk(false)
  Object.assign(ask, {
    title: options.title,
    message: options.message,
    confirmText: options.confirmText,
    danger: options.danger ?? false,
    withReason: options.withReason ?? false,
    reason: '',
    show: true
  })
  return new Promise((resolve) => {
    askResolver = resolve
  })
}

/**
 * Runs a confirmed write through step-up, shows the outcome and reloads the
 * list. A cancelled step-up prompt changes nothing and shows nothing.
 */
async function act<T>(action: () => Promise<T>, success: (value: T) => string): Promise<boolean> {
  try {
    const value = await runWithStepUp(stepUp, action, t)
    appStore.showSuccess(success(value))
    return true
  } catch (err) {
    if (isStepUpCancelled(err)) return false
    const reason = claudexErrorReason(err)
    appStore.showError(claudexErrorMessage(err, t, te, PAGE, t('admin.claudexSharing.toasts.actionFailed')))
    // A link or report that is already gone: close its review so nothing stale stays open.
    if (reason === 'CLAUDEX_SHARE_NOT_FOUND' && contentOpen.value) closeContent()
    return false
  } finally {
    void loadList()
    void refreshOpenReports()
  }
}

function titleOf(title: string): string {
  return title || t('admin.claudexSharing.fields.untitled')
}

async function takeDown(row: AdminShare) {
  const answer = await confirmAction({
    title: t('admin.claudexSharing.confirm.takeDownTitle'),
    message: t('admin.claudexSharing.confirm.takeDownMessage', { title: titleOf(row.title) }),
    confirmText: t('admin.claudexSharing.actions.takeDown'),
    danger: true,
    withReason: true
  })
  if (!answer.ok) return
  await act(
    () => disableShare(row.id, answer.reason),
    () => t('admin.claudexSharing.toasts.takenDown')
  )
}

async function restore(row: AdminShare) {
  const answer = await confirmAction({
    title: t('admin.claudexSharing.confirm.restoreTitle'),
    message: t('admin.claudexSharing.confirm.restoreMessage', { title: titleOf(row.title) }),
    confirmText: t('admin.claudexSharing.actions.restore')
  })
  if (!answer.ok) return
  await act(
    () => enableShare(row.id),
    () => t('admin.claudexSharing.toasts.restored')
  )
}

async function remove(row: AdminShare) {
  const answer = await confirmAction({
    title: t('admin.claudexSharing.confirm.deleteTitle'),
    message: t('admin.claudexSharing.confirm.deleteMessage', { title: titleOf(row.title) }),
    confirmText: t('admin.claudexSharing.actions.delete'),
    danger: true
  })
  if (!answer.ok) return
  await act(
    () => deleteShare(row.id),
    () => t('admin.claudexSharing.toasts.deleted')
  )
  if (content.value?.id === row.id) closeContent()
}

async function block(userId: number, email: string | null | undefined) {
  const answer = await confirmAction({
    title: t('admin.claudexSharing.confirm.blockTitle', { user: userLabel(userId, email) }),
    message: t('admin.claudexSharing.confirm.blockMessage'),
    confirmText: t('admin.claudexSharing.actions.block'),
    danger: true,
    withReason: true
  })
  if (!answer.ok) return false
  return act(
    () => blockUser(userId, answer.reason),
    () => t('admin.claudexSharing.toasts.blocked')
  )
}

async function blockFromForm() {
  const id = toInteger(blockUserId.value)
  if (id === null || id <= 0) return
  if (await block(id, '')) blockUserId.value = ''
}

async function unblock(row: ShareBlock) {
  const answer = await confirmAction({
    title: t('admin.claudexSharing.confirm.unblockTitle', { user: userLabel(row.user_id, row.user_email) }),
    message: t('admin.claudexSharing.confirm.unblockMessage'),
    confirmText: t('admin.claudexSharing.actions.unblock')
  })
  if (!answer.ok) return
  await act(
    () => unblockUser(row.user_id),
    () => t('admin.claudexSharing.toasts.unblocked')
  )
}

async function takeDownAll(row: ShareBlock) {
  const answer = await confirmAction({
    title: t('admin.claudexSharing.confirm.takeDownAllTitle', { user: userLabel(row.user_id, row.user_email) }),
    message: t('admin.claudexSharing.confirm.takeDownAllMessage'),
    confirmText: t('admin.claudexSharing.actions.takeDownAll'),
    danger: true,
    withReason: true
  })
  if (!answer.ok) return
  await act(
    () => disableAllOfUser(row.user_id, answer.reason),
    (result) => t('admin.claudexSharing.toasts.takenDownAll', { count: result?.disabled ?? 0 })
  )
}

async function dismissReport(row: ShareReport) {
  const answer = await confirmAction({
    title: t('admin.claudexSharing.confirm.dismissTitle'),
    message: t('admin.claudexSharing.confirm.dismissMessage'),
    confirmText: t('admin.claudexSharing.actions.dismiss')
  })
  if (!answer.ok) return
  await act(
    () => resolveReport(row.id, 'dismiss'),
    () => t('admin.claudexSharing.toasts.dismissed')
  )
}

async function takeDownReported(row: ShareReport) {
  const answer = await confirmAction({
    title: t('admin.claudexSharing.confirm.reportTakeDownTitle'),
    message: t('admin.claudexSharing.confirm.reportTakeDownMessage', { title: titleOf(row.share_title) }),
    confirmText: t('admin.claudexSharing.actions.takeDown'),
    danger: true,
    withReason: true
  })
  if (!answer.ok) return
  await act(
    () => resolveReport(row.id, 'disable', answer.reason),
    () => t('admin.claudexSharing.toasts.takenDown')
  )
}

async function settleArtifactReport(row: ArtifactReport, action: ArtifactResolveAction) {
  const dismiss = action === 'dismiss'
  const answer = await confirmAction({
    title: t(dismiss ? 'admin.claudexSharing.confirm.dismissTitle' : 'admin.claudexSharing.confirm.artifactResolveTitle'),
    message: t(dismiss ? 'admin.claudexSharing.confirm.artifactDismissMessage' : 'admin.claudexSharing.confirm.artifactResolveMessage'),
    confirmText: t(dismiss ? 'admin.claudexSharing.actions.dismiss' : 'admin.claudexSharing.actions.resolve')
  })
  if (!answer.ok) return
  await act(
    () => resolveArtifactReport(row.id, action),
    () => t(dismiss ? 'admin.claudexSharing.toasts.dismissed' : 'admin.claudexSharing.toasts.resolved')
  )
}

// ---------------------------------------------------------------------------
// Artifact report copy (plain text only; never rendered or run)

const artifactCopyOpen = ref(false)
const artifactCopyLoading = ref(false)
const artifactCopyError = ref<string | null>(null)
const artifactCopy = ref<ArtifactReportContent | null>(null)
let artifactCopySeq = 0

/** The UTF-8 size of the copy, to say how much of the artifact it holds. */
function copyBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

async function openArtifactCopy(id: number) {
  const seq = ++artifactCopySeq
  artifactCopyOpen.value = true
  artifactCopy.value = null
  artifactCopyError.value = null
  artifactCopyLoading.value = true
  try {
    const result = await getArtifactReport(id)
    if (seq === artifactCopySeq) artifactCopy.value = result
  } catch (err) {
    if (seq === artifactCopySeq) {
      artifactCopyError.value = claudexErrorMessage(err, t, te, PAGE, t('admin.claudexSharing.artifactReports.copyLoadFailed'))
    }
  } finally {
    if (seq === artifactCopySeq) artifactCopyLoading.value = false
  }
}

function closeArtifactCopy() {
  artifactCopySeq++
  artifactCopyOpen.value = false
  artifactCopy.value = null
  artifactCopyError.value = null
  artifactCopyLoading.value = false
}

// ---------------------------------------------------------------------------
// Content review (plain text only; nothing from a snapshot is rendered as HTML)

const contentOpen = ref(false)
const contentLoading = ref(false)
const contentError = ref<string | null>(null)
const content = ref<ShareContent | null>(null)
let contentSeq = 0

async function openContent(shareId: number) {
  const seq = ++contentSeq
  contentOpen.value = true
  content.value = null
  contentError.value = null
  contentLoading.value = true
  try {
    const result = await getShareContent(shareId)
    if (seq === contentSeq) content.value = result
  } catch (err) {
    if (seq === contentSeq) {
      contentError.value = claudexErrorMessage(err, t, te, PAGE, t('admin.claudexSharing.content.loadFailed'))
    }
  } finally {
    if (seq === contentSeq) contentLoading.value = false
  }
}

function closeContent() {
  contentSeq++
  contentOpen.value = false
  content.value = null
  contentError.value = null
  contentLoading.value = false
}

onMounted(load)
</script>

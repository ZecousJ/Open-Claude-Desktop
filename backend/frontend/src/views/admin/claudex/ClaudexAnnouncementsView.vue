<!--
  CLAUDEX: /admin/claudex/announcements. Pop-up notices for the Claudex apps
  and e-mail notices. A pop-up is written here (badge, title, HTML body with
  its own styles, optional picture and button), previewed as it will look
  (light and dark), then published for a time: the apps show it once to every
  signed-in user, and it comes down by itself when the time is up. Published
  pop-ups can be edited or withdrawn at any time. E-mail notices are written
  the same way and sent to chosen users.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexAnnouncements.title')"
    :description="t('admin.claudexAnnouncements.description')"
    :loading="loading && !loaded"
    :load-error="loadError"
    test-id="claudex-announcements-page"
    @retry="load"
  >
    <ClaudexUnavailable v-if="unavailable" />

    <template v-else-if="loaded">
      <div class="flex gap-1 border-b border-gray-200 dark:border-dark-700" role="tablist">
        <button
          v-for="name in ['popups', 'mail']"
          :key="name"
          type="button"
          role="tab"
          :aria-selected="tab === name"
          class="-mb-px border-b-2 px-4 py-2 text-sm font-medium"
          :class="
            tab === name
              ? 'border-primary-600 text-primary-600 dark:border-primary-400 dark:text-primary-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
          "
          :data-testid="`claudex-announcements-tab-${name}`"
          @click="tab = name as 'popups' | 'mail'"
        >
          {{ t(`admin.claudexAnnouncements.tabs.${name}`) }}
        </button>
      </div>

      <!-- Pop-ups -->
      <div v-if="tab === 'popups'" class="space-y-6" data-testid="claudex-announcements-popups">
        <div v-if="!editing" class="card">
          <div class="flex items-center justify-between gap-4 border-b border-gray-100 px-6 py-4 dark:border-dark-700">
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.claudexAnnouncements.popups.intro') }}</p>
            <button type="button" class="btn btn-primary" data-testid="claudex-announcements-new" @click="startNew">
              {{ t('admin.claudexAnnouncements.popups.new') }}
            </button>
          </div>
          <p v-if="!items.length" class="px-6 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexAnnouncements.popups.none') }}
          </p>
          <ul v-else class="divide-y divide-gray-100 dark:divide-dark-700">
            <li
              v-for="item in items"
              :key="item.id"
              class="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4"
              data-testid="claudex-announcements-row"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate font-medium text-gray-900 dark:text-white">
                    {{ item.title || t('admin.claudexAnnouncements.popups.untitled') }}
                  </span>
                  <span class="rounded px-1.5 py-0.5 text-xs" :class="statusClass(item.status)">
                    {{ t(`admin.claudexAnnouncements.status.${item.status}`) }}
                  </span>
                </div>
                <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {{ timing(item) }} · {{ t('admin.claudexAnnouncements.popups.reads', { n: item.reads }) }}
                </p>
              </div>
              <div class="flex flex-shrink-0 items-center gap-2">
                <button type="button" class="btn btn-secondary btn-sm" @click="edit(item)">
                  {{ t('common.edit') }}
                </button>
                <button
                  v-if="item.status === 'published'"
                  type="button"
                  class="btn btn-secondary btn-sm"
                  @click="withdraw(item)"
                >
                  {{ t('admin.claudexAnnouncements.popups.withdraw') }}
                </button>
                <button v-else type="button" class="btn btn-secondary btn-sm" @click="edit(item, true)">
                  {{ t('admin.claudexAnnouncements.popups.publish') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm text-red-600" @click="removing = item">
                  {{ t('common.delete') }}
                </button>
              </div>
            </li>
          </ul>
        </div>

        <div v-else class="grid gap-6 xl:grid-cols-2" data-testid="claudex-announcements-editor">
          <div class="card space-y-5 p-6">
            <div>
              <label class="input-label mb-1.5 block" for="ann-badge">{{ t('admin.claudexAnnouncements.fields.badge') }}</label>
              <input id="ann-badge" v-model="draft.badge" class="input w-full" :maxlength="ANNOUNCEMENT_LIMITS.badge" />
            </div>
            <div>
              <label class="input-label mb-1.5 block" for="ann-title">{{ t('admin.claudexAnnouncements.fields.title') }}</label>
              <input id="ann-title" v-model="draft.title" class="input w-full" :maxlength="ANNOUNCEMENT_LIMITS.title" />
            </div>
            <div>
              <div class="mb-1.5 flex items-center justify-between">
                <label class="input-label" for="ann-body">
                  {{ t(draft.body_format === 'html' ? 'admin.claudexAnnouncements.fields.bodyHtml' : 'admin.claudexAnnouncements.fields.body') }}
                </label>
                <button
                  type="button"
                  class="text-xs font-medium text-primary-600 hover:underline dark:text-primary-400"
                  data-testid="claudex-announcements-format"
                  @click="draft.body_format = draft.body_format === 'html' ? 'text' : 'html'"
                >
                  {{ t(draft.body_format === 'html' ? 'admin.claudexAnnouncements.fields.useTemplate' : 'admin.claudexAnnouncements.fields.useHtml') }}
                </button>
              </div>
              <textarea
                id="ann-body"
                v-model="draft.body_html"
                rows="10"
                :spellcheck="draft.body_format !== 'html'"
                class="input w-full text-sm"
                :class="{ 'font-mono': draft.body_format === 'html' }"
                data-testid="claudex-announcements-body"
              />
              <p class="input-hint mt-1.5">
                {{ t(draft.body_format === 'html' ? 'admin.claudexAnnouncements.fields.bodyHintHtml' : 'admin.claudexAnnouncements.fields.bodyHint') }}
              </p>
            </div>
            <div>
              <label class="input-label mb-1.5 block" for="ann-image">{{ t('admin.claudexAnnouncements.fields.image') }}</label>
              <input id="ann-image" v-model="draft.image_url" type="url" class="input w-full font-mono text-sm" placeholder="https://" />
              <p class="input-hint mt-1.5">{{ t('admin.claudexAnnouncements.fields.imageHint') }}</p>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label class="input-label mb-1.5 block" for="ann-primary">{{ t('admin.claudexAnnouncements.fields.primaryLabel') }}</label>
                <input id="ann-primary" v-model="draft.primary_label" class="input w-full" :maxlength="ANNOUNCEMENT_LIMITS.label" />
              </div>
              <div>
                <label class="input-label mb-1.5 block" for="ann-primary-url">{{ t('admin.claudexAnnouncements.fields.primaryUrl') }}</label>
                <input id="ann-primary-url" v-model="draft.primary_url" type="url" class="input w-full font-mono text-sm" placeholder="https://" />
              </div>
            </div>
            <p class="input-hint -mt-2">{{ t('admin.claudexAnnouncements.fields.primaryUrlHint') }}</p>
            <div v-if="draft.primary_url.trim()">
              <label class="input-label mb-1.5 block" for="ann-dismiss">{{ t('admin.claudexAnnouncements.fields.dismissLabel') }}</label>
              <input
                id="ann-dismiss"
                v-model="draft.dismiss_label"
                class="input w-full"
                :maxlength="ANNOUNCEMENT_LIMITS.label"
                :placeholder="t('admin.claudexAnnouncements.preview.dismissDefault')"
              />
            </div>
            <label v-if="editing.id && editing.status === 'published'" class="flex items-center gap-2 text-sm">
              <input v-model="resetReads" type="checkbox" class="h-4 w-4" />
              {{ t('admin.claudexAnnouncements.fields.resetReads') }}
            </label>
            <p v-if="formError" class="input-error-text" role="alert" data-testid="claudex-announcements-error">{{ formError }}</p>

            <div class="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-5 dark:border-dark-700">
              <button type="button" class="btn btn-secondary" @click="closeEditor">{{ t('common.cancel') }}</button>
              <div class="flex flex-wrap items-center gap-2">
                <button type="button" class="btn btn-secondary" :disabled="busy" data-testid="claudex-announcements-save" @click="save()">
                  {{ t('common.save') }}
                </button>
                <select v-model.number="hours" class="input w-40" :aria-label="t('admin.claudexAnnouncements.publish.duration')">
                  <option v-for="option in durations" :key="option.hours" :value="option.hours">
                    {{ t(`admin.claudexAnnouncements.durations.${option.key}`) }}
                  </option>
                </select>
                <button type="button" class="btn btn-primary" :disabled="busy" data-testid="claudex-announcements-publish" @click="saveAndPublish">
                  {{ editing.status === 'published' ? t('admin.claudexAnnouncements.publish.extend') : t('admin.claudexAnnouncements.popups.publish') }}
                </button>
              </div>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexAnnouncements.preview.title') }}</h3>
              <div class="flex gap-1 rounded-lg bg-gray-100 p-0.5 text-xs dark:bg-dark-700">
                <button
                  v-for="mode in [false, true]"
                  :key="String(mode)"
                  type="button"
                  class="rounded-md px-3 py-1"
                  :class="previewDark === mode ? 'bg-white shadow-sm dark:bg-dark-500' : 'text-gray-500'"
                  @click="previewDark = mode"
                >
                  {{ t(mode ? 'admin.claudexAnnouncements.preview.dark' : 'admin.claudexAnnouncements.preview.light') }}
                </button>
              </div>
            </div>
            <AnnouncementPreview :content="draft" :dark="previewDark" />
            <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('admin.claudexAnnouncements.preview.note') }}</p>
          </div>
        </div>
      </div>

      <!-- E-mail -->
      <div v-else class="grid gap-6 xl:grid-cols-2" data-testid="claudex-announcements-mail">
        <div class="space-y-6">
          <div
            v-if="!mailReady"
            role="alert"
            class="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300"
            data-testid="claudex-announcements-mail-off"
          >
            <Icon name="exclamationTriangle" size="sm" class="mt-0.5 flex-shrink-0" />
            <span>{{ t('admin.claudexAnnouncements.mail.off') }}</span>
          </div>

          <div class="card space-y-5 p-6">
            <div>
              <label class="input-label mb-1.5 block" for="mail-subject">{{ t('admin.claudexAnnouncements.mail.subject') }}</label>
              <input id="mail-subject" v-model="mail.subject" class="input w-full" :maxlength="ANNOUNCEMENT_LIMITS.mailSubject" />
            </div>
            <div>
              <label class="input-label mb-1.5 block" for="mail-body">{{ t('admin.claudexAnnouncements.mail.body') }}</label>
              <textarea id="mail-body" v-model="mail.body_html" rows="12" spellcheck="false" class="input w-full font-mono text-sm" />
              <p class="input-hint mt-1.5">{{ t('admin.claudexAnnouncements.mail.bodyHint') }}</p>
            </div>

            <div>
              <label class="input-label mb-1.5 block" for="mail-search">{{ t('admin.claudexAnnouncements.mail.recipients') }}</label>
              <div class="relative">
                <input
                  id="mail-search"
                  v-model="query"
                  class="input w-full"
                  autocomplete="off"
                  :placeholder="t('admin.claudexAnnouncements.mail.searchPlaceholder')"
                  data-testid="claudex-announcements-search"
                  @input="searchSoon"
                />
                <ul
                  v-if="results.length"
                  class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-dark-600 dark:bg-dark-800"
                >
                  <li v-for="user in results" :key="user.id">
                    <button
                      type="button"
                      class="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-dark-700"
                      @click="addRecipient(user)"
                    >
                      <span class="truncate">{{ user.email }}</span>
                      <span class="ml-3 text-xs text-gray-400">#{{ user.id }}</span>
                    </button>
                  </li>
                </ul>
              </div>
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <span
                  v-for="user in recipients"
                  :key="user.id"
                  class="inline-flex items-center gap-1 rounded-full bg-gray-100 py-1 pl-3 pr-1.5 text-xs dark:bg-dark-700"
                  data-testid="claudex-announcements-recipient"
                >
                  {{ user.email }}
                  <button type="button" class="grid h-4 w-4 place-items-center rounded-full hover:bg-gray-300 dark:hover:bg-dark-500" :aria-label="t('common.remove')" @click="removeRecipient(user.id)">×</button>
                </span>
                <button type="button" class="btn btn-ghost btn-sm" :disabled="addingAll" @click="addAllActive">
                  {{ addingAll ? t('common.loading') : t('admin.claudexAnnouncements.mail.addAll') }}
                </button>
                <button v-if="recipients.length" type="button" class="btn btn-ghost btn-sm" @click="recipients = []">
                  {{ t('admin.claudexAnnouncements.mail.clear') }}
                </button>
              </div>
              <p class="input-hint mt-2">
                {{ t('admin.claudexAnnouncements.mail.count', { n: recipients.length, max: ANNOUNCEMENT_LIMITS.recipients }) }}
              </p>
            </div>

            <p v-if="mailError" class="input-error-text" role="alert">{{ mailError }}</p>
            <div class="flex justify-end border-t border-gray-100 pt-5 dark:border-dark-700">
              <button type="button" class="btn btn-primary" :disabled="!canSend" data-testid="claudex-announcements-send" @click="confirmSend = true">
                {{ t('admin.claudexAnnouncements.mail.send') }}
              </button>
            </div>
          </div>

          <div class="card">
            <div class="flex items-center justify-between border-b border-gray-100 px-6 py-4 dark:border-dark-700">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexAnnouncements.mail.history') }}</h3>
              <button type="button" class="btn btn-ghost btn-sm" @click="loadMails">{{ t('common.refresh') }}</button>
            </div>
            <p v-if="!mails.length" class="px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexAnnouncements.mail.none') }}
            </p>
            <ul v-else class="divide-y divide-gray-100 dark:divide-dark-700">
              <li v-for="send in mails" :key="send.id" class="px-6 py-3 text-sm" data-testid="claudex-announcements-mail-row">
                <div class="flex items-center justify-between gap-3">
                  <span class="truncate font-medium text-gray-900 dark:text-white">{{ send.subject }}</span>
                  <span class="flex-shrink-0 text-xs text-gray-500">{{ formatDate(send.created_at) }}</span>
                </div>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {{ t(`admin.claudexAnnouncements.mail.state.${send.status}`) }} ·
                  {{ t('admin.claudexAnnouncements.mail.progress', { sent: send.sent, failed: send.failed, total: send.recipients }) }}
                </p>
              </li>
            </ul>
          </div>
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('admin.claudexAnnouncements.preview.title') }}</h3>
            <div class="flex gap-1 rounded-lg bg-gray-100 p-0.5 text-xs dark:bg-dark-700">
              <button
                v-for="mode in [false, true]"
                :key="String(mode)"
                type="button"
                class="rounded-md px-3 py-1"
                :class="previewDark === mode ? 'bg-white shadow-sm dark:bg-dark-500' : 'text-gray-500'"
                @click="previewDark = mode"
              >
                {{ t(mode ? 'admin.claudexAnnouncements.preview.dark' : 'admin.claudexAnnouncements.preview.light') }}
              </button>
            </div>
          </div>
          <div class="overflow-hidden rounded-xl border border-gray-200 dark:border-dark-700">
            <div class="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm dark:border-dark-700 dark:bg-dark-800">
              <span class="text-gray-500">{{ t('admin.claudexAnnouncements.mail.subject') }}:</span>
              {{ mail.subject || '—' }}
            </div>
            <iframe
              sandbox=""
              :srcdoc="mailDocument"
              class="h-[32rem] w-full border-0"
              :class="previewDark ? 'bg-[#20201f]' : 'bg-white'"
              :title="t('admin.claudexAnnouncements.preview.frame')"
              data-testid="claudex-announcements-mail-preview"
            />
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('admin.claudexAnnouncements.mail.previewNote') }}</p>
        </div>
      </div>
    </template>

    <ConfirmDialog
      :show="removing !== null"
      :title="t('admin.claudexAnnouncements.popups.deleteTitle')"
      :message="t('admin.claudexAnnouncements.popups.deleteMessage')"
      :confirm-text="t('common.delete')"
      danger
      @confirm="removeConfirmed"
      @cancel="removing = null"
    />
    <ConfirmDialog
      :show="confirmSend"
      :title="t('admin.claudexAnnouncements.mail.confirmTitle')"
      :message="t('admin.claudexAnnouncements.mail.confirmMessage', { n: recipients.length })"
      :confirm-text="t('admin.claudexAnnouncements.mail.send')"
      @confirm="send"
      @cancel="confirmSend = false"
    />
    <TotpStepUpDialog :controller="stepUp" />
  </ClaudexPageShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import ClaudexUnavailable from '@/components/admin/claudex/common/ClaudexUnavailable.vue'
import AnnouncementPreview from '@/components/admin/claudex/announcements/AnnouncementPreview.vue'
import { announcementDocument } from '@/components/admin/claudex/announcements/announcementDocument'
import { claudexErrorMessage } from '@/components/admin/claudex/common/errors'
import { isMissingEndpoint, runWithStepUp } from '@/components/admin/claudex/general/pageSupport'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import Icon from '@/components/icons/Icon.vue'
import {
  ANNOUNCEMENT_LIMITS,
  createAnnouncement,
  deleteAnnouncement,
  emptyContent,
  listAnnouncements,
  listMails,
  publishAnnouncement,
  sendMail,
  updateAnnouncement,
  withdrawAnnouncement,
  type Announcement,
  type AnnouncementContent,
  type MailSend
} from '@/api/admin/claudex/announcements'
import { adminAPI } from '@/api/admin'
import { useAppStore } from '@/stores/app'
import { isStepUpCancelled, useStepUp } from '@/composables/useStepUp'

const PAGE = 'claudexAnnouncements'
const { t, te } = useI18n()
const appStore = useAppStore()
const stepUp = useStepUp()

const loading = ref(false)
const loaded = ref(false)
const loadError = ref<string | null>(null)
const unavailable = ref(false)
const tab = ref<'popups' | 'mail'>('popups')
const previewDark = ref(false)
const busy = ref(false)

const items = ref<Announcement[]>([])
const mailReady = ref(false)
const mails = ref<MailSend[]>([])

const editing = ref<Announcement | { id: 0; status: 'draft' } | null>(null)
const draft = ref<AnnouncementContent>(emptyContent())
const resetReads = ref(false)
const formError = ref('')
const removing = ref<Announcement | null>(null)
const hours = ref(168)
const durations = [
  { key: 'day', hours: 24 },
  { key: 'threeDays', hours: 72 },
  { key: 'week', hours: 168 },
  { key: 'twoWeeks', hours: 336 },
  { key: 'month', hours: 720 }
]

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const statusClass = (status: string) =>
  ({
    published: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    draft: 'bg-gray-100 text-gray-600 dark:bg-dark-700 dark:text-gray-300',
    withdrawn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    expired: 'bg-gray-100 text-gray-500 dark:bg-dark-700 dark:text-gray-400'
  })[status] ?? ''

function timing(item: Announcement): string {
  if (item.status === 'published') return t('admin.claudexAnnouncements.popups.until', { date: formatDate(item.expires_at) })
  if (item.status === 'expired') return t('admin.claudexAnnouncements.popups.endedOn', { date: formatDate(item.expires_at) })
  return t('admin.claudexAnnouncements.popups.updatedOn', { date: formatDate(item.updated_at) })
}

function problem(err: unknown, fallback: string): string {
  return claudexErrorMessage(err, t, te, PAGE, fallback)
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [list, sent] = await Promise.all([listAnnouncements(), listMails()])
    items.value = list.items
    mailReady.value = list.mail_ready
    mails.value = sent.items
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

async function loadList() {
  try {
    const list = await listAnnouncements()
    items.value = list.items
    mailReady.value = list.mail_ready
  } catch {
    /* the list keeps what it had */
  }
}

// ---- pop-ups ----

function startNew() {
  editing.value = { id: 0, status: 'draft' }
  draft.value = emptyContent()
  resetReads.value = false
  formError.value = ''
  hours.value = 168
}

function edit(item: Announcement, toPublish = false) {
  editing.value = item
  draft.value = {
    title: item.title,
    badge: item.badge,
    body_html: item.body_html,
    body_format: item.body_format,
    image_url: item.image_url,
    primary_label: item.primary_label,
    primary_url: item.primary_url,
    dismiss_label: item.dismiss_label
  }
  resetReads.value = false
  formError.value = ''
  if (toPublish) hours.value = 168
}

function closeEditor() {
  editing.value = null
  void loadList()
}

/** Saves the draft; the announcement it became (created or updated), or null when it failed. */
async function save(quiet = false): Promise<Announcement | null> {
  if (!editing.value) return null
  busy.value = true
  formError.value = ''
  try {
    const saved = editing.value.id
      ? await updateAnnouncement(editing.value.id, draft.value, resetReads.value)
      : await createAnnouncement(draft.value)
    editing.value = saved
    resetReads.value = false
    if (!quiet) appStore.showSuccess(t('admin.claudexAnnouncements.toasts.saved'))
    return saved
  } catch (err) {
    formError.value = problem(err, t('admin.claudex.common.saveFailed'))
    return null
  } finally {
    busy.value = false
  }
}

async function saveAndPublish() {
  const saved = await save(true)
  if (!saved) return
  busy.value = true
  try {
    const published = await runWithStepUp(stepUp, () => publishAnnouncement(saved.id, hours.value), t)
    editing.value = published
    appStore.showSuccess(t('admin.claudexAnnouncements.toasts.published'))
    closeEditor()
  } catch (err) {
    if (!isStepUpCancelled(err)) formError.value = problem(err, t('admin.claudexAnnouncements.toasts.actionFailed'))
  } finally {
    busy.value = false
  }
}

async function withdraw(item: Announcement) {
  try {
    await withdrawAnnouncement(item.id)
    appStore.showSuccess(t('admin.claudexAnnouncements.toasts.withdrawn'))
  } catch (err) {
    appStore.showError(problem(err, t('admin.claudexAnnouncements.toasts.actionFailed')))
  }
  void loadList()
}

async function removeConfirmed() {
  const item = removing.value
  removing.value = null
  if (!item) return
  try {
    await deleteAnnouncement(item.id)
    appStore.showSuccess(t('admin.claudexAnnouncements.toasts.deleted'))
  } catch (err) {
    appStore.showError(problem(err, t('admin.claudexAnnouncements.toasts.actionFailed')))
  }
  void loadList()
}

// ---- e-mail ----

interface Recipient {
  id: number
  email: string
}
const mail = ref({ subject: '', body_html: '' })
const query = ref('')
const results = ref<Recipient[]>([])
const recipients = ref<Recipient[]>([])
const mailError = ref('')
const confirmSend = ref(false)
const addingAll = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let progressTimer: ReturnType<typeof setInterval> | undefined

const mailDocument = computed(() => announcementDocument(mail.value.body_html, previewDark.value))
const canSend = computed(
  () =>
    mailReady.value &&
    mail.value.subject.trim() !== '' &&
    mail.value.body_html.trim() !== '' &&
    recipients.value.length > 0 &&
    recipients.value.length <= ANNOUNCEMENT_LIMITS.recipients
)

function searchSoon() {
  clearTimeout(searchTimer)
  const text = query.value.trim()
  if (text.length < 2) {
    results.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    try {
      const page = await adminAPI.users.list(1, 8, { search: text, status: 'active' })
      results.value = page.items
        .filter((user) => !recipients.value.some((chosen) => chosen.id === user.id))
        .map((user) => ({ id: user.id, email: user.email }))
    } catch {
      results.value = []
    }
  }, 250)
}

function addRecipient(user: Recipient) {
  if (recipients.value.length >= ANNOUNCEMENT_LIMITS.recipients) {
    mailError.value = t('admin.claudexAnnouncements.mail.tooMany', { max: ANNOUNCEMENT_LIMITS.recipients })
    return
  }
  mailError.value = ''
  if (!recipients.value.some((chosen) => chosen.id === user.id)) recipients.value = [...recipients.value, user]
  results.value = []
  query.value = ''
}

function removeRecipient(id: number) {
  recipients.value = recipients.value.filter((user) => user.id !== id)
}

async function addAllActive() {
  addingAll.value = true
  mailError.value = ''
  try {
    const chosen = new Map(recipients.value.map((user) => [user.id, user]))
    for (let page = 1; chosen.size <= ANNOUNCEMENT_LIMITS.recipients; page++) {
      const result = await adminAPI.users.list(page, 100, { status: 'active' })
      for (const user of result.items) chosen.set(user.id, { id: user.id, email: user.email })
      if (page >= result.pages) break
    }
    if (chosen.size > ANNOUNCEMENT_LIMITS.recipients) {
      mailError.value = t('admin.claudexAnnouncements.mail.tooMany', { max: ANNOUNCEMENT_LIMITS.recipients })
      return
    }
    recipients.value = [...chosen.values()]
  } catch (err) {
    mailError.value = problem(err, t('admin.claudexAnnouncements.toasts.actionFailed'))
  } finally {
    addingAll.value = false
  }
}

async function loadMails() {
  try {
    const list = await listMails()
    mails.value = list.items
    mailReady.value = list.mail_ready
  } catch {
    /* keep the list */
  }
}

async function send() {
  confirmSend.value = false
  mailError.value = ''
  try {
    const result = await runWithStepUp(
      stepUp,
      () =>
        sendMail({
          subject: mail.value.subject.trim(),
          body_html: mail.value.body_html,
          user_ids: recipients.value.map((user) => user.id)
        }),
      t
    )
    appStore.showSuccess(t('admin.claudexAnnouncements.toasts.mailQueued', { n: result.recipients }))
    void loadMails()
  } catch (err) {
    if (!isStepUpCancelled(err)) mailError.value = problem(err, t('admin.claudexAnnouncements.toasts.actionFailed'))
  }
}

onMounted(() => {
  void load()
  // A send in progress shows how far it got.
  progressTimer = setInterval(() => {
    if (tab.value === 'mail' && mails.value.some((send) => send.status === 'sending')) void loadMails()
  }, 4000)
})
onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  clearInterval(progressTimer)
})
</script>

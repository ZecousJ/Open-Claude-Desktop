<!--
  CLAUDEX: Preview tab of the client policy page. Asks the server what the
  desktop app would get for a plan, a user and a platform
  (POST /admin/claudex/policy/preview), optionally with the unsaved draft,
  and lists the result read-only.
-->
<template>
  <div class="space-y-5" data-testid="policy-preview">
    <div class="grid gap-4 md:grid-cols-3">
      <div>
        <label class="input-label mb-1.5 block">{{ t('admin.claudexPolicy.preview.plan') }}</label>
        <Select
          :model-value="groupId"
          :options="planOptions"
          searchable
          data-testid="policy-preview-plan"
          @update:model-value="groupId = typeof $event === 'number' ? $event : null"
        />
      </div>
      <div>
        <div v-if="user" class="flex h-full flex-col">
          <span class="input-label mb-1.5 block">{{ t('admin.claudexPolicy.preview.user') }}</span>
          <div
            class="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-dark-600"
          >
            <span class="truncate text-sm text-gray-900 dark:text-white" data-testid="policy-preview-user">
              <span class="text-gray-400">#{{ user.id }}</span> {{ user.email }}
            </span>
            <button type="button" class="btn btn-secondary btn-sm" @click="user = null">
              {{ t('admin.claudexPolicy.preview.userAny') }}
            </button>
          </div>
        </div>
        <PolicyUserPicker v-else :label="t('admin.claudexPolicy.preview.user')" @select="user = $event" />
      </div>
      <div>
        <label :for="platformId" class="input-label mb-1.5 block">{{
          t('admin.claudexPolicy.preview.platform')
        }}</label>
        <select :id="platformId" v-model="platform" class="input w-full" data-testid="policy-preview-platform">
          <option v-for="entry in POLICY_PLATFORMS" :key="entry" :value="entry">
            {{ t(`admin.claudexPolicy.editor.platforms.${entry}`) }}
          </option>
        </select>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-4">
      <label v-if="dirty" class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          v-model="includeDraft"
          type="checkbox"
          class="h-4 w-4 rounded border-gray-300 text-primary-500 focus:ring-primary-500 dark:border-dark-500"
          data-testid="policy-preview-draft"
        />
        {{ t('admin.claudexPolicy.preview.includeDraft') }}
      </label>
      <button type="button" class="btn btn-primary" :disabled="loading" data-testid="policy-preview-run" @click="run">
        <Icon v-if="loading" name="refresh" size="sm" class="mr-2 animate-spin" />
        {{ t('admin.claudexPolicy.preview.run') }}
      </button>
    </div>

    <p v-if="error" role="alert" class="text-sm text-red-600 dark:text-red-400" data-testid="policy-preview-error">
      {{ error }}
    </p>

    <div
      v-if="result"
      class="rounded-lg border border-gray-200 dark:border-dark-600"
      data-testid="policy-preview-result"
    >
      <h3
        class="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900 dark:border-dark-700 dark:text-white"
      >
        {{ t('admin.claudexPolicy.preview.resultTitle') }}
      </h3>
      <dl class="divide-y divide-gray-100 dark:divide-dark-700">
        <div
          v-for="row in rows"
          :key="row.key"
          class="grid gap-1 px-4 py-2 text-sm sm:grid-cols-[16rem_minmax(0,1fr)]"
          :data-testid="`policy-preview-row-${row.key}`"
        >
          <dt class="text-gray-500 dark:text-gray-400">{{ row.label }}</dt>
          <dd class="break-words text-gray-900 dark:text-white">{{ row.value }}</dd>
        </div>
      </dl>
    </div>
    <p v-else-if="!loading && !error" class="text-sm text-gray-500 dark:text-gray-400">
      {{ t('admin.claudexPolicy.preview.empty') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import Select from '@/components/common/Select.vue'
import PolicyUserPicker from './PolicyUserPicker.vue'
import { POLICY_PLATFORMS, type PickedUser } from './policyForm'
import { claudexErrorMessage } from '../common/errors'
import {
  preview,
  type PolicyPlatform,
  type ResolvedPolicy,
  type UpdateClientPolicyRequest
} from '@/api/admin/claudex/policy'

const props = defineProps<{
  groups: Array<{ id: number; name: string }>
  /** The unsaved policy as a PUT body. */
  draft: () => UpdateClientPolicyRequest
  /** The draft differs from the saved policy. */
  dirty: boolean
}>()

const { t, te } = useI18n()
const platformId = `policy-preview-platform-${useId()}`

const groupId = ref<number | null>(null)
const user = ref<PickedUser | null>(null)
const platform = ref<PolicyPlatform>('darwin')
const includeDraft = ref(true)
const loading = ref(false)
const error = ref('')
const result = ref<ResolvedPolicy | null>(null)

watch(
  () => props.dirty,
  (dirty) => {
    if (dirty) includeDraft.value = true
  }
)

const planOptions = computed(() => [
  { value: null, label: t('admin.claudexPolicy.preview.planAuto') },
  ...props.groups.map((group) => ({ value: group.id, label: group.name }))
])

async function run(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const response = await preview({
      group_id: groupId.value,
      user_id: user.value?.id ?? null,
      platform: platform.value,
      draft: props.dirty && includeDraft.value ? props.draft() : null
    })
    result.value = response.policy
  } catch (err) {
    result.value = null
    error.value = claudexErrorMessage(err, t, te, 'claudexPolicy', t('admin.claudexPolicy.preview.failed'))
  } finally {
    loading.value = false
  }
}

function onOff(value: boolean): string {
  return value ? t('admin.claudexPolicy.editor.on') : t('admin.claudexPolicy.editor.off')
}

function linkValue(value: string | null | undefined): string {
  return value || t('admin.claudexPolicy.preview.notSet')
}

function domains(list: string[] | null | undefined, emptyKey: string): string {
  return list && list.length ? list.join(', ') : t(emptyKey)
}

const rows = computed(() => {
  const policy = result.value
  if (!policy) return []
  const group = policy.group_id == null ? null : props.groups.find((entry) => entry.id === policy.group_id)
  const connectors =
    policy.connectors === null
      ? t('admin.claudexPolicy.preview.any')
      : policy.connectors.length === 0
        ? t('admin.claudexPolicy.preview.none')
        : policy.connectors
            .map((rule) =>
              [rule.name, rule.url_prefix, [rule.command, ...(rule.args ?? [])].filter(Boolean).join(' ')]
                .filter(Boolean)
                .join(' · ')
            )
            .join(', ')
  const maxBytes = policy.attachments?.max_bytes
  const types = policy.attachments?.types ?? []
  const links = policy.links ?? ({} as ResolvedPolicy['links'])
  const learnMore = (links.learn_more ?? []).map((link) => `${link.label} (${link.url})`).join(', ')
  const editor = 'admin.claudexPolicy.editor'
  return [
    {
      key: 'group',
      label: t('admin.claudexPolicy.preview.resolvedGroup'),
      value:
        policy.group_id == null
          ? t('admin.claudexPolicy.preview.noGroup')
          : group
            ? `${group.name} (#${policy.group_id})`
            : `#${policy.group_id}`
    },
    {
      key: 'permission_modes',
      label: t(`${editor}.permissionModes`),
      value: (policy.permission_modes ?? []).map((mode) => t(`${editor}.modes.${mode}`)).join(', ')
    },
    {
      key: 'bypass',
      label: t('admin.claudexPolicy.preview.bypass'),
      value: t('admin.claudexPolicy.preview.bypassValue')
    },
    {
      key: 'approvals_always_allow',
      label: t(`${editor}.approvalsAlwaysAllow`),
      value: onOff(policy.approvals_always_allow)
    },
    { key: 'incognito', label: t(`${editor}.incognito`), value: onOff(policy.incognito) },
    { key: 'web_search', label: t(`${editor}.webSearch`), value: onOff(policy.web_search) },
    { key: 'web_search_default', label: t(`${editor}.webSearchDefault`), value: onOff(policy.web_search_default) },
    { key: 'voice', label: t(`${editor}.voice`), value: onOff(policy.voice) },
    { key: 'local_mcp_editing', label: t(`${editor}.localMcpEditing`), value: onOff(policy.local_mcp_editing) },
    { key: 'developer_mode_enabled', label: t(`${editor}.developerModeEnabled`), value: onOff(policy.developer_mode_enabled) },
    { key: 'remote_images', label: t(`${editor}.remoteImages`), value: onOff(policy.remote_images) },
    {
      key: 'remote_image_domains',
      label: t(`${editor}.remoteImageDomains`),
      value: domains(policy.remote_image_domains, 'admin.claudexPolicy.preview.any')
    },
    { key: 'external_links', label: t(`${editor}.externalLinks`), value: onOff(policy.external_links) },
    {
      key: 'trusted_link_domains',
      label: t(`${editor}.trustedLinkDomains`),
      value: domains(policy.trusted_link_domains, 'admin.claudexPolicy.preview.none')
    },
    { key: 'connectors', label: t(`${editor}.connectors`), value: connectors },
    {
      key: 'max_bytes',
      label: t(`${editor}.maxMegabytes`),
      value:
        maxBytes == null
          ? t('admin.claudexPolicy.preview.builtInLimit')
          : `${Math.round((maxBytes / 1048576) * 100) / 100} MB`
    },
    {
      key: 'types',
      label: t(`${editor}.attachmentTypes`),
      value: types.length ? types.join(', ') : t('admin.claudexPolicy.preview.attachmentsOff')
    },
    { key: 'help', label: t(`${editor}.links.help`), value: linkValue(links.help) },
    { key: 'plans', label: t(`${editor}.links.plans`), value: linkValue(links.plans) },
    { key: 'apps', label: t(`${editor}.links.apps`), value: linkValue(links.apps) },
    { key: 'get_more_usage', label: t(`${editor}.links.getMoreUsage`), value: linkValue(links.get_more_usage) },
    { key: 'usage_learn_more', label: t(`${editor}.links.usageLearnMore`), value: linkValue(links.usage_learn_more) },
    { key: 'learn_more', label: t(`${editor}.learnMore`), value: learnMore || t('admin.claudexPolicy.preview.none') },
    { key: 'warn_percent', label: t(`${editor}.warnPercent`), value: `${policy.usage_banner?.warn_percent ?? ''}%` },
    {
      key: 'scheduled_enabled',
      label: t(`${editor}.scheduledEnabled`),
      value: onOff(Boolean(policy.scheduled_tasks?.enabled))
    },
    {
      key: 'scheduled_max',
      label: t(`${editor}.scheduledMax`),
      value:
        policy.scheduled_tasks?.max_tasks == null
          ? t('admin.claudexPolicy.preview.noLimit')
          : t('admin.claudexPolicy.preview.maxTasks', { count: policy.scheduled_tasks.max_tasks })
    },
    {
      key: 'plan_label',
      label: t(`${editor}.planLabel`),
      value: policy.plan_label || t('admin.claudexPolicy.preview.groupName')
    },
    ...round2Rows(policy)
  ]
})

/** Rows of the round-2 blocks; an older server that sends none shows none. */
function round2Rows(policy: ResolvedPolicy): Array<{ key: string; label: string; value: string }> {
  const editor = 'admin.claudexPolicy.editor'
  const preview = 'admin.claudexPolicy.preview'
  const rows: Array<{ key: string; label: string; value: string }> = []
  const memory = policy.memory
  if (memory) {
    rows.push(
      { key: 'memory_enabled', label: t(`${editor}.memoryEnabled`), value: onOff(memory.enabled) },
      { key: 'memory_search_chats', label: t(`${editor}.memorySearchChats`), value: onOff(memory.search_chats) },
      { key: 'memory_generate', label: t(`${editor}.memoryGenerate`), value: onOff(memory.generate) },
      { key: 'memory_default_on', label: t(`${editor}.memoryDefaultOn`), value: onOff(memory.default_on) },
      { key: 'memory_model', label: t(`${editor}.memoryModel`), value: memory.model || t(`${preview}.planDefaultModel`) }
    )
  }
  const research = policy.research
  if (research) {
    rows.push(
      { key: 'research_enabled', label: t(`${editor}.researchEnabled`), value: onOff(research.enabled) },
      { key: 'x_search', label: t(`${editor}.xSearch`), value: onOff(research.x_search) },
      { key: 'max_searches', label: t(`${editor}.maxSearches`), value: String(research.max_searches_per_turn) }
    )
  }
  const browser = policy.browser
  if (browser) {
    rows.push(
      { key: 'browser_enabled', label: t(`${editor}.browserEnabled`), value: onOff(browser.enabled) },
      { key: 'browser_external_sites', label: t(`${editor}.browserExternalSites`), value: onOff(browser.external_sites) },
      { key: 'browser_allow_script', label: t(`${editor}.browserAllowScript`), value: onOff(browser.allow_script) },
      { key: 'browser_dev_servers', label: t(`${editor}.browserDevServers`), value: onOff(browser.dev_servers) },
      {
        key: 'browser_blocked_domains',
        label: t(`${editor}.blockedDomains`),
        value: domains(browser.blocked_domains, `${preview}.none`)
      }
    )
  }
  if (typeof policy.ssh_remote === 'boolean') {
    rows.push({ key: 'ssh_remote', label: t(`${editor}.sshRemote`), value: onOff(policy.ssh_remote) })
  }
  if (typeof policy.workflows === 'boolean') {
    rows.push({ key: 'workflows', label: t(`${editor}.workflows`), value: onOff(policy.workflows) })
  }
  if (typeof policy.workflow_approval_required === 'boolean') {
    rows.push({
      key: 'workflow_approval_required',
      label: t(`${editor}.workflowApprovalRequired`),
      value: onOff(policy.workflow_approval_required)
    })
  }
  if ('codex_runtime_mirror' in policy) {
    rows.push({
      key: 'codex_runtime_mirror',
      label: t(`${editor}.codexRuntimeMirror`),
      value: policy.codex_runtime_mirror || t(`${preview}.npmRegistry`)
    })
  }
  const computerUse = policy.computer_use
  if (computerUse) {
    rows.push(
      { key: 'computer_use_enabled', label: t(`${editor}.computerUseEnabled`), value: onOff(computerUse.enabled) },
      {
        key: 'computer_use_full_control',
        label: t(`${editor}.computerUseFullControl`),
        value: onOff(computerUse.allow_full_control)
      },
      {
        key: 'computer_use_denied_apps',
        label: t(`${editor}.deniedApps`),
        value: computerUse.denied_apps.length ? computerUse.denied_apps.join(', ') : t(`${preview}.none`)
      },
      {
        key: 'computer_use_max_actions',
        label: t(`${editor}.maxActions`),
        value:
          computerUse.max_actions_per_turn == null
            ? t(`${preview}.appLimit`)
            : String(computerUse.max_actions_per_turn)
      }
    )
  }
  return rows
}

defineExpose({ run })
</script>

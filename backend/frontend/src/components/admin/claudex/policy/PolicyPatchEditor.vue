<!--
  CLAUDEX: editor for one client policy patch (the defaults, a plan override
  or a user override). Every item has an "Inherit" checkbox: checked, the item
  is left out of the patch and the control shows what it inherits; unchecked,
  the item starts from the inherited value and is written to the patch.

  There is no Bypass permissions control: Bypass is always up to each user
  (owner decision 3), which the note under the permission modes says.
-->
<template>
  <div class="space-y-6" data-testid="policy-patch-editor" :data-mode="mode">
    <p
      v-if="mode === 'user'"
      class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-dark-600 dark:bg-dark-800 dark:text-gray-300"
      data-testid="policy-user-inherit-note"
    >
      {{ t('admin.claudexPolicy.editor.userInheritNote') }}
    </p>

    <!-- Permissions -->
    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.editor.sections.permissions') }}
      </h3>
      <div class="divide-y divide-gray-100 dark:divide-dark-700">
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.permissionModes')"
          :hint="t('admin.claudexPolicy.editor.permissionModesHint')"
          :inherited="isInherited('permission_modes')"
          :inherit-hint="inheritHint"
          :error="itemError('permission_modes')"
          test-id="policy-item-permission_modes"
          @update:inherited="setInherited('permission_modes', $event)"
        >
          <div class="space-y-3">
            <label class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <Toggle
                :model-value="perPlatform"
                data-testid="policy-per-platform"
                @update:model-value="setPerPlatform"
              />
              {{ t('admin.claudexPolicy.editor.perPlatform') }}
            </label>
            <div v-if="!perPlatform" class="flex flex-wrap gap-x-5 gap-y-2" data-testid="policy-modes-all">
              <label
                v-for="mode in POLICY_MODES"
                :key="mode"
                class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
              >
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-gray-300 text-primary-500 focus:ring-primary-500 dark:border-dark-500"
                  :checked="modeChecked(null, mode)"
                  :data-testid="`policy-mode-${mode}`"
                  @change="toggleMode(null, mode, ($event.target as HTMLInputElement).checked)"
                />
                {{ t(`admin.claudexPolicy.editor.modes.${mode}`) }}
              </label>
            </div>
            <div v-else class="grid gap-4 sm:grid-cols-3" data-testid="policy-modes-platforms">
              <div
                v-for="platform in POLICY_PLATFORMS"
                :key="platform"
                class="rounded-lg border border-gray-200 p-3 dark:border-dark-600"
                :data-testid="`policy-modes-${platform}`"
              >
                <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {{ t(`admin.claudexPolicy.editor.platforms.${platform}`) }}
                </p>
                <div class="space-y-1.5">
                  <label
                    v-for="mode in POLICY_MODES"
                    :key="mode"
                    class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                  >
                    <input
                      type="checkbox"
                      class="h-4 w-4 rounded border-gray-300 text-primary-500 focus:ring-primary-500 dark:border-dark-500"
                      :checked="modeChecked(platform, mode)"
                      :data-testid="`policy-mode-${platform}-${mode}`"
                      @change="toggleMode(platform, mode, ($event.target as HTMLInputElement).checked)"
                    />
                    {{ t(`admin.claudexPolicy.editor.modes.${mode}`) }}
                  </label>
                </div>
                <p v-if="fieldError(`permission_modes.${platform}`)" class="input-error-text mt-1.5">
                  {{ fieldError(`permission_modes.${platform}`) }}
                </p>
              </div>
            </div>
          </div>
        </PolicyItemRow>
        <p class="pb-3 text-xs text-gray-500 dark:text-gray-400" data-testid="policy-bypass-note">
          {{ t('admin.claudexPolicy.editor.bypassNote') }}
        </p>
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.approvalsAlwaysAllow')"
          :hint="t('admin.claudexPolicy.editor.approvalsAlwaysAllowHint')"
          :inherited="isInherited('approvals_always_allow')"
          :inherit-hint="inheritHint"
          test-id="policy-item-approvals_always_allow"
          @update:inherited="setInherited('approvals_always_allow', $event)"
        >
          <template #inline>
            <Toggle
              :model-value="view.approvals_always_allow"
              @update:model-value="setValue('approvals_always_allow', $event)"
            />
          </template>
        </PolicyItemRow>
      </div>
    </section>

    <!-- Features -->
    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.editor.sections.features') }}
      </h3>
      <div class="divide-y divide-gray-100 dark:divide-dark-700">
        <PolicyItemRow
          v-for="item in TOGGLE_ITEMS"
          :key="item.key"
          :label="t(item.label)"
          :hint="t(item.hint)"
          :inherited="isInherited(item.key)"
          :inherit-hint="inheritHint"
          :test-id="`policy-item-${item.key}`"
          @update:inherited="setInherited(item.key, $event)"
        >
          <template #inline>
            <Toggle :model-value="Boolean(view[item.key])" @update:model-value="setValue(item.key, $event)" />
          </template>
        </PolicyItemRow>
        <PolicyItemRow
          v-if="view.remote_images"
          :label="t('admin.claudexPolicy.editor.remoteImageDomains')"
          :hint="t('admin.claudexPolicy.editor.remoteImageDomainsHint')"
          :inherited="isInherited('remote_image_domains')"
          :inherit-hint="inheritHint"
          :error="itemError('remote_image_domains')"
          test-id="policy-item-remote_image_domains"
          @update:inherited="setInherited('remote_image_domains', $event)"
        >
          <TagInput
            :model-value="view.remote_image_domains ?? []"
            :max="POLICY_LIMITS.domains"
            case-insensitive
            :validate="domainProblemKey"
            :placeholder="
              isInherited('remote_image_domains')
                ? t('admin.claudexPolicy.editor.anyDomain')
                : t('admin.claudexPolicy.editor.domainPlaceholder')
            "
            :disabled="isInherited('remote_image_domains')"
            @update:model-value="setDomains('remote_image_domains', $event)"
          />
        </PolicyItemRow>
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.externalLinks')"
          :hint="t('admin.claudexPolicy.editor.externalLinksHint')"
          :inherited="isInherited('external_links')"
          :inherit-hint="inheritHint"
          test-id="policy-item-external_links"
          @update:inherited="setInherited('external_links', $event)"
        >
          <template #inline>
            <Toggle :model-value="view.external_links" @update:model-value="setValue('external_links', $event)" />
          </template>
        </PolicyItemRow>
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.trustedLinkDomains')"
          :hint="t('admin.claudexPolicy.editor.trustedLinkDomainsHint')"
          :inherited="isInherited('trusted_link_domains')"
          :inherit-hint="inheritHint"
          :error="itemError('trusted_link_domains')"
          test-id="policy-item-trusted_link_domains"
          @update:inherited="setInherited('trusted_link_domains', $event)"
        >
          <TagInput
            :model-value="view.trusted_link_domains"
            :max="POLICY_LIMITS.domains"
            case-insensitive
            :validate="domainProblemKey"
            :placeholder="
              isInherited('trusted_link_domains')
                ? t('admin.claudexPolicy.editor.noDomains')
                : t('admin.claudexPolicy.editor.domainPlaceholder')
            "
            :disabled="isInherited('trusted_link_domains')"
            @update:model-value="setDomains('trusted_link_domains', $event)"
          />
        </PolicyItemRow>
      </div>
    </section>

    <!-- Connectors -->
    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.editor.sections.connectors') }}
      </h3>
      <PolicyItemRow
        :label="t('admin.claudexPolicy.editor.connectors')"
        :hint="t('admin.claudexPolicy.editor.connectorsHint')"
        :inherited="isInherited('connectors')"
        :inherit-hint="inheritHint"
        :error="itemError('connectors')"
        test-id="policy-item-connectors"
        @update:inherited="setInherited('connectors', $event)"
      >
        <div class="space-y-3">
          <div
            class="flex flex-wrap gap-x-5 gap-y-2"
            role="radiogroup"
            :aria-label="t('admin.claudexPolicy.editor.connectors')"
          >
            <label
              v-for="option in CONNECTOR_MODES"
              :key="option.value"
              class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
            >
              <input
                type="radio"
                class="h-4 w-4 border-gray-300 text-primary-500 focus:ring-primary-500 dark:border-dark-500"
                :name="`policy-connectors-${uid}`"
                :value="option.value"
                :checked="connectorsMode === option.value"
                :data-testid="`policy-connectors-${option.value}`"
                @change="setConnectorsMode(option.value)"
              />
              {{ t(option.label) }}
            </label>
          </div>
          <p v-if="connectorsMode === 'none'" class="text-xs text-gray-500 dark:text-gray-400">
            {{ t('admin.claudexPolicy.editor.connectorsNoneNote') }}
          </p>
          <div v-if="connectorsMode === 'only'" class="space-y-2" data-testid="policy-connector-rows">
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexPolicy.editor.connectorRulesHint') }}
            </p>
            <div
              v-for="(row, index) in view.connectors ?? []"
              :key="index"
              class="grid gap-2 rounded-lg border border-gray-200 p-3 dark:border-dark-600 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_auto]"
              data-testid="policy-connector-row"
            >
              <div>
                <label class="input-label mb-1.5 block">{{ t('admin.claudexPolicy.editor.connectorName') }}</label>
                <input
                  v-model="row.name"
                  type="text"
                  class="input w-full font-mono text-sm"
                  :class="{ 'input-error': fieldError(`connectors.${index}.name`) }"
                  autocomplete="off"
                  spellcheck="false"
                  data-testid="policy-connector-name"
                />
                <p v-if="fieldError(`connectors.${index}.name`)" class="input-error-text mt-1">
                  {{ fieldError(`connectors.${index}.name`) }}
                </p>
              </div>
              <UrlInput
                :model-value="row.url_prefix"
                :label="t('admin.claudexPolicy.editor.connectorUrlPrefix')"
                :placeholder="t('admin.claudexPolicy.editor.connectorOptional')"
                :show-error="showErrors"
                :disabled="isInherited('connectors')"
                @update:model-value="row.url_prefix = $event"
              />
              <div>
                <label class="input-label mb-1.5 block">{{ t('admin.claudexPolicy.editor.connectorCommand') }}</label>
                <input
                  v-model="row.command"
                  type="text"
                  class="input w-full font-mono text-sm"
                  :class="{ 'input-error': fieldError(`connectors.${index}.command`) }"
                  :placeholder="t('admin.claudexPolicy.editor.connectorOptional')"
                  autocomplete="off"
                  spellcheck="false"
                  data-testid="policy-connector-command"
                />
                <p v-if="fieldError(`connectors.${index}.command`)" class="input-error-text mt-1">
                  {{ fieldError(`connectors.${index}.command`) }}
                </p>
                <label class="input-label mb-1.5 mt-2 block" :for="`policy-connector-args-${uid}-${index}`">
                  {{ t('admin.claudexPolicy.editor.connectorArgs') }}
                </label>
                <textarea
                  :id="`policy-connector-args-${uid}-${index}`"
                  :value="(row.args ?? []).join('\n')"
                  rows="2"
                  class="input w-full font-mono text-sm"
                  :class="{ 'input-error': argsError(index) }"
                  :placeholder="t('admin.claudexPolicy.editor.connectorArgsPlaceholder')"
                  :disabled="isInherited('connectors')"
                  autocomplete="off"
                  spellcheck="false"
                  data-testid="policy-connector-args"
                  @input="setConnectorArgs(row, ($event.target as HTMLTextAreaElement).value)"
                ></textarea>
                <p v-if="argsError(index)" class="input-error-text mt-1">{{ argsError(index) }}</p>
              </div>
              <div class="flex items-end">
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :aria-label="t('admin.claudexPolicy.editor.removeRow', { index: index + 1 })"
                  data-testid="policy-connector-remove"
                  @click="removeConnector(index)"
                >
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="(view.connectors?.length ?? 0) >= POLICY_LIMITS.connectors"
                data-testid="policy-connector-add"
                @click="addConnector"
              >
                <Icon name="plus" size="sm" class="mr-1" />
                {{ t('admin.claudexPolicy.editor.addConnector') }}
              </button>
              <span class="text-xs text-gray-500 dark:text-gray-400">
                {{
                  t('admin.claudexPolicy.editor.rowCount', {
                    count: view.connectors?.length ?? 0,
                    max: POLICY_LIMITS.connectors
                  })
                }}
              </span>
            </div>
          </div>
        </div>
      </PolicyItemRow>
    </section>

    <!-- Attachments -->
    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.editor.sections.attachments') }}
      </h3>
      <div class="divide-y divide-gray-100 dark:divide-dark-700">
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.maxMegabytes')"
          :hint="t('admin.claudexPolicy.editor.maxMegabytesHint')"
          :inherited="isInherited('attachments.max_megabytes')"
          :inherit-hint="inheritHint"
          :error="itemError('attachments.max_megabytes')"
          test-id="policy-item-attachments.max_megabytes"
          @update:inherited="setInherited('attachments.max_megabytes', $event)"
        >
          <input
            type="number"
            min="0"
            max="20"
            step="0.1"
            class="input w-40"
            :class="{ 'input-error': itemError('attachments.max_megabytes') }"
            :value="view.attachments.max_megabytes ?? ''"
            :placeholder="t('admin.claudexPolicy.editor.maxMegabytesPlaceholder')"
            data-testid="policy-max-megabytes"
            @input="setNumber('attachments.max_megabytes', $event)"
          />
        </PolicyItemRow>
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.attachmentTypes')"
          :inherited="isInherited('attachments.types')"
          :inherit-hint="inheritHint"
          :error="itemError('attachments.types')"
          test-id="policy-item-attachments.types"
          @update:inherited="setInherited('attachments.types', $event)"
        >
          <div class="space-y-2">
            <div class="flex gap-2">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                @click="setValue('attachments.types', [...ATTACHMENT_TYPES])"
              >
                {{ t('admin.claudexPolicy.editor.selectAll') }}
              </button>
              <button type="button" class="btn btn-secondary btn-sm" @click="setValue('attachments.types', [])">
                {{ t('admin.claudexPolicy.editor.clearAll') }}
              </button>
            </div>
            <div class="grid grid-cols-3 gap-x-4 gap-y-1.5 sm:grid-cols-6 lg:grid-cols-9">
              <label
                v-for="type in ATTACHMENT_TYPES"
                :key="type"
                class="inline-flex items-center gap-1.5 font-mono text-xs text-gray-700 dark:text-gray-300"
              >
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 rounded border-gray-300 text-primary-500 focus:ring-primary-500 dark:border-dark-500"
                  :checked="view.attachments.types.includes(type)"
                  :data-testid="`policy-type-${type}`"
                  @change="toggleType(type, ($event.target as HTMLInputElement).checked)"
                />
                {{ type }}
              </label>
            </div>
            <p
              v-if="view.attachments.types.length === 0"
              class="text-xs text-amber-600 dark:text-amber-400"
              data-testid="policy-attachments-off"
            >
              {{ t('admin.claudexPolicy.editor.attachmentsOff') }}
            </p>
          </div>
        </PolicyItemRow>
      </div>
    </section>

    <!-- Links -->
    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.editor.sections.links') }}
      </h3>
      <div class="divide-y divide-gray-100 dark:divide-dark-700">
        <PolicyItemRow
          v-for="link in LINK_ITEMS"
          :key="link.item"
          :label="t(link.label)"
          :hint="linkHint(link.fallback)"
          :inherited="isInherited(link.item)"
          :inherit-hint="inheritHint"
          :test-id="`policy-item-${link.item}`"
          @update:inherited="setInherited(link.item, $event)"
        >
          <UrlInput
            :model-value="view.links[link.key]"
            :placeholder="linkPlaceholder(link.fallback)"
            :show-error="showErrors"
            :disabled="isInherited(link.item)"
            @update:model-value="setValue(link.item, $event)"
          />
        </PolicyItemRow>
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.learnMore')"
          :hint="t('admin.claudexPolicy.editor.learnMoreHint')"
          :inherited="isInherited('links.learn_more')"
          :inherit-hint="inheritHint"
          :error="itemError('links.learn_more')"
          test-id="policy-item-links.learn_more"
          @update:inherited="setInherited('links.learn_more', $event)"
        >
          <div class="space-y-2">
            <p v-if="view.links.learn_more.length === 0" class="text-xs text-gray-500 dark:text-gray-400">
              {{ t('admin.claudexPolicy.editor.noRows') }}
            </p>
            <div
              v-for="(row, index) in view.links.learn_more"
              :key="index"
              class="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
              data-testid="policy-learn-more-row"
            >
              <div>
                <label class="input-label mb-1.5 block">{{ t('admin.claudexPolicy.editor.learnMoreLabel') }}</label>
                <input
                  v-model="row.label"
                  type="text"
                  class="input w-full"
                  :class="{ 'input-error': fieldError(`links.learn_more.${index}.label`) }"
                  data-testid="policy-learn-more-label"
                />
                <p v-if="fieldError(`links.learn_more.${index}.label`)" class="input-error-text mt-1">
                  {{ fieldError(`links.learn_more.${index}.label`) }}
                </p>
              </div>
              <UrlInput
                :model-value="row.url"
                :label="t('admin.claudexPolicy.editor.learnMoreUrl')"
                required
                :show-error="showErrors"
                :disabled="isInherited('links.learn_more')"
                @update:model-value="row.url = $event"
              />
              <div class="flex items-end">
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :aria-label="t('admin.claudexPolicy.editor.removeRow', { index: index + 1 })"
                  data-testid="policy-learn-more-remove"
                  @click="removeLearnMore(index)"
                >
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="view.links.learn_more.length >= POLICY_LIMITS.learnMore"
              data-testid="policy-learn-more-add"
              @click="addLearnMore"
            >
              <Icon name="plus" size="sm" class="mr-1" />
              {{ t('admin.claudexPolicy.editor.addLink') }}
            </button>
          </div>
        </PolicyItemRow>
      </div>
    </section>

    <!-- Usage and scheduled tasks -->
    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.editor.sections.usage') }}
      </h3>
      <PolicyItemRow
        :label="t('admin.claudexPolicy.editor.warnPercent')"
        :hint="t('admin.claudexPolicy.editor.warnPercentHint')"
        :inherited="isInherited('usage_banner.warn_percent')"
        :inherit-hint="inheritHint"
        :error="itemError('usage_banner.warn_percent')"
        test-id="policy-item-usage_banner.warn_percent"
        @update:inherited="setInherited('usage_banner.warn_percent', $event)"
      >
        <input
          type="number"
          min="1"
          max="99"
          step="1"
          class="input w-32"
          :class="{ 'input-error': itemError('usage_banner.warn_percent') }"
          :value="view.usage_banner.warn_percent ?? ''"
          data-testid="policy-warn-percent"
          @input="setNumber('usage_banner.warn_percent', $event)"
        />
      </PolicyItemRow>
    </section>

    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.editor.sections.scheduledTasks') }}
      </h3>
      <div class="divide-y divide-gray-100 dark:divide-dark-700">
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.scheduledEnabled')"
          :hint="t('admin.claudexPolicy.editor.scheduledEnabledHint')"
          :inherited="isInherited('scheduled_tasks.enabled')"
          :inherit-hint="inheritHint"
          test-id="policy-item-scheduled_tasks.enabled"
          @update:inherited="setInherited('scheduled_tasks.enabled', $event)"
        >
          <template #inline>
            <Toggle
              :model-value="view.scheduled_tasks.enabled"
              @update:model-value="setValue('scheduled_tasks.enabled', $event)"
            />
          </template>
        </PolicyItemRow>
        <PolicyItemRow
          :label="t('admin.claudexPolicy.editor.scheduledMax')"
          :hint="t('admin.claudexPolicy.editor.scheduledMaxHint')"
          :inherited="isInherited('scheduled_tasks.max_tasks')"
          :inherit-hint="inheritHint"
          :error="itemError('scheduled_tasks.max_tasks')"
          test-id="policy-item-scheduled_tasks.max_tasks"
          @update:inherited="setInherited('scheduled_tasks.max_tasks', $event)"
        >
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            class="input w-32"
            :class="{ 'input-error': itemError('scheduled_tasks.max_tasks') }"
            :value="view.scheduled_tasks.max_tasks ?? ''"
            :placeholder="t('admin.claudexPolicy.editor.scheduledMaxPlaceholder')"
            data-testid="policy-max-tasks"
            @input="setNumber('scheduled_tasks.max_tasks', $event)"
          />
        </PolicyItemRow>
      </div>
    </section>

    <!-- Round 2: memory, Research, browser tools, SSH, computer use -->
    <section v-for="block in BLOCKS" :key="block.key" :data-testid="`policy-section-${block.key}`">
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t(`admin.claudexPolicy.editor.sections.${block.key}`) }}
      </h3>
      <p
        v-if="block.key === 'research' && !view.web_search"
        class="pb-2 text-xs text-amber-600 dark:text-amber-400"
        data-testid="policy-research-needs-web-search"
      >
        {{ t('admin.claudexPolicy.editor.researchNeedsWebSearch') }}
      </p>
      <p
        v-if="block.key === 'computerUse' && view.computer_use.enabled"
        class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300"
        data-testid="policy-computer-use-warning"
      >
        {{ t('admin.claudexPolicy.editor.computerUseWarning') }}
      </p>
      <div class="divide-y divide-gray-100 dark:divide-dark-700">
        <PolicyItemRow
          v-for="row in block.toggles"
          :key="row.item"
          :label="t(`admin.claudexPolicy.editor.${row.label}`)"
          :hint="t(`admin.claudexPolicy.editor.${row.label}Hint`)"
          :inherited="isInherited(row.item)"
          :inherit-hint="inheritHint"
          :test-id="`policy-item-${row.item}`"
          @update:inherited="setInherited(row.item, $event)"
        >
          <template #inline>
            <Toggle :model-value="Boolean(getItem(view, row.item))" @update:model-value="setValue(row.item, $event)" />
          </template>
        </PolicyItemRow>

        <PolicyItemRow
          v-if="block.key === 'memory'"
          :label="t('admin.claudexPolicy.editor.memoryModel')"
          :hint="t('admin.claudexPolicy.editor.memoryModelHint')"
          :inherited="isInherited('memory.model')"
          :inherit-hint="inheritHint"
          :error="itemError('memory.model')"
          test-id="policy-item-memory.model"
          @update:inherited="setInherited('memory.model', $event)"
        >
          <input
            type="text"
            class="input w-full max-w-sm font-mono text-sm"
            :class="{ 'input-error': itemError('memory.model') }"
            :value="view.memory.model ?? ''"
            :placeholder="t('admin.claudexPolicy.editor.memoryModelPlaceholder')"
            :disabled="isInherited('memory.model')"
            autocomplete="off"
            spellcheck="false"
            data-testid="policy-memory-model"
            @input="setText('memory.model', ($event.target as HTMLInputElement).value)"
          />
        </PolicyItemRow>

        <PolicyItemRow
          v-if="block.key === 'research'"
          :label="t('admin.claudexPolicy.editor.maxSearches')"
          :hint="t('admin.claudexPolicy.editor.maxSearchesHint')"
          :inherited="isInherited('research.max_searches_per_turn')"
          :inherit-hint="inheritHint"
          :error="itemError('research.max_searches_per_turn')"
          test-id="policy-item-research.max_searches_per_turn"
          @update:inherited="setInherited('research.max_searches_per_turn', $event)"
        >
          <input
            type="number"
            :min="POLICY_LIMITS.maxSearchesMin"
            :max="POLICY_LIMITS.maxSearchesMax"
            step="1"
            class="input w-32"
            :class="{ 'input-error': itemError('research.max_searches_per_turn') }"
            :value="view.research.max_searches_per_turn ?? ''"
            :disabled="isInherited('research.max_searches_per_turn')"
            data-testid="policy-max-searches"
            @input="setNumber('research.max_searches_per_turn', $event)"
          />
        </PolicyItemRow>

        <PolicyItemRow
          v-if="block.key === 'browser'"
          :label="t('admin.claudexPolicy.editor.blockedDomains')"
          :hint="t('admin.claudexPolicy.editor.blockedDomainsHint')"
          :inherited="isInherited('browser.blocked_domains')"
          :inherit-hint="inheritHint"
          :error="itemError('browser.blocked_domains')"
          test-id="policy-item-browser.blocked_domains"
          @update:inherited="setInherited('browser.blocked_domains', $event)"
        >
          <div class="space-y-1.5">
            <TagInput
              :model-value="view.browser.blocked_domains"
              :max="POLICY_LIMITS.blockedDomains"
              case-insensitive
              :validate="domainProblemKey"
              :placeholder="
                isInherited('browser.blocked_domains')
                  ? t('admin.claudexPolicy.editor.noDomains')
                  : t('admin.claudexPolicy.editor.blockedDomainPlaceholder')
              "
              :disabled="isInherited('browser.blocked_domains')"
              @update:model-value="setDomains('browser.blocked_domains', $event)"
            />
            <p
              v-if="!isInherited('browser.blocked_domains') && inheritedList('browser.blocked_domains').length"
              class="text-xs text-gray-500 dark:text-gray-400"
              data-testid="policy-inherited-blocked-domains"
            >
              {{ t('admin.claudexPolicy.editor.alsoBlocked', { list: inheritedList('browser.blocked_domains').join(', ') }) }}
            </p>
          </div>
        </PolicyItemRow>

        <PolicyItemRow
          v-if="block.key === 'ssh'"
          :label="t('admin.claudexPolicy.editor.codexRuntimeMirror')"
          :hint="t('admin.claudexPolicy.editor.codexRuntimeMirrorHint')"
          :inherited="isInherited('codex_runtime_mirror')"
          :inherit-hint="inheritHint"
          test-id="policy-item-codex_runtime_mirror"
          @update:inherited="setInherited('codex_runtime_mirror', $event)"
        >
          <UrlInput
            :model-value="view.codex_runtime_mirror"
            :placeholder="t('admin.claudexPolicy.editor.codexRuntimeMirrorPlaceholder')"
            :show-error="showErrors"
            :disabled="isInherited('codex_runtime_mirror')"
            @update:model-value="setValue('codex_runtime_mirror', $event)"
          />
        </PolicyItemRow>

        <template v-if="block.key === 'computerUse'">
          <PolicyItemRow
            :label="t('admin.claudexPolicy.editor.deniedApps')"
            :hint="t('admin.claudexPolicy.editor.deniedAppsHint')"
            :inherited="isInherited('computer_use.denied_apps')"
            :inherit-hint="inheritHint"
            :error="itemError('computer_use.denied_apps')"
            test-id="policy-item-computer_use.denied_apps"
            @update:inherited="setInherited('computer_use.denied_apps', $event)"
          >
            <div class="space-y-1.5">
              <TagInput
                :model-value="view.computer_use.denied_apps"
                :max="POLICY_LIMITS.deniedApps"
                case-insensitive
                :validate="appProblemKey"
                :placeholder="
                  isInherited('computer_use.denied_apps')
                    ? t('admin.claudexPolicy.editor.noApps')
                    : t('admin.claudexPolicy.editor.deniedAppPlaceholder')
                "
                :disabled="isInherited('computer_use.denied_apps')"
                @update:model-value="setApps($event)"
              />
              <p
                v-if="!isInherited('computer_use.denied_apps') && inheritedList('computer_use.denied_apps').length"
                class="text-xs text-gray-500 dark:text-gray-400"
                data-testid="policy-inherited-denied-apps"
              >
                {{ t('admin.claudexPolicy.editor.alsoDenied', { list: inheritedList('computer_use.denied_apps').join(', ') }) }}
              </p>
            </div>
          </PolicyItemRow>
          <PolicyItemRow
            :label="t('admin.claudexPolicy.editor.maxActions')"
            :hint="t('admin.claudexPolicy.editor.maxActionsHint')"
            :inherited="isInherited('computer_use.max_actions_per_turn')"
            :inherit-hint="inheritHint"
            :error="itemError('computer_use.max_actions_per_turn')"
            test-id="policy-item-computer_use.max_actions_per_turn"
            @update:inherited="setInherited('computer_use.max_actions_per_turn', $event)"
          >
            <input
              type="number"
              :min="POLICY_LIMITS.maxActionsMin"
              :max="POLICY_LIMITS.maxActionsMax"
              step="1"
              class="input w-32"
              :class="{ 'input-error': itemError('computer_use.max_actions_per_turn') }"
              :value="view.computer_use.max_actions_per_turn ?? ''"
              :placeholder="t('admin.claudexPolicy.editor.maxActionsPlaceholder')"
              :disabled="isInherited('computer_use.max_actions_per_turn')"
              data-testid="policy-max-actions"
              @input="setNumber('computer_use.max_actions_per_turn', $event)"
            />
          </PolicyItemRow>
        </template>
      </div>
    </section>

    <!-- Plan label (plan overrides; shown elsewhere only when a stored patch already sets it) -->
    <section v-if="showPlanLabel">
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {{ t('admin.claudexPolicy.editor.sections.plan') }}
      </h3>
      <PolicyItemRow
        :label="t('admin.claudexPolicy.editor.planLabel')"
        :hint="t('admin.claudexPolicy.editor.planLabelHint')"
        :inherited="isInherited('plan_label')"
        :inherit-hint="inheritHint"
        :error="itemError('plan_label')"
        test-id="policy-item-plan_label"
        @update:inherited="setInherited('plan_label', $event)"
      >
        <input
          type="text"
          class="input w-full max-w-xs"
          :class="{ 'input-error': itemError('plan_label') }"
          :value="view.plan_label ?? ''"
          data-testid="policy-plan-label"
          @input="setValue('plan_label', ($event.target as HTMLInputElement).value)"
        />
      </PolicyItemRow>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import Toggle from '@/components/common/Toggle.vue'
import TagInput from '../common/TagInput.vue'
import UrlInput from '../common/UrlInput.vue'
import PolicyItemRow from './PolicyItemRow.vue'
import {
  ATTACHMENT_TYPES,
  POLICY_LIMITS,
  POLICY_MODES,
  POLICY_PLATFORMS,
  applyPatch,
  appProblemKey,
  cleanModes,
  cleanPatch,
  domainProblemKey,
  getItem,
  hasItem,
  itemOfField,
  modesFor,
  removeItem,
  seedValue,
  setItem,
  validatePatch,
  type EditorMode,
  type FullPolicy,
  type PolicyIssue,
  type PolicyItem
} from './policyForm'
import type { ConnectorRule, PolicyMode, PolicyPatch, PolicyPlatform } from '@/api/admin/claudex/policy'

const props = withDefaults(
  defineProps<{
    modelValue: PolicyPatch
    mode: EditorMode
    /** What each item inherits: built-in defaults, or built-in + defaults for overrides. */
    inherited: FullPolicy
    fallbacks?: { doc_url?: string | null; purchase_subscription_url?: string | null } | null
    /** Show every problem, also in fields not visited yet (after a save attempt). */
    showErrors?: boolean
  }>(),
  { fallbacks: null, showErrors: false }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: PolicyPatch): void }>()

const { t } = useI18n()
const uid = useId()

type ToggleKey = 'incognito' | 'web_search' | 'web_search_default' | 'voice' | 'local_mcp_editing' | 'developer_mode_enabled' | 'remote_images'

const TOGGLE_ITEMS: Array<{ key: ToggleKey; label: string; hint: string }> = [
  { key: 'incognito', label: 'admin.claudexPolicy.editor.incognito', hint: 'admin.claudexPolicy.editor.incognitoHint' },
  {
    key: 'web_search',
    label: 'admin.claudexPolicy.editor.webSearch',
    hint: 'admin.claudexPolicy.editor.webSearchHint'
  },
  {
    key: 'web_search_default',
    label: 'admin.claudexPolicy.editor.webSearchDefault',
    hint: 'admin.claudexPolicy.editor.webSearchDefaultHint'
  },
  { key: 'voice', label: 'admin.claudexPolicy.editor.voice', hint: 'admin.claudexPolicy.editor.voiceHint' },
  {
    key: 'local_mcp_editing',
    label: 'admin.claudexPolicy.editor.localMcpEditing',
    hint: 'admin.claudexPolicy.editor.localMcpEditingHint'
  },
  {
    key: 'developer_mode_enabled',
    label: 'admin.claudexPolicy.editor.developerModeEnabled',
    hint: 'admin.claudexPolicy.editor.developerModeEnabledHint'
  },
  {
    key: 'remote_images',
    label: 'admin.claudexPolicy.editor.remoteImages',
    hint: 'admin.claudexPolicy.editor.remoteImagesHint'
  }
]

type LinkKey = 'help' | 'plans' | 'apps' | 'get_more_usage' | 'usage_learn_more'
type LinkFallback = 'doc_url' | 'purchase_subscription_url' | null

const LINK_ITEMS: Array<{ key: LinkKey; item: PolicyItem; label: string; fallback: LinkFallback }> = [
  { key: 'help', item: 'links.help', label: 'admin.claudexPolicy.editor.links.help', fallback: 'doc_url' },
  {
    key: 'plans',
    item: 'links.plans',
    label: 'admin.claudexPolicy.editor.links.plans',
    fallback: 'purchase_subscription_url'
  },
  { key: 'apps', item: 'links.apps', label: 'admin.claudexPolicy.editor.links.apps', fallback: null },
  {
    key: 'get_more_usage',
    item: 'links.get_more_usage',
    label: 'admin.claudexPolicy.editor.links.getMoreUsage',
    fallback: 'purchase_subscription_url'
  },
  {
    key: 'usage_learn_more',
    item: 'links.usage_learn_more',
    label: 'admin.claudexPolicy.editor.links.usageLearnMore',
    fallback: null
  }
]

type BlockKey = 'memory' | 'research' | 'browser' | 'ssh' | 'workflows' | 'computerUse'

/**
 * The round-2 sections: their switches (label keys under editor.*, with a
 * matching *Hint), followed by each section's own controls in the template.
 */
const BLOCKS: Array<{ key: BlockKey; toggles: Array<{ item: PolicyItem; label: string }> }> = [
  {
    key: 'memory',
    toggles: [
      { item: 'memory.enabled', label: 'memoryEnabled' },
      { item: 'memory.search_chats', label: 'memorySearchChats' },
      { item: 'memory.generate', label: 'memoryGenerate' },
      { item: 'memory.default_on', label: 'memoryDefaultOn' }
    ]
  },
  {
    key: 'research',
    toggles: [
      { item: 'research.enabled', label: 'researchEnabled' },
      { item: 'research.x_search', label: 'xSearch' }
    ]
  },
  {
    key: 'browser',
    toggles: [
      { item: 'browser.enabled', label: 'browserEnabled' },
      { item: 'browser.external_sites', label: 'browserExternalSites' },
      { item: 'browser.allow_script', label: 'browserAllowScript' },
      { item: 'browser.dev_servers', label: 'browserDevServers' }
    ]
  },
  { key: 'ssh', toggles: [{ item: 'ssh_remote', label: 'sshRemote' }] },
  {
    key: 'workflows',
    toggles: [
      { item: 'workflows', label: 'workflows' },
      { item: 'workflow_approval_required', label: 'workflowApprovalRequired' }
    ]
  },
  {
    key: 'computerUse',
    toggles: [
      { item: 'computer_use.enabled', label: 'computerUseEnabled' },
      { item: 'computer_use.allow_full_control', label: 'computerUseFullControl' }
    ]
  }
]

type ConnectorsMode = 'any' | 'only' | 'none'
const CONNECTOR_MODES: Array<{ value: ConnectorsMode; label: string }> = [
  { value: 'any', label: 'admin.claudexPolicy.editor.connectorsAny' },
  { value: 'only', label: 'admin.claudexPolicy.editor.connectorsOnly' },
  { value: 'none', label: 'admin.claudexPolicy.editor.connectorsNone' }
]

/** Issues shown by UrlInput itself (it checks https and length on its own). */
const URL_FIELD =
  /^(links\.(help|plans|apps|get_more_usage|usage_learn_more)|links\.learn_more\.\d+\.url|connectors\.\d+\.url_prefix|codex_runtime_mirror)$/

// Local copy of the patch: the editor edits it and emits a copy on change.
const patch = ref<PolicyPatch>(copy(props.modelValue))
let lastSynced = JSON.stringify(patch.value)

function copy(value: PolicyPatch): PolicyPatch {
  return JSON.parse(JSON.stringify(value ?? {})) as PolicyPatch
}

watch(
  () => props.modelValue,
  (value) => {
    const text = JSON.stringify(value ?? {})
    if (text === lastSynced) return
    lastSynced = text
    patch.value = copy(value)
  },
  { deep: true }
)

watch(
  patch,
  (value) => {
    const text = JSON.stringify(value)
    if (text === lastSynced) return
    lastSynced = text
    emit('update:modelValue', copy(value))
  },
  { deep: true }
)

/** The patch laid over what it inherits: what every control shows. */
const view = computed<FullPolicy>(() => applyPatch(props.inherited, patch.value))

const issues = computed<PolicyIssue[]>(() => validatePatch(cleanPatch(patch.value)))

const inheritHint = computed(() =>
  props.mode === 'defaults'
    ? t('admin.claudexPolicy.editor.inheritBuiltinHint')
    : t('admin.claudexPolicy.editor.inheritDefaultsHint')
)

const showPlanLabel = computed(() => props.mode === 'plan' || hasItem(patch.value, 'plan_label'))

function isInherited(item: PolicyItem): boolean {
  return !hasItem(patch.value, item)
}

function setInherited(item: PolicyItem, inherit: boolean): void {
  if (inherit) removeItem(patch.value, item)
  else setItem(patch.value, item, seedValue(props.inherited, item))
}

function setValue(item: PolicyItem, value: unknown): void {
  if (isInherited(item)) return
  setItem(patch.value, item, value)
}

function setNumber(item: PolicyItem, event: Event): void {
  const input = event.target as HTMLInputElement
  const value = input.value.trim() === '' ? null : input.valueAsNumber
  setValue(item, value === null || Number.isNaN(value) ? null : value)
}

function setDomains(
  item: 'remote_image_domains' | 'trusted_link_domains' | 'browser.blocked_domains',
  values: string[]
): void {
  setValue(
    item,
    values.map((value) => value.trim().toLowerCase())
  )
}

/** A text item; an empty box means null (inherit the plan's default, e.g. for the memory model). */
function setText(item: PolicyItem, value: string): void {
  setValue(item, value.trim() === '' ? null : value)
}

function setApps(values: string[]): void {
  setValue(
    'computer_use.denied_apps',
    values.map((value) => value.trim())
  )
}

/** What a deny list inherits: entries the layers below already block (they stay blocked). */
function inheritedList(item: PolicyItem): string[] {
  const value = getItem(props.inherited, item)
  return Array.isArray(value) ? (value as string[]) : []
}

function message(issue: PolicyIssue): string {
  if (issue.field === 'attachments.max_megabytes' && issue.rule === 'out_of_range') {
    return t('admin.claudexPolicy.validation.megabytes')
  }
  return t(`admin.claudexPolicy.validation.${issue.rule}`, issue.params ?? {})
}

/** The message for the first problem of an item (URL problems are shown by UrlInput). */
function itemError(item: PolicyItem): string | null {
  const issue = issues.value.find(
    (entry) =>
      itemOfField(entry.field) === item &&
      !URL_FIELD.test(entry.field) &&
      !/^(connectors|links\.learn_more)\.\d+\./.test(entry.field) &&
      !/^permission_modes\.(darwin|win32|linux)$/.test(entry.field)
  )
  return issue ? message(issue) : null
}

/** The message for a problem of one exact field (a row cell or a platform column). */
function fieldError(field: string): string | null {
  const issue = issues.value.find((entry) => entry.field === field)
  return issue ? message(issue) : null
}

// Permission modes

const perPlatform = computed(() => !Array.isArray(view.value.permission_modes))

function modeChecked(platform: PolicyPlatform | null, mode: PolicyMode): boolean {
  const value = view.value.permission_modes
  const list = platform ? modesFor(value, platform) : cleanModes(value)
  return list.includes(mode)
}

function toggleMode(platform: PolicyPlatform | null, mode: PolicyMode, checked: boolean): void {
  if (isInherited('permission_modes')) return
  const current = JSON.parse(JSON.stringify(patch.value.permission_modes ?? []))
  const update = (list: unknown) => {
    const set = new Set(cleanModes(list))
    if (checked) set.add(mode)
    else set.delete(mode)
    return cleanModes([...set])
  }
  if (platform === null || Array.isArray(current)) {
    patch.value.permission_modes = update(current)
  } else {
    current[platform] = update(modesFor(current, platform))
    patch.value.permission_modes = current
  }
}

function setPerPlatform(on: boolean): void {
  if (isInherited('permission_modes')) return
  const current = patch.value.permission_modes ?? []
  if (on && Array.isArray(current)) {
    const list = cleanModes(current)
    patch.value.permission_modes = { darwin: [...list], win32: [...list], linux: [...list] }
  } else if (!on && !Array.isArray(current)) {
    const lists = POLICY_PLATFORMS.map((platform) => modesFor(current, platform))
    const common = POLICY_MODES.filter((mode) => lists.every((list) => list.includes(mode)))
    patch.value.permission_modes = common.length ? common : [...lists[0]]
  }
}

// Connectors

const connectorsMode = computed<ConnectorsMode>(() => {
  const value = view.value.connectors
  if (value === null) return 'any'
  return value.length ? 'only' : 'none'
})

function emptyConnector(): ConnectorRule {
  return { name: '', url_prefix: '', command: '' }
}

function setConnectorsMode(mode: ConnectorsMode): void {
  if (mode === 'any') setValue('connectors', null)
  else if (mode === 'none') setValue('connectors', [])
  else if (connectorsMode.value !== 'only') setValue('connectors', [emptyConnector()])
}

function addConnector(): void {
  if (isInherited('connectors') || !Array.isArray(patch.value.connectors)) return
  patch.value.connectors.push(emptyConnector())
}

/** One argument per line (a blank line is not an argument). */
function setConnectorArgs(row: ConnectorRule, text: string): void {
  if (isInherited('connectors')) return
  const lines = text.split(/\r?\n/)
  if (lines.every((line) => line === '')) delete row.args
  else row.args = lines
}

function argsError(index: number): string | null {
  const prefix = `connectors.${index}.args`
  const issue = issues.value.find((entry) => entry.field === prefix || entry.field.startsWith(`${prefix}.`))
  return issue ? message(issue) : null
}

function removeConnector(index: number): void {
  if (isInherited('connectors') || !Array.isArray(patch.value.connectors)) return
  patch.value.connectors.splice(index, 1)
}

// Attachments

function toggleType(type: string, checked: boolean): void {
  const list = new Set(view.value.attachments.types)
  if (checked) list.add(type)
  else list.delete(type)
  setValue(
    'attachments.types',
    ATTACHMENT_TYPES.filter((entry) => list.has(entry))
  )
}

// Links

function fallbackUrl(fallback: LinkFallback): string {
  if (!fallback) return ''
  return (props.fallbacks?.[fallback] ?? '').trim()
}

function linkPlaceholder(fallback: LinkFallback): string {
  return fallbackUrl(fallback) || 'https://'
}

function linkHint(fallback: LinkFallback): string {
  const url = fallbackUrl(fallback)
  return url ? t('admin.claudexPolicy.editor.linkFallback', { url }) : t('admin.claudexPolicy.editor.linkHidden')
}

function addLearnMore(): void {
  if (isInherited('links.learn_more')) return
  const list = patch.value.links?.learn_more
  if (Array.isArray(list)) list.push({ label: '', url: '' })
}

function removeLearnMore(index: number): void {
  if (isInherited('links.learn_more')) return
  const list = patch.value.links?.learn_more
  if (Array.isArray(list)) list.splice(index, 1)
}

defineExpose({ issues })
</script>

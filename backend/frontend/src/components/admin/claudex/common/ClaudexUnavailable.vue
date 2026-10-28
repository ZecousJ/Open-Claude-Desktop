<!--
  CLAUDEX: the honest empty state of a Claudex console page whose feature is
  not in this build (no form, no controls that would not work).
-->
<template>
  <div class="card p-6" data-testid="claudex-unavailable">
    <div class="flex items-start gap-3">
      <Icon name="infoCircle" size="md" class="mt-0.5 flex-shrink-0 text-gray-400" />
      <div>
        <p class="text-sm font-medium text-gray-900 dark:text-white">
          {{ t('admin.claudex.common.notAvailable') }}
        </p>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {{ t('admin.claudex.common.notAvailableHint') }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'

const { t } = useI18n()
</script>

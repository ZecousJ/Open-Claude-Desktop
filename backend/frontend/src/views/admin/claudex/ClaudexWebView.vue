<!--
  CLAUDEX: /admin/claudex/web (W-ADMIN1). Manage the Claudex web app without
  touching the database: who may use it (off, administrators, everyone), the
  limits of its runs, and the runners that carry them out (add a runner and
  copy its one-time token, rename, switch off, drain, revoke). Backend:
  internal/claudex/web, web/usage and webhost. Every write goes through
  step-up. Sign-in options (email code, privacy policy) are on the General page.
-->
<template>
  <ClaudexPageShell
    :title="t('admin.claudexWeb.title')"
    :description="t('admin.claudexWeb.description')"
    test-id="claudex-web-page"
  >
    <div class="space-y-6">
      <WebAccessCard :step-up="stepUp" />
      <WebLimitsCard :step-up="stepUp" />
      <WebRunnersCard :step-up="stepUp" :confirm="confirm" />
      <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="claudex-web-signin-note">
        {{ t('admin.claudexWeb.signInNote') }}
        <RouterLink to="/admin/claudex/general" class="text-primary-600 hover:underline dark:text-primary-400">
          {{ t('admin.claudexWeb.signInLink') }}
        </RouterLink>
      </p>
    </div>
  </ClaudexPageShell>

  <ConfirmDialog
    :show="confirm.state.show"
    :title="confirm.state.title"
    :message="confirm.state.message"
    :confirm-text="confirm.state.confirmText || undefined"
    :danger="confirm.state.danger"
    :z-index="55"
    @confirm="confirm.accept"
    @cancel="confirm.cancel"
  />
  <TotpStepUpDialog :controller="stepUp" />
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ClaudexPageShell from '@/components/admin/claudex/common/ClaudexPageShell.vue'
import { useConfirm } from '@/components/admin/claudex/devices/useConfirm'
import WebAccessCard from '@/components/admin/claudex/web/WebAccessCard.vue'
import WebLimitsCard from '@/components/admin/claudex/web/WebLimitsCard.vue'
import WebRunnersCard from '@/components/admin/claudex/web/WebRunnersCard.vue'
import TotpStepUpDialog from '@/components/auth/TotpStepUpDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useStepUp } from '@/composables/useStepUp'

const { t } = useI18n()
const stepUp = useStepUp()
const confirm = useConfirm()
</script>

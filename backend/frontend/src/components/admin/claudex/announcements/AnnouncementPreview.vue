<!--
  CLAUDEX: what an announcement looks like in the Claudex apps: a card with a
  badge, a serif title, the administrator's HTML, and a primary and a
  dismiss button on the left; an optional picture on the right, and a close
  button. Without a picture it is a single narrow column. The HTML is drawn in
  a sandboxed frame, as in the apps.
-->
<template>
  <div class="rounded-xl p-6" :class="dark ? 'bg-neutral-700/60' : 'bg-gray-200'" data-testid="announcement-preview">
    <div
      class="relative mx-auto flex overflow-hidden rounded-3xl shadow-xl"
      :class="[dark ? 'bg-[#20201f] text-[#f0efec]' : 'bg-white text-[#0b0b0b]', image ? 'max-w-3xl' : 'max-w-sm']"
    >
      <div class="flex min-h-[26rem] min-w-0 flex-1 flex-col p-7">
        <span
          v-if="content.badge"
          class="mb-4 inline-block w-fit rounded-md px-2 py-0.5 text-xs font-medium"
          :class="dark ? 'bg-[#0b1f40] text-[#83a3d7]' : 'bg-[#e2ecfa] text-[#1f4f94]'"
          >{{ content.badge }}</span
        >
        <h3 v-if="content.title" class="mb-5 font-serif text-3xl font-medium leading-tight">{{ content.title }}</h3>
        <div v-if="content.body_format !== 'html'" class="min-h-0 w-full flex-1 space-y-3 overflow-auto text-[15px] leading-[22px]">
          <p v-for="(line, index) in lines" :key="index">{{ line }}</p>
        </div>
        <iframe
          v-else-if="content.body_html.trim()"
          :key="dark ? 'dark' : 'light'"
          sandbox=""
          :srcdoc="documentHtml"
          class="min-h-0 w-full flex-1 border-0 bg-transparent"
          :title="t('admin.claudexAnnouncements.preview.frame')"
        />
        <div v-else class="flex-1" />
        <div class="mt-6 space-y-2">
          <button
            type="button"
            class="h-10 w-full rounded-lg text-sm font-medium"
            :class="dark ? 'bg-white text-[#0b0b0b]' : 'bg-[#0b0b0b] text-white'"
          >
            {{ content.primary_url ? content.primary_label || t('admin.claudexAnnouncements.preview.openDefault') : content.primary_label || t('admin.claudexAnnouncements.preview.doneDefault') }}
          </button>
          <button
            v-if="content.primary_url"
            type="button"
            class="h-10 w-full rounded-lg border text-sm"
            :class="dark ? 'border-white/10 text-[#f0efec]' : 'border-black/10 text-[#0b0b0b]'"
          >
            {{ content.dismiss_label || t('admin.claudexAnnouncements.preview.dismissDefault') }}
          </button>
        </div>
      </div>
      <div v-if="image" class="relative hidden w-1/2 flex-shrink-0 sm:block">
        <img :src="image" alt="" class="absolute inset-0 h-full w-full object-cover" referrerpolicy="no-referrer" />
      </div>
      <span
        class="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-lg text-lg leading-none"
        :class="dark ? 'bg-black/40 text-white' : 'bg-white/80 text-[#0b0b0b]'"
        aria-hidden="true"
        >×</span
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnnouncementContent } from '@/api/admin/claudex/announcements'
import { announcementDocument } from './announcementDocument'

const props = defineProps<{ content: AnnouncementContent; dark?: boolean }>()
const { t } = useI18n()
const dark = computed(() => props.dark === true)
const image = computed(() => (/^https?:\/\//.test(props.content.image_url) ? props.content.image_url : ''))
const lines = computed(() => props.content.body_html.split(/\r?\n/).filter((line) => line.trim() !== ''))
const documentHtml = computed(() => announcementDocument(props.content.body_html, dark.value))
</script>

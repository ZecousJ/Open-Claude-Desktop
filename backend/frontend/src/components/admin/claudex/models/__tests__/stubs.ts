// CLAUDEX: light stand-ins for the upstream dialog, select and table used by the K2 specs
// (the real ones teleport to <body> or need a layout).
import { defineComponent, type PropType } from 'vue'

export const BaseDialogStub = defineComponent({
  name: 'BaseDialog',
  props: { show: Boolean, title: { type: String, default: '' } },
  emits: ['close'],
  template: `
    <div v-if="show" data-testid="dialog">
      <h3 data-testid="dialog-title">{{ title }}</h3>
      <button type="button" data-testid="dialog-close" @click="$emit('close')" />
      <slot />
      <slot name="footer" />
    </div>`
})

interface Option {
  value: string | number | boolean | null
  label: string
}

/** A native <select> with the same v-model and change contract as components/common/Select.vue. */
export const SelectStub = defineComponent({
  name: 'SelectStub',
  props: {
    modelValue: { type: [String, Number, Boolean, null] as PropType<Option['value']>, default: null },
    options: { type: Array as PropType<Option[]>, default: () => [] },
    disabled: Boolean
  },
  emits: ['update:modelValue', 'change'],
  methods: {
    onChange(event: Event) {
      const value = (event.target as HTMLSelectElement).value
      const option = this.options.find((o) => String(o.value) === value) ?? null
      this.$emit('update:modelValue', option ? option.value : null)
      this.$emit('change', option ? option.value : null, option)
    }
  },
  template: `
    <select :disabled="disabled" :value="String(modelValue)" @change="onChange">
      <option v-for="o in options" :key="String(o.value)" :value="String(o.value)">{{ o.label }}</option>
    </select>`
})

export const DataTableStub = defineComponent({
  name: 'DataTable',
  props: {
    columns: { type: Array as PropType<Array<{ key: string; label: string }>>, default: () => [] },
    data: { type: Array as PropType<Array<Record<string, unknown>>>, default: () => [] },
    loading: Boolean
  },
  template: `
    <div data-testid="table" :data-loading="loading ? 'true' : 'false'">
      <div v-for="row in data" :key="String(row.id)" data-testid="row" :data-id="row.id">
        <div v-for="c in columns" :key="c.key" :data-col="c.key">
          <slot :name="'cell-' + c.key" :row="row" :value="row[c.key]">{{ row[c.key] }}</slot>
        </div>
      </div>
      <div v-if="!loading && data.length === 0" data-testid="table-empty"><slot name="empty" /></div>
    </div>`
})

export const ConfirmDialogStub = defineComponent({
  name: 'ConfirmDialog',
  props: { show: Boolean, title: { type: String, default: '' }, message: { type: String, default: '' } },
  emits: ['confirm', 'cancel'],
  template: `
    <div v-if="show" data-testid="confirm">
      <p data-testid="confirm-message">{{ message }}</p>
      <button type="button" data-testid="confirm-yes" @click="$emit('confirm')" />
      <button type="button" data-testid="confirm-no" @click="$emit('cancel')" />
    </div>`
})

export const AppLayoutStub = defineComponent({
  name: 'AppLayout',
  template: '<main><slot /></main>'
})

export const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], default: '' } },
  template: '<a :href="String(to)"><slot /></a>'
})

/** t() that shows the key and its parameters, so specs can check both. */
export function fakeT(key: string, params?: Record<string, unknown>): string {
  return params && Object.keys(params).length > 0 ? `${key}${JSON.stringify(params)}` : key
}

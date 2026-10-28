/**
 * CLAUDEX: one confirmation dialog per page, asked from code.
 *
 *   const confirm = useConfirm()
 *   if (!(await confirm.ask({ title, message, confirmText, danger: true }))) return
 *   <ConfirmDialog :show="confirm.state.show" ... @confirm="confirm.accept" @cancel="confirm.cancel" />
 *
 * Every Claudex write that needs step-up on these pages is confirmed first,
 * then sent through useStepUp().run().
 */

import { reactive } from 'vue'

export interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  /** Extra lines shown under the message (e.g. what a save changes). */
  details?: string[]
}

export function useConfirm() {
  const state = reactive({
    show: false,
    title: '',
    message: '',
    confirmText: '',
    danger: false,
    details: [] as string[]
  })
  let resolver: ((ok: boolean) => void) | null = null

  function settle(ok: boolean) {
    state.show = false
    const resolve = resolver
    resolver = null
    resolve?.(ok)
  }

  function ask(options: ConfirmOptions): Promise<boolean> {
    // A new question cancels one still open.
    settle(false)
    state.title = options.title
    state.message = options.message
    state.confirmText = options.confirmText ?? ''
    state.danger = options.danger ?? false
    state.details = options.details ?? []
    state.show = true
    return new Promise<boolean>((resolve) => {
      resolver = resolve
    })
  }

  return {
    state,
    ask,
    accept: () => settle(true),
    cancel: () => settle(false)
  }
}

export type ConfirmController = ReturnType<typeof useConfirm>

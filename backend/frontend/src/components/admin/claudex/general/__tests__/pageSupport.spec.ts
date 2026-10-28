// CLAUDEX: tests for the helpers shared by the K4 console pages.
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { dayBoundary, integerInRange, isMissingEndpoint, runWithStepUp, toInteger, toNumber } from '../pageSupport'
import { StepUpCancelledError, isStepUpCancelled, useStepUp, type StepUpController } from '@/composables/useStepUp'

const t = (key: string) => key

function controller(): StepUpController {
  let api!: StepUpController
  mount(
    defineComponent({
      setup() {
        api = useStepUp()
        return () => h('div')
      }
    })
  )
  return api
}

describe('runWithStepUp', () => {
  it('passes a plain success through', async () => {
    const stepUp = controller()
    await expect(runWithStepUp(stepUp, async () => 7, t)).resolves.toBe(7)
    expect(stepUp.visible.value).toBe(false)
  })

  it('asks for the TOTP code on STEP_UP_REQUIRED and retries once verified', async () => {
    const stepUp = controller()
    const action = vi
      .fn()
      .mockRejectedValueOnce({ status: 403, code: 'STEP_UP_REQUIRED', message: 'step-up required' })
      .mockResolvedValueOnce('saved')
    const pending = runWithStepUp(stepUp, action, t)
    await vi.waitFor(() => expect(stepUp.visible.value).toBe(true))
    stepUp.onVerified()
    await expect(pending).resolves.toBe('saved')
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('keeps a cancelled prompt recognisable as cancelled', async () => {
    const stepUp = controller()
    const pending = runWithStepUp(stepUp, () => Promise.reject({ reason: 'STEP_UP_REQUIRED' }), t)
    await vi.waitFor(() => expect(stepUp.visible.value).toBe(true))
    stepUp.onCancel()
    const err = await pending.catch((e) => e)
    expect(err).toBeInstanceOf(StepUpCancelledError)
    expect(isStepUpCancelled(err)).toBe(true)
  })

  it('explains a step-up that cannot be completed', async () => {
    const stepUp = controller()
    await expect(
      runWithStepUp(stepUp, () => Promise.reject({ status: 403, code: 'STEP_UP_TOTP_NOT_ENABLED' }), t)
    ).rejects.toMatchObject({ message: 'stepUp.notEnabled' })
    await expect(
      runWithStepUp(stepUp, () => Promise.reject({ status: 403, reason: 'STEP_UP_ADMIN_API_KEY_FORBIDDEN' }), t)
    ).rejects.toMatchObject({ message: 'stepUp.adminApiKeyForbidden' })
  })

  it('rethrows other errors unchanged', async () => {
    const stepUp = controller()
    const err = { status: 400, reason: 'CLAUDEX_RELEASE_INVALID', message: 'bad' }
    await expect(runWithStepUp(stepUp, () => Promise.reject(err), t)).rejects.toBe(err)
  })
})

describe('isMissingEndpoint', () => {
  it('is true only for a 404 without a Claudex reason', () => {
    expect(isMissingEndpoint({ status: 404 })).toBe(true)
    expect(isMissingEndpoint({ status: 404, code: 404, message: 'Not Found' })).toBe(true)
    expect(isMissingEndpoint({ status: 404, reason: 'CLAUDEX_FEEDBACK_DISABLED' })).toBe(false)
    expect(isMissingEndpoint({ status: 404, code: 'CLAUDEX_AUDIO_DISABLED' })).toBe(false)
    expect(isMissingEndpoint({ status: 423, code: 'ADMIN_COMPLIANCE_ACK_REQUIRED' })).toBe(false)
    expect(isMissingEndpoint({ status: 500 })).toBe(false)
    expect(isMissingEndpoint(null)).toBe(false)
  })
})

describe('number helpers', () => {
  it('parses number inputs', () => {
    expect(toInteger(5)).toBe(5)
    expect(toInteger('12')).toBe(12)
    expect(toInteger(1.5)).toBeNull()
    expect(toInteger('')).toBeNull()
    expect(toNumber('0.25')).toBe(0.25)
    expect(toNumber('x')).toBeNull()
    expect(integerInRange(1, 1, 365)).toBe(true)
    expect(integerInRange(366, 1, 365)).toBe(false)
    expect(integerInRange(null, 1, 365)).toBe(false)
  })
})

describe('dayBoundary', () => {
  it('turns a local calendar day into RFC 3339 bounds', () => {
    const start = dayBoundary('2026-09-20', 'start')
    const end = dayBoundary('2026-09-20', 'end')
    expect(start).toMatch(/Z$/)
    expect(new Date(start).getTime()).toBe(new Date(2026, 8, 20, 0, 0, 0).getTime())
    // `to` is exclusive on the server, so the end of a day is the next midnight.
    expect(new Date(end).getTime()).toBe(new Date(2026, 8, 21, 0, 0, 0).getTime())
    expect(new Date(dayBoundary('2026-12-31', 'end')).getTime()).toBe(new Date(2027, 0, 1).getTime())
    expect(dayBoundary('', 'start')).toBe('')
    expect(dayBoundary('20-09-2026', 'start')).toBe('')
    expect(dayBoundary('2026-02-30', 'start')).toBe('')
    expect(dayBoundary('2026-13-01', 'end')).toBe('')
  })
})

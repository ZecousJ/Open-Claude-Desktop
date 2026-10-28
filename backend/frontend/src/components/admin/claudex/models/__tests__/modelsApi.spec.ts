// CLAUDEX: requests of the model catalog admin API (api/admin/claudex/models.ts, K2).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn()
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, put, delete: del }
}))

import * as models from '@/api/admin/claudex/models'
import * as claudex from '@/api/admin/claudex'

const body: models.ClaudexModelMetaInput = {
  model_id: 'gpt-5.5',
  group_id: null,
  display_name: 'GPT-5.5',
  description: '',
  badges: [],
  sort_order: 0,
  hidden: false,
  is_default: false,
  supported_efforts: null,
  default_effort: '',
  context_window: null,
  auto_compact_tokens: null,
  fast_tier: null,
  usage_hint: '',
  minimum_desktop_version: ''
}

describe('model catalog admin API', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ data: { items: [], total: 0, page: 1, page_size: 50, pages: 1 } })
    post.mockReset().mockResolvedValue({ data: { ...body, id: 1 } })
    put.mockReset().mockResolvedValue({ data: { ...body, id: 1 } })
    del.mockReset().mockResolvedValue({ data: { deleted: true } })
  })

  it('is reachable through the Claudex admin API (adminAPI.claudex.models)', () => {
    expect(claudex.models.list).toBe(models.list)
    expect(claudex.models.candidates).toBe(models.candidates)
  })

  it.each([
    [undefined, {}],
    ['all' as const, {}],
    ['global' as const, { group_id: 0 }],
    [4, { group_id: 4 }]
  ])('lists scope %j with %j', async (scope, extra) => {
    await models.list({ scope, q: '  gpt ', page: 2, page_size: 20 })
    expect(get).toHaveBeenCalledWith('/admin/claudex/models', {
      params: { ...extra, q: 'gpt', page: 2, page_size: 20 },
      signal: undefined
    })
  })

  it('leaves out an empty search and defaults the page', async () => {
    const controller = new AbortController()
    await models.list({ q: '   ' }, { signal: controller.signal })
    expect(get).toHaveBeenCalledWith('/admin/claudex/models', {
      params: { page: 1, page_size: 50 },
      signal: controller.signal
    })
  })

  it('creates, updates and deletes entries', async () => {
    await models.create(body)
    expect(post).toHaveBeenCalledWith('/admin/claudex/models', body)
    await models.update(9, body)
    expect(put).toHaveBeenCalledWith('/admin/claudex/models/9', body)
    await expect(models.remove(9)).resolves.toEqual({ deleted: true })
    expect(del).toHaveBeenCalledWith('/admin/claudex/models/9')
  })

  it('asks for candidates of a group, or of every group for the global scope', async () => {
    get.mockResolvedValue({ data: { models: ['gpt-5.5'], sources: { 'gpt-5.5': ['allowlist', 'channel_pricing'] } } })
    await expect(models.candidates(4)).resolves.toEqual({
      models: ['gpt-5.5'],
      sources: { 'gpt-5.5': ['allowlist', 'channel_pricing'] }
    })
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/models/candidates', {
      params: { group_id: 4 },
      signal: undefined
    })
    await models.candidates(null)
    expect(get).toHaveBeenLastCalledWith('/admin/claudex/models/candidates', { params: undefined, signal: undefined })
  })

  it('tolerates a candidates answer without lists', async () => {
    get.mockResolvedValue({ data: {} })
    await expect(models.candidates(4)).resolves.toEqual({ models: [], sources: {} })
    get.mockResolvedValue({ data: null })
    await expect(models.candidates(4)).resolves.toEqual({ models: [], sources: {} })
  })

  it('copies a row into a body without the row-only fields', () => {
    const input = models.inputFromRow({
      ...body,
      supported_efforts: ['low'],
      badges: ['new'],
      id: 3,
      created_by: 1,
      created_at: '2026-09-26T00:00:00Z',
      updated_at: '2026-09-26T00:00:00Z'
    })
    expect(input).toEqual({ ...body, supported_efforts: ['low'], badges: ['new'] })
    expect(input).not.toHaveProperty('id')
  })
})

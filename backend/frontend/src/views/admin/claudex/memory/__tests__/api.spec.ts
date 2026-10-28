// CLAUDEX R3-S3: the memory admin API calls the three R3-S1 endpoints.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: client }))

import { clearUser, getStats, getUser } from '@/api/admin/claudex/memory'

beforeEach(() => {
  client.get.mockReset()
  client.delete.mockReset()
})

describe('admin memory API', () => {
  it('reads the stats', async () => {
    client.get.mockResolvedValue({ data: { documents: 2, encryption_key_ready: true } })
    await expect(getStats()).resolves.toEqual({ documents: 2, encryption_key_ready: true })
    expect(client.get).toHaveBeenCalledWith('/admin/claudex/memory/stats')
  })

  it('reads one user and always returns a scope list', async () => {
    client.get.mockResolvedValue({ data: { user_id: 5, scopes: null, documents: 0, edits: 0, total_bytes: 0 } })
    const meta = await getUser(5)
    expect(client.get).toHaveBeenCalledWith('/admin/claudex/memory/users/5')
    expect(meta.scopes).toEqual([])
  })

  it('clears one user', async () => {
    client.delete.mockResolvedValue({ data: { deleted_docs: 1, deleted_edits: 4 } })
    await expect(clearUser(9)).resolves.toEqual({ deleted_docs: 1, deleted_edits: 4 })
    expect(client.delete).toHaveBeenCalledWith('/admin/claudex/memory/users/9')
  })
})

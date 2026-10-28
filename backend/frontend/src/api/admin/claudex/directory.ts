import { apiClient } from '../../client'

export interface DirectorySubmission {
  id: string; kind: string; name: string; slug: string; url: string; description: string
  email: string; status: string; reviewerNote: string; updatedAt: number
  userId: number; examples: string; license: string; tools: string[]
  curation?: DirectoryCuration
}
export interface DirectoryCuration {
  topic?: string; isTrending?: boolean; isNew?: boolean; inChatUi?: boolean; popular?: boolean
  featured?: { title: string; subtitle: string; curator?: string }
}
export const directory = {
  list: () => apiClient.get<DirectorySubmission[]>('/admin/claudex/directory/submissions'),
  review: (id: string, status: string, note: string, curation?: DirectoryCuration) => apiClient.put<DirectorySubmission>(`/admin/claudex/directory/submissions/${id}/review`, { status, note, curation })
}

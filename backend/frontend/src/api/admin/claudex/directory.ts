import { apiClient } from '../../client'

export interface DirectorySubmission {
  id: string; kind: string; name: string; slug: string; url: string; description: string
  email: string; status: string; reviewerNote: string; updatedAt: number; publishedAt?: number
  userId: number; examples: string; license: string; tools: string[]
  serverUrlType?: string
  remoteUrlOptions?: { url: string; label?: string }[]
  remoteUrlRegex?: string
  remoteUrlTemplate?: string
  testServerUrl?: string
  remoteUserConfig?: { title: string; description: string; placeholder: string; pattern: string }
  original?: DirectoryDeclaration
  curation?: DirectoryCuration
}
interface DirectoryDeclaration {
  submission_data?: {
    test_setup_instructions?: string
    test_data_availability?: string
    policy_compliance?: Record<string, boolean>
  }
  supported_platforms?: ('claude_code' | 'claude_cowork')[]
  collects_user_data?: boolean
  privacy_policy_url?: string
  terms_of_service_url?: string
}
export interface DirectoryCuration {
  topic?: string; isTrending?: boolean; isNew?: boolean; inChatUi?: boolean; popular?: boolean
  featured?: { title: string; subtitle: string; curator?: string }
}
export const directory = {
  list: () => apiClient.get<DirectorySubmission[]>('/admin/claudex/directory/submissions'),
  review: (id: string, decision: { status: string; note: string; expectedUpdatedAt: number; curation?: DirectoryCuration }) =>
    apiClient.put<DirectorySubmission>(`/admin/claudex/directory/submissions/${id}/review`, decision)
}

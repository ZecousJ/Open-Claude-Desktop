/**
 * CLAUDEX: Claudex admin API (backend: internal/claudex, /api/v1/admin/claudex/*).
 * Every call goes through the upstream admin group, so it needs an admin
 * session and the accepted admin compliance commitment.
 *
 * This file only aggregates: each console area keeps its calls and types in
 * api/admin/claudex/<area>.ts (owned by the package that builds that page)
 * and is reached as adminAPI.claudex.<area>.
 */

export * as overview from './claudex/overview'
export * as policy from './claudex/policy'
export * as models from './claudex/models'
export * as devices from './claudex/devices'
export * as usageRules from './claudex/usageRules'
export * as release from './claudex/release'
export * as general from './claudex/general'
export * as voice from './claudex/voice'
export * as feedback from './claudex/feedback'
export * as sharing from './claudex/sharing'
export * as github from './claudex/github'
export * as memory from './claudex/memory'
export * as signIn from './claudex/signIn'
export * as web from './claudex/web'
export * as announcements from './claudex/announcements'
export * as status from './claudex/status'
export * as accountProfile from './claudex/accountProfile'
export * as onboarding from './claudex/onboarding'

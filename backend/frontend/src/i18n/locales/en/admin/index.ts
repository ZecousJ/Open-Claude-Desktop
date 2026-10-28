import overview from './overview'
import channels from './channels'
import accounts from './accounts'
import resources from './resources'
import ops from './ops'
import settings from './settings'
import audit from './audit'
import promptAudit from './promptAudit'
import plugins from './plugins'
// CLAUDEX: Claudex console modules (admin.claudex and one module per console page)
import claudex from './claudex'
import claudexPolicy from './claudexPolicy'
import claudexModels from './claudexModels'
import claudexDevices from './claudexDevices'
import claudexUsageRules from './claudexUsageRules'
import claudexRelease from './claudexRelease'
import claudexGeneral from './claudexGeneral'
import claudexVoice from './claudexVoice'
import claudexFeedback from './claudexFeedback'
import claudexSharing from './claudexSharing'
import claudexAnnouncements from './claudexAnnouncements'
import claudexStatus from './claudexStatus'
import claudexGitHub from './claudexGitHub'
import claudexMemory from './claudexMemory'
import claudexWeb from './claudexWeb'
import claudexAccountProfile from './claudexAccountProfile'
import claudexOnboarding from './claudexOnboarding'

export default {
  ...overview,
  ...channels,
  ...accounts,
  ...resources,
  ...ops,
  ...settings,
  ...audit,
  ...promptAudit,
  ...plugins,
  // CLAUDEX
  ...claudex,
  ...claudexPolicy,
  ...claudexModels,
  ...claudexDevices,
  ...claudexUsageRules,
  ...claudexRelease,
  ...claudexGeneral,
  ...claudexVoice,
  ...claudexFeedback,
  ...claudexSharing,
  ...claudexAnnouncements,
  ...claudexStatus,
  ...claudexGitHub,
  ...claudexAccountProfile,
  ...claudexMemory,
  ...claudexWeb,
  ...claudexOnboarding,
}

// CLAUDEX: strings for the Claudex admin pages (keys under admin.claudex). Each
// console page has its own module (admin.claudexPolicy, admin.claudexModels, ...).
export default {
  claudex: {
    nav: {
      root: 'Claudex',
      overview: 'Overview',
      policy: 'Client policy',
      models: 'Model catalog',
      devices: 'Devices',
      usageRules: 'Usage rules',
      release: 'Desktop release',
      voice: 'Voice',
      feedback: 'Diagnostics and feedback',
      general: 'General'
    },
    common: {
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Could not save the changes',
      loading: 'Loading…',
      loadFailed: 'Could not load this page',
      retry: 'Try again',
      reload: 'Reload',
      unsavedChanges: 'You have unsaved changes.',
      inherit: 'Inherit',
      required: 'This field is required.',
      https: 'Enter a full https:// URL.',
      urlTooLong: 'This URL is too long.',
      notAvailable: 'This page isn’t available in this build yet.',
      notAvailableHint:
        'The Claudex server and console in this build don’t include it. It appears here once a build that includes it is deployed.',
      tags: {
        placeholder: 'Type a value and press Enter',
        add: 'Add',
        remove: 'Remove {value}',
        duplicate: 'That value is already in the list.',
        limit: 'You can add up to {max} values.',
        empty: 'Nothing added yet.'
      }
    },
    errors: {
      CLAUDEX_SETTING_INVALID: 'Some values aren’t valid. Check the form and try again.',
      CLAUDEX_GROUP_NOT_FOUND: 'That group no longer exists. Reload and choose another group.',
      CLAUDEX_USER_NOT_FOUND: 'That user no longer exists. Reload and choose another user.'
    },
    overview: {
      title: 'Claudex',
      description:
        'Server status of the Claudex desktop service. End users sign in with the Claudex desktop app; this console is for administrators.',
      refresh: 'Refresh',
      loadFailed: 'Could not load the Claudex overview',
      server: 'Server',
      serverVersion: 'Version',
      buildType: 'Build',
      apiVersion: 'Claudex API version',
      upstream: 'Based on Sub2API',
      upstreamCommit: 'Upstream commit',
      license: 'The server is a modified Sub2API (LGPL-3.0); its source and the list of changes ship with Claudex.',
      features: 'Server features',
      featuresEmpty: 'No Claudex server features are installed in this build yet.',
      settingKeys: 'Settings keys',
      noSettings: 'No settings'
    },
    selfUpdate: {
      disabled: 'Online update is disabled',
      disabledHint:
        'This server runs the Claudex build of Sub2API. Update it by deploying a new Claudex backend build; installing an upstream Sub2API release would remove the Claudex changes.'
    },
    directory: {
      title: 'Directory submissions',
      description: 'Review submissions from Claudex users.',
      notes: 'Reviewer notes', approve: 'Approve', reject: 'Reject', empty: 'No submissions.',
      status: { submitted: 'Submitted and pending review', in_review: 'In review', approved: 'Approved', rejected: 'Rejected' }
    }
  }
}

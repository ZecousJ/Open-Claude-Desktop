// CLAUDEX: strings for the claudexUsageRules console page (keys under admin.claudexUsageRules).
// Owned by K3 (views/admin/claudex/ClaudexUsageRulesView.vue, components/admin/claudex/usage).
export default {
  claudexUsageRules: {
    title: 'Usage rules',
    description: 'Current session (5 hours) and weekly limits per model, applied to every key in a group.',
    errors: {
      CLAUDEX_USAGE_RULE_INVALID: 'Some rule values aren’t valid. Check the form and try again.',
      CLAUDEX_USAGE_RULE_NOT_FOUND: 'That rule no longer exists. Reload to see the current rules.',
      CLAUDEX_GROUP_NOT_FOUND: 'That group no longer exists. Reload and choose another group.',
      CLAUDEX_USER_NOT_FOUND: 'That user no longer exists. Reload and choose another user.',
      CLAUDEX_NO_PLAN: 'This user has no plan group that Claudex can use.'
    },
    create: 'New rule',
    rulesTitle: 'Rules',
    rulesHint:
      'A rule limits what each user spends (in USD, as billed) in a window that starts with their first request. It applies to every key of the group, including keys users created themselves.',
    allGroups: 'All groups',
    addToGroup: 'Add',
    sectionEmpty: 'No rules.',
    allModels: 'All models',
    enabled: 'On',
    disabled: 'Off',
    shownInClaudex: 'Shown in Claudex',
    missingGroup: 'Group #{id}',
    groupDeleted: 'Group deleted · these rules no longer apply',
    deletedGroupOption: '{name} (deleted)',
    columns: {
      label: 'Label',
      kind: 'Kind',
      models: 'Models',
      window: 'Window',
      limit: 'Limit',
      state: 'State',
      sort: 'Order',
      actions: 'Actions'
    },
    kinds: {
      session: 'Current session',
      all_models: 'All models',
      models: 'Specific models'
    },
    kindHints: {
      session: 'Shown as “Current session” in Claudex. Usually 5 hours.',
      all_models: 'Limits spending on every model, shown under weekly limits.',
      models: 'Limits spending on the models that match the patterns below.'
    },
    window: {
      '5h': '5 hours',
      '24h': '24 hours',
      '7d': '7 days',
      '30d': '30 days',
      custom: 'Custom',
      hours: '{n} hours'
    },
    defaults: {
      sessionLabel: 'Current session',
      allModelsLabel: 'All models'
    },
    validation: {
      kind: 'Choose a kind.',
      labelRequired: 'Enter a label.',
      labelTooLong: 'Use 60 characters or fewer.',
      patternsRequired: 'Add at least one model.',
      patternsTooMany: 'Use 50 patterns or fewer.',
      patternEmpty: 'Enter a model name.',
      patternTooLong: 'Use 200 characters or fewer.',
      patternSpaces: 'Model names can’t contain spaces.',
      patternAll: 'For every model, use the “All models” kind.',
      patternWildcard: 'Put * only at the end, for example claude-opus-*.',
      patternDuplicate: 'Each pattern can appear only once.',
      customHours: 'Enter whole hours from 1 to 720.',
      limit: 'Enter an amount greater than 0.',
      sort: 'Enter a whole number.'
    },
    form: {
      createTitle: 'New usage rule',
      editTitle: 'Edit usage rule',
      group: 'Group',
      groupHint: 'The rule applies to requests made with keys of this group.',
      kind: 'Kind',
      label: 'Label',
      labelPlaceholder: 'For example Opus',
      labelHint: 'Shown to users in Claudex. Up to 60 characters.',
      patterns: 'Models',
      patternsPlaceholder: 'claude-opus-*',
      patternsHint:
        'Exact model names, or a prefix ending in * (up to {max}). A request counts when its requested, billed or upstream model matches.',
      window: 'Window',
      customHours: 'Hours',
      hours: 'hours',
      windowHint: 'Starts with the user’s first request and resets when it ends.',
      limit: 'Limit (USD)',
      limitHint: 'Requests are refused once a user reaches it.',
      sort: 'Order',
      sortHint: 'Lower numbers are shown first.',
      enabled: 'Enabled',
      enabledHint: 'Turned-off rules don’t limit anyone.',
      showInClient: 'Show in Claudex',
      showInClientHint: 'Show this limit on the user’s usage page. Hidden rules still apply.',
      save: 'Save rule'
    },
    actions: {
      counters: 'Usage by user',
      edit: 'Edit',
      delete: 'Delete'
    },
    counters: {
      title: 'Usage: {label}',
      summary: 'Limit {limit} per {window}.',
      close: 'Close',
      filterUser: 'User',
      user: 'User',
      used: 'Used',
      requests: 'Requests',
      window: 'Window',
      empty: 'Nobody has used this rule yet.',
      resetsAt: 'Resets {time}',
      startedAt: 'Started {time}',
      windowEnded: 'Ended {time}',
      nextWindow: 'The next request starts a new window',
      reset: 'Reset',
      loadFailed: 'Could not load the usage',
      confirmTitle: 'Reset this usage?',
      confirmMessage:
        '{user}’s usage for {label} goes back to zero, and their next request starts a new window.',
      resetDone: 'Usage reset.'
    },
    status: {
      title: 'Check a user’s usage',
      description: 'The limits and usage one user sees in Claudex.',
      user: 'User',
      group: 'Group',
      planGroup: 'The user’s plan group',
      show: 'Refresh',
      plan: 'Plan group',
      noPlan: 'None',
      balance: 'Balance',
      updatedAt: 'As of {time}',
      blocked: 'This user has reached a limit.',
      blockedUntil: 'This user has reached a limit until {time}.',
      limit: 'Limit',
      used: 'Used',
      resets: 'Resets',
      empty: 'No limits apply to this user.',
      notStarted: 'Not started',
      pickUser: 'Choose a user to see their usage.',
      loadFailed: 'Could not load this user’s usage',
      sources: {
        rule: 'Rule',
        subscription: 'Subscription',
        key: 'Device key'
      }
    },
    confirm: {
      createTitle: 'Add this rule?',
      saveTitle: 'Save this rule?',
      saveMessage:
        'It applies right away to every key in {group}, including keys users created themselves.',
      saved: 'Rule saved.',
      deleteTitle: 'Delete “{label}”?',
      deleteMessage: 'Its usage counters are deleted too, and it no longer limits anyone.',
      deleted: 'Rule deleted.'
    }
  }
}

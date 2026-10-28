// CLAUDEX: strings for the claudexSharing console page (keys under admin.claudexSharing, R1-K).
export default {
  claudexSharing: {
    nav: 'Sharing',
    title: 'Sharing',
    description:
      'Public links to conversations and artifacts shared from the Claudex desktop app: settings, moderation and reports.',
    storageUnavailable:
      'This server has no database for shared links, so sharing can’t be used here. The settings are kept for when it can.',
    offNote:
      'Sharing is off. The share options are hidden in the Claudex app and every public link answers “not found”. Existing links are kept and come back when you turn sharing on.',
    onNote: 'Sharing is on. Anyone with a link can open it without signing in.',
    fixProblems: 'Fix the highlighted fields, then save again.',
    settings: {
      title: 'Sharing',
      description: 'Let Claudex desktop users publish read-only snapshots that anyone with the link can view.',
      enabled: 'Allow sharing',
      conversations: 'Conversations',
      conversationsHint: 'Share a snapshot of a chat or session: the prompts and replies, not commands or their output.',
      artifacts: 'Artifacts',
      artifactsHint: 'Publish a single artifact (HTML, SVG, Markdown, diagram or code) as its own page.',
      allowReports: 'Report button',
      allowReportsHint: 'Visitors can report a shared page. Reports appear under Reports below.'
    },
    links: {
      title: 'Links',
      description: 'Links are built when they are read, so changing an address updates every existing link.',
      publicBaseUrl: 'Public address',
      publicBaseUrlHint:
        'Where the public pages are served, for example https://share.example.com. Leave empty to use the server’s frontend URL.',
      effective: 'Links currently start with {url}',
      sources: {
        setting: 'Set here.',
        frontend_url: 'From the server’s frontend URL.',
        none: 'No address is set, so the Claudex app builds links from the server address it signs in to.'
      },
      contentBaseUrl: 'Separate content address',
      contentBaseUrlHint:
        'Optional. Artifact documents are served from this host to keep them apart from the console. It needs a public address on a different host that reaches this server.',
      usagePolicyUrl: 'Usage Policy link',
      usagePolicyUrlHint: 'Linked from the share dialogs. Leave empty to use this server’s usage policy document.',
      effectivePolicy: 'Share dialogs link to {url}',
      noPolicy: 'No usage policy is set, so the share dialogs show no policy link.'
    },
    limits: {
      title: 'Limits',
      maxSnapshot: 'Max conversation size (KiB)',
      maxArtifact: 'Max artifact size (KiB)',
      maxActive: 'Max links per user',
      ttl: 'Links expire after (days)',
      ttlHint: '0 means links never expire. Applies to links created or updated after you save.'
    },
    problems: {
      baseUrl: 'Enter an https:// address without a query or fragment (http:// only for localhost).',
      httpsUrl: 'Enter a full https:// URL.',
      requiresPublicBase: 'Set the public address first.',
      sameHost: 'Use a different host than the public address.',
      snapshotSize: 'Enter a whole number from 64 to 32768.',
      artifactSize: 'Enter a whole number from 16 up to the max conversation size.',
      activePerUser: 'Enter a whole number from 1 to 100000.',
      ttlDays: 'Enter a whole number from 0 to 3650.'
    },
    tabs: {
      shares: 'Shared links',
      reports: 'Reports',
      artifactReports: 'Artifact reports',
      blocks: 'Blocked users'
    },
    kinds: {
      conversation: 'Conversation',
      artifact: 'Artifact'
    },
    statuses: {
      active: 'Public',
      disabled: 'Taken down',
      revoked: 'Deleted',
      expired: 'Expired'
    },
    fields: {
      title: 'Title',
      kind: 'Type',
      author: 'Author',
      status: 'Status',
      views: 'Views',
      reports: 'Open reports',
      size: 'Size',
      created: 'Shared',
      expires: 'Expires',
      actions: 'Actions',
      reason: 'Reason',
      detail: 'Details',
      share: 'Shared link',
      artifact: 'Artifact',
      reported: 'Reported',
      user: 'User',
      blockedAt: 'Blocked',
      untitled: 'Untitled',
      never: 'Never'
    },
    filters: {
      status: 'Status',
      liveStatuses: 'Public and taken down',
      kind: 'Type',
      anyKind: 'Any type',
      userId: 'User ID',
      any: 'Any',
      search: 'Search',
      searchPlaceholder: 'Title or author e-mail',
      apply: 'Apply',
      reset: 'Reset',
      anyStatus: 'Any status'
    },
    shares: {
      empty: 'No shared links.',
      loadFailed: 'Could not load the shared links',
      takenDownReason: 'Reason: {reason}'
    },
    actions: {
      open: 'Open',
      review: 'Review',
      takeDown: 'Take down',
      restore: 'Restore',
      delete: 'Delete',
      blockAuthor: 'Block author',
      dismiss: 'Dismiss',
      unblock: 'Unblock',
      takeDownAll: 'Take down all links',
      resolve: 'Mark resolved',
      block: 'Block'
    },
    reason: {
      label: 'Reason (optional)',
      placeholder: 'For example: personal information',
      hint: 'Saved with the link. The author can see it in the Claudex app.',
      tooLong: 'Keep the reason under 500 characters.'
    },
    confirm: {
      takeDownTitle: 'Take down this link?',
      takeDownMessage:
        '“{title}” stops being public: its page says the content was removed by the administrator. You can restore it later.',
      restoreTitle: 'Restore this link?',
      restoreMessage: '“{title}” becomes public again for anyone with the link.',
      deleteTitle: 'Delete this link?',
      deleteMessage: 'The snapshot of “{title}” is deleted for good and the link stops working. This can’t be undone.',
      blockTitle: 'Block {user} from sharing?',
      blockMessage:
        'They can no longer create or update shared links. Their existing links stay online; take them down separately if needed.',
      unblockTitle: 'Let {user} share again?',
      unblockMessage: 'They can create shared links again while sharing is on.',
      takeDownAllTitle: 'Take down all links of {user}?',
      takeDownAllMessage: 'Every public link of this user is taken down. You can restore links one by one.',
      dismissTitle: 'Dismiss this report?',
      dismissMessage: 'The report is closed and the link stays online.',
      reportTakeDownTitle: 'Take down the reported link?',
      reportTakeDownMessage: '“{title}” is taken down and every open report about it is closed. You can restore it later.',
      artifactDismissMessage: 'The report is closed without action.',
      artifactResolveTitle: 'Mark this report resolved?',
      artifactResolveMessage:
        'Use this once you acted on it, for example by blocking the account. The artifact itself is on the reporter’s computer, not on this server.'
    },
    toasts: {
      takenDown: 'Link taken down',
      restored: 'Link restored',
      deleted: 'Link deleted',
      blocked: 'User blocked from sharing',
      unblocked: 'User can share again',
      takenDownAll: 'Took down {count} links',
      dismissed: 'Report dismissed',
      resolved: 'Report resolved',
      actionFailed: 'Could not complete the action'
    },
    content: {
      title: 'Review shared content',
      loadFailed: 'Could not load the shared content',
      user: 'User',
      assistant: 'Claude',
      activity: 'Activity',
      artifacts: 'Artifacts',
      artifactRef: 'Artifact {n}',
      model: 'Model',
      mode: 'Mode',
      empty: 'This snapshot has no messages.',
      note: 'Shown as plain text. The public page renders Markdown and runs artifacts in a sandbox.'
    },
    reports: {
      empty: 'No reports.',
      loadFailed: 'Could not load the reports',
      noDetail: 'No details.',
      reasons: {
        illegal: 'Illegal content',
        harmful: 'Harmful content',
        privacy: 'Personal information',
        spam: 'Spam',
        other: 'Other'
      },
      categories: {
        child_safety: 'Child safety/sexual abuse',
        fraud: 'Fraud',
        sexually_explicit_content: 'Sexually Explicit content',
        non_consensual_intimate_imagery: 'Non-consensual intimate imagery',
        violence_and_hate: 'Violence and/or hate speech',
        illegal_goods: 'Illegal goods',
        defamation: 'Defamation',
        other_illegal: 'Other illegal or unlawful content',
        violation_of_terms: 'Violation of terms or usage policy'
      },
      reporter: 'From {who}',
      optedOut: 'Opted out of training',
      optedOutHint: 'The reporter opted out: don’t use this report to train models.',
      statuses: {
        open: 'Open',
        resolved: 'Taken down',
        dismissed: 'Dismissed'
      },
      reportsOff: 'The Report button is off, so visitors can’t send new reports.'
    },
    artifactReports: {
      description:
        'Reports sent from Report artifact in the Claudex app. The artifact is on the reporter’s computer, so each report keeps a copy of it.',
      empty: 'No artifact reports.',
      loadFailed: 'Could not load the artifact reports',
      reportsOff: 'The Report button is off, so the app can’t send new artifact reports.',
      reviewTitle: 'Review reported artifact',
      reviewNote: 'The copy is shown as plain text and never run.',
      copyLoadFailed: 'Could not load the artifact copy',
      copyCut: 'The copy holds the first {size} of {total}.',
      noCopy: 'No text copy: a binary file of {total}.',
      statuses: {
        open: 'Open',
        resolved: 'Resolved',
        dismissed: 'Dismissed'
      }
    },
    blocks: {
      description: 'Blocked users can’t create or update shared links. They can still see and stop their existing links.',
      addTitle: 'Block a user',
      userId: 'User ID',
      invalidUser: 'Enter a user ID.',
      empty: 'No blocked users.',
      loadFailed: 'Could not load the blocked users'
    },
    errors: {
      CLAUDEX_SHARE_NOT_FOUND: 'That shared link no longer exists. The list was refreshed.',
      CLAUDEX_SHARE_REPORT_NOT_FOUND: 'That report no longer exists. The list was refreshed.',
      CLAUDEX_SHARING_UNAVAILABLE: 'This server has no database for shared links.',
      CLAUDEX_USER_NOT_FOUND: 'No user has that ID.',
      CLAUDEX_SHARE_INVALID: 'The reason is too long.',
      CLAUDEX_SHARE_REPORT_INVALID: 'The reason is too long.',
      CLAUDEX_SHARE_FILTER_INVALID: 'One of the filters isn’t valid.',
      CLAUDEX_SHARING_STORE_FAILED: 'Couldn’t read or save shared links. Try again later.',
      CLAUDEX_SHARING_SETTINGS_FAILED: 'Couldn’t read or save the sharing settings.'
    }
  }
}

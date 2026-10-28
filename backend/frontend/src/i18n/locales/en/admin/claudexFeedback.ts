// CLAUDEX: strings for the claudexFeedback console page (keys under admin.claudexFeedback).
export default {
  claudexFeedback: {
    title: 'Diagnostics and feedback',
    description: 'Diagnostic reports and reply feedback sent from the desktop app. Nothing is collected until you turn it on.',
    consentNote: 'Nothing is collected until you turn this on, and each user must also agree in the Claudex app.',
    collecting:
      'Collection is on. Reports never include prompts or replies; a feedback includes the conversation only when the user attaches it and excerpts are allowed below.',
    notCollecting: 'Both kinds are off, so the server accepts no reports.',
    retentionDays: 'Keep for (days)',
    perDay: 'Max per user per day',
    retentionNote:
      'Reports older than the retention period are deleted automatically every hour. Database backups can keep them longer.',
    fixProblems: 'Fix the highlighted fields, then save again.',
    problems: {
      diagnosticsRetention: 'Enter a whole number from 1 to 365.',
      feedbackRetention: 'Enter a whole number from 1 to 730.',
      perDay: 'Enter a whole number from 1 to 1000.'
    },
    diagnostics: {
      title: 'Diagnostics',
      description:
        'Error codes and app and system versions when something fails in the desktop app. No prompts, replies or file paths.',
      empty: 'No diagnostic reports.',
      detailTitle: 'Diagnostic report',
      deleteTitle: 'Delete this report?',
      deleteMessage: 'The report is removed permanently.',
      deleted: 'Report deleted'
    },
    feedback: {
      title: 'Reply feedback',
      description: 'A thumbs up or down on a reply, with the categories and comment the user chose.',
      allowExcerpt: 'Allow conversation excerpts',
      allowExcerptHint:
        'Keep the conversation a user chooses to include with their feedback. When this is off, excerpts are dropped.',
      empty: 'No feedback yet.',
      detailTitle: 'Feedback',
      noComment: 'No comment.',
      noExcerpt: 'Not included.',
      deleteTitle: 'Delete this feedback?',
      deleteMessage: 'The feedback and any conversation excerpt are removed permanently.',
      deleted: 'Feedback deleted'
    },
    tabs: {
      diagnostics: 'Diagnostic reports',
      feedback: 'Reply feedback'
    },
    filters: {
      userId: 'User ID',
      any: 'Any',
      kind: 'Kind',
      anyKind: 'Any kind',
      code: 'Code',
      appVersion: 'App version',
      from: 'From',
      to: 'To',
      rating: 'Rating',
      anyRating: 'Any rating',
      apply: 'Filter',
      reset: 'Reset'
    },
    kinds: {
      turn_error: 'Turn error',
      gateway_refusal: 'Gateway refusal',
      crash: 'Crash',
      update_failed: 'Update failed',
      mcp_start_failed: 'MCP server failed to start',
      provision_failed: 'Device setup failed'
    },
    ratings: {
      up: 'Helpful',
      down: 'Not helpful'
    },
    fields: {
      occurredAt: 'Occurred',
      receivedAt: 'Received',
      user: 'User',
      kind: 'Kind',
      code: 'Code',
      message: 'Message',
      model: 'Model',
      appVersion: 'App version',
      codexVersion: 'Codex version',
      platform: 'Platform',
      osVersion: 'OS version',
      requestId: 'Request ID',
      context: 'Context',
      reportId: 'Report ID',
      feedbackId: 'Feedback ID',
      rating: 'Rating',
      categories: 'Categories',
      comment: 'Comment',
      excerpt: 'Conversation excerpt',
      actions: 'Actions'
    },
    actions: {
      view: 'View',
      delete: 'Delete'
    },
    requestId: {
      copy: 'Copy request ID',
      copied: 'Request ID copied',
      openOps: 'Open Ops',
      opsHint: 'Search the system logs there by client request ID.'
    },
    drawer: {
      close: 'Close'
    },
    loadListFailed: 'Could not load the list',
    loadDetailFailed: 'Could not load the details',
    deleteFailed: 'Could not delete it',
    errors: {
      CLAUDEX_SETTING_INVALID: 'Some values aren’t valid. Check the form and try again.',
      CLAUDEX_REPORT_NOT_FOUND: 'That report doesn’t exist or was already deleted.',
      CLAUDEX_REPORT_FILTER_INVALID: 'One of the filters isn’t valid. Check them and try again.'
    }
  }
}

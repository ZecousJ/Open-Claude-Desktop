// CLAUDEX: strings for the Memory console page (keys under admin.claudexMemory, R3-S3).
export default {
  claudexMemory: {
    nav: 'Memory',
    title: 'Memory',
    description:
      'Memory of Claudex desktop users: usage and per-user metadata. Memory text is encrypted; administrators can clear it but never read it.',
    refresh: 'Refresh',
    policyNote: 'Whether memory is on, which switches users may turn on and their default are set in the client policy.',
    policyLink: 'Open client policy',
    keyMissing: {
      title: 'Memory can’t be stored',
      body: 'The server has no fixed encryption key, so users can’t save memory. Set TOTP_ENCRYPTION_KEY in the server environment and restart it. Memory stays unavailable in the Claudex app until then.'
    },
    stats: {
      title: 'Usage',
      optedIn: 'Users who turned memory on',
      optedInHint: 'Users on a policy that turns memory on by default are counted once they change a switch.',
      withMemory: 'Users with memory',
      documents: 'Memory documents',
      edits: 'Memory edits',
      size: 'Stored size',
      keyReady: 'Encryption key',
      ready: 'Ready',
      missing: 'Missing'
    },
    user: {
      title: 'User memory',
      description:
        'Look up one user’s memory: sizes, revisions and dates for each scope. Clearing deletes their memory documents and edits; their memory switches stay as they are.',
      pick: 'User',
      pickHint: 'Search for a user to see their memory.',
      loadFailed: 'Could not load this user’s memory',
      switches: 'Memory switches',
      searchChats: 'Search and reference chats',
      generate: 'Generate memory from chat history',
      on: 'On',
      off: 'Off',
      notSet: 'Not set (policy default)',
      changed: 'Changed {time}',
      summary: '{documents} documents, {edits} edits, {size}',
      empty: 'This user has no stored memory.',
      clear: 'Clear memory',
      clearTitle: 'Clear this user’s memory?',
      clearMessage:
        'Every memory document and edit of {user} will be deleted. This can’t be undone. Their memory switches stay as they are, so memory starts again from nothing if they keep it on.',
      cleared: 'Memory cleared: {documents} documents and {edits} edits deleted.',
      userId: 'User #{id}'
    },
    columns: {
      scope: 'Scope',
      document: 'Document',
      source: 'Source',
      revision: 'Revision',
      edits: 'Edits',
      updated: 'Updated'
    },
    scope: {
      global: 'Global',
      project: 'Project {id}'
    },
    source: {
      user: 'Edited by user',
      import: 'Imported',
      generated: 'Generated',
      none: '—'
    },
    noDocument: 'No document',
    generatedAt: 'Generated {time}',
    overviewWarning: {
      title: 'Memory can’t be stored',
      body: 'The server has no fixed encryption key (TOTP_ENCRYPTION_KEY), so Claudex users can’t save memory.',
      link: 'Memory settings'
    },
    errors: {
      CLAUDEX_MEMORY_USER_NOT_FOUND: 'This user no longer exists.',
      CLAUDEX_MEMORY_STORE_FAILED: 'The server could not read or change memory. Try again later.'
    }
  }
}

// CLAUDEX: strings for the claudexGitHub console page (keys under admin.claudexGitHub, W-GITHUB).
export default {
  claudexGitHub: {
    nav: 'GitHub',
    title: 'GitHub',
    description:
      'The GitHub app that lets people using Claudex on the web connect their GitHub account and pick a repository for Code.',
    fixProblems: 'Fix the highlighted fields, then save again.',
    app: {
      title: 'GitHub connection',
      description:
        'While this is off, the web app says GitHub isn’t set up on this service and the repository picker stays disabled.'
    },
    kind: 'App type',
    kinds: {
      oauth_app: 'OAuth App',
      github_app: 'GitHub App'
    },
    kindHint:
      'An OAuth App asks people for access to their repositories (the repo scope). A GitHub App uses the permissions you set on GitHub, and its tokens expire and are refreshed.',
    publicBaseUrl: 'Public address',
    publicBaseUrlHint:
      'Where people reach this service, for example https://claudex.example.com. Leave empty to use the server’s frontend URL.',
    callbackUrl: 'Authorization callback URL to register with GitHub:',
    clientId: 'Client ID',
    clientSecret: 'Client secret',
    secretStored: 'A client secret is stored.',
    secretNotStored: 'No client secret is stored.',
    secretWillBeRemoved: 'The stored client secret will be removed when you save. GitHub turns off.',
    removeSecret: 'Remove',
    undoRemoveSecret: 'Undo',
    secretPlaceholder: 'Paste the client secret',
    secretReplacePlaceholder: 'Leave empty to keep the stored secret',
    secretHint: 'The secret is encrypted on the server and never shown again.',
    cannotStoreSecret:
      'This server has no fixed secret encryption key (TOTP_ENCRYPTION_KEY), so a client secret can’t be stored.',
    problems: {
      clientIdFormat: 'The client ID must be at most 100 characters without spaces.',
      clientIdRequired: 'Enter the client ID before turning GitHub on.',
      secretLength: 'The client secret must be 8 to 512 characters.',
      secretFormat: 'The client secret must not contain spaces.',
      secretRequired: 'Store the client secret before turning GitHub on.',
      baseUrl: 'Enter an https address such as https://claudex.example.com, without a query or fragment.'
    },
    errors: {
      CLAUDEX_GITHUB_INVALID: 'The GitHub settings are not valid. Check the highlighted fields.',
      CLAUDEX_GITHUB_ENCRYPTION_KEY_MISSING:
        'The server has no fixed secret encryption key (TOTP_ENCRYPTION_KEY), so the client secret can’t be stored.'
    }
  }
}

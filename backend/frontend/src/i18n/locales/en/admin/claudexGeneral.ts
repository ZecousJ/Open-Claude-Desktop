// CLAUDEX: strings for the claudexGeneral console page (keys under admin.claudexGeneral).
export default {
  claudexGeneral: {
    title: 'General',
    description: 'Who can use this web console, and how Backend mode and online update affect Claudex.',
    webConsole: {
      title: 'Web console',
      adminOnly: 'Web console for admins only',
      adminOnlyHint:
        'Regular users are sent to a page that asks them to use the desktop app. The API stays available to the desktop app.',
      openNote:
        'With this off, regular users can also sign in to this web console and use the Sub2API user pages.'
    },
    signIn: {
      title: 'Sign-in',
      emailCode: 'Sign in with an email code',
      emailCodeHint:
        'The desktop and web sign-in pages offer a one-time code sent by email instead of the password. Codes expire after 10 minutes.',
      smtpNote: 'Email codes need SMTP to be set up under System settings → Email.',
      smtpMissing: 'SMTP isn’t set up yet, so the sign-in pages won’t offer email codes. Set it up under System settings → Email.',
      backendMode: 'Backend mode is on, so the sign-in pages won’t offer email codes.',
      available: 'Email codes are offered on the sign-in pages.',
      unavailable: 'Email codes are not offered on the sign-in pages.',
      privacyPolicyUrl: 'Privacy policy link',
      privacyPolicyPlaceholder: 'https://example.com/privacy or /legal/privacy',
      privacyPolicyHint: 'Shown on the sign-in pages. Leave empty for no link.',
      privacyPolicyInvalid: 'Use an https:// address or a path on this site starting with “/”.',
      retry: 'Retry'
    },
    backendMode: {
      title: 'Backend mode',
      status: 'Backend mode (System settings)',
      on: 'On',
      off: 'Off',
      warningTitle: 'Backend mode is on',
      warning:
        'Only administrators can sign in while Backend mode is on. Regular users can’t sign in to the Claudex desktop app either.',
      offHint: 'Regular users can sign in to the Claudex desktop app. Turning Backend mode on blocks them.',
      openSettings: 'Open system settings'
    },
    onlineUpdate: {
      title: 'Online update',
      disabled: 'Disabled in the Claudex build. Upgrade by rebuilding from the repository.'
    },
    errors: {
      CLAUDEX_SETTING_INVALID: 'Some values aren’t valid. Check the form and try again.',
      CLAUDEX_SIGN_IN_INVALID: 'The privacy policy link isn’t valid. Use an https:// address or a path starting with “/”.'
    }
  }
}

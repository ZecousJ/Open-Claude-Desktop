// CLAUDEX: strings for /desktop-only (keys under desktopOnly), the page non-admins
// see while the web console is for administrators only.
export default {
  desktopOnly: {
    // CLAUDEX: W-CONSOLE point to both the web app ('/') and the desktop app
    title: 'Use the Claudex web app or desktop app',
    body: 'This console is for administrators. Use your account in the Claudex web app, or sign in to Claudex on your computer.',
    notAdmin:
      'This account isn’t an administrator, so it was signed out of the console. This doesn’t sign you out of the Claudex web app or desktop app.',
    useWebAppOrDesktop: 'This console is for administrators. Use the Claudex web app or desktop app.',
    openWebApp: 'Open the Claudex web app',
    download: 'Download Claudex',
    downloadFor: 'Download Claudex for {platform}',
    version: 'Version {version}',
    backToSignIn: 'Back to sign in',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    platforms: {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux'
    }
  }
}

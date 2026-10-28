// CLAUDEX: /desktop-only 页面文案（desktopOnly 下的键）。网页控制台仅限管理员时，
// 非管理员会看到此页面。
export default {
  desktopOnly: {
    // CLAUDEX: W-CONSOLE 同时指向网页版（/）与桌面端
    title: '请使用 Claudex 网页版或桌面端',
    body: '此控制台仅供管理员使用。请在 Claudex 网页版中使用你的账户，或在电脑上登录 Claudex 桌面端。',
    notAdmin: '此账户不是管理员，已退出控制台。Claudex 网页版和桌面端的登录不受影响。',
    useWebAppOrDesktop: '此控制台仅供管理员使用，请使用 Claudex 网页版或桌面端。',
    openWebApp: '打开 Claudex 网页版',
    download: '下载 Claudex',
    downloadFor: '下载 {platform} 版 Claudex',
    version: '版本 {version}',
    backToSignIn: '返回登录',
    signOut: '退出登录',
    signingOut: '正在退出…',
    platforms: {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux'
    }
  }
}

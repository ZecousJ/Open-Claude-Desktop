// CLAUDEX: claudexGeneral 控制台页面文案（admin.claudexGeneral 下的键）。
export default {
  claudexGeneral: {
    title: '通用',
    description: '谁可以使用此网页控制台，以及 Backend 模式与在线更新对 Claudex 的影响。',
    webConsole: {
      title: '网页控制台',
      adminOnly: '网页控制台仅限管理员',
      adminOnlyHint: '普通用户会被引导到一个提示使用桌面端的页面。API 仍对桌面端开放。',
      openNote: '关闭后，普通用户也可以登录此网页控制台并使用 Sub2API 的用户页面。'
    },
    signIn: {
      title: '登录',
      emailCode: '使用邮箱验证码登录',
      emailCodeHint: '桌面端和网页版登录页可以用发送到邮箱的一次性验证码代替密码登录。验证码 10 分钟后失效。',
      smtpNote: '邮箱验证码需要先在“系统设置 → 邮件”中配置 SMTP。',
      smtpMissing: '尚未配置 SMTP，登录页不会提供邮箱验证码登录。请在“系统设置 → 邮件”中配置。',
      backendMode: 'Backend 模式已开启，登录页不会提供邮箱验证码登录。',
      available: '登录页已提供邮箱验证码登录。',
      unavailable: '登录页目前不提供邮箱验证码登录。',
      privacyPolicyUrl: '隐私政策链接',
      privacyPolicyPlaceholder: 'https://example.com/privacy 或 /legal/privacy',
      privacyPolicyHint: '显示在登录页上。留空则不显示链接。',
      privacyPolicyInvalid: '请填写 https:// 地址，或以“/”开头的本站路径。',
      retry: '重试'
    },
    backendMode: {
      title: 'Backend 模式',
      status: 'Backend 模式（系统设置）',
      on: '已开启',
      off: '已关闭',
      warningTitle: 'Backend 模式已开启',
      warning: 'Backend 模式开启时只有管理员可以登录，Claudex 桌面端的普通用户也无法登录。',
      offHint: '普通用户可以登录 Claudex 桌面端。开启 Backend 模式会阻止他们登录。',
      openSettings: '打开系统设置'
    },
    onlineUpdate: {
      title: '在线更新',
      disabled: 'Claudex 构建中已关闭在线更新。请从仓库重新构建来升级。'
    },
    errors: {
      CLAUDEX_SETTING_INVALID: '部分值无效，请检查表单后重试。',
      CLAUDEX_SIGN_IN_INVALID: '隐私政策链接无效。请填写 https:// 地址，或以“/”开头的路径。'
    }
  }
}

// CLAUDEX: claudexGitHub 控制台页面文案（admin.claudexGitHub，W-GITHUB）。
export default {
  claudexGitHub: {
    nav: 'GitHub',
    title: 'GitHub',
    description: '让网页版 Claudex 的用户连接自己的 GitHub 账号并为 Code 选择仓库所用的 GitHub 应用。',
    fixProblems: '请修正高亮的字段后再保存。',
    app: {
      title: 'GitHub 连接',
      description: '关闭时，网页版会提示“此服务尚未配置 GitHub”，仓库选择器保持禁用。'
    },
    kind: '应用类型',
    kinds: {
      oauth_app: 'OAuth App',
      github_app: 'GitHub App'
    },
    kindHint:
      'OAuth App 会向用户申请访问其仓库的授权（repo 范围）；GitHub App 使用你在 GitHub 上设置的权限，令牌会过期并自动刷新。',
    publicBaseUrl: '公开地址',
    publicBaseUrlHint: '用户访问本服务的地址，例如 https://claudex.example.com。留空则使用服务器的前端 URL。',
    callbackUrl: '需要在 GitHub 登记的授权回调地址：',
    clientId: 'Client ID',
    clientSecret: 'Client secret',
    secretStored: '已保存客户端密钥。',
    secretNotStored: '尚未保存客户端密钥。',
    secretWillBeRemoved: '保存后将移除已保存的客户端密钥，GitHub 连接随之关闭。',
    removeSecret: '移除',
    undoRemoveSecret: '撤销',
    secretPlaceholder: '粘贴客户端密钥',
    secretReplacePlaceholder: '留空则保留已保存的密钥',
    secretHint: '密钥在服务器上加密保存，之后不会再显示。',
    cannotStoreSecret: '服务器没有固定的密钥加密密钥（TOTP_ENCRYPTION_KEY），无法保存客户端密钥。',
    problems: {
      clientIdFormat: 'Client ID 最多 100 个字符，且不能包含空格。',
      clientIdRequired: '开启 GitHub 前请填写 Client ID。',
      secretLength: '客户端密钥需为 8 到 512 个字符。',
      secretFormat: '客户端密钥不能包含空格。',
      secretRequired: '开启 GitHub 前请先保存客户端密钥。',
      baseUrl: '请填写 https 地址，例如 https://claudex.example.com，不含查询参数或片段。'
    },
    errors: {
      CLAUDEX_GITHUB_INVALID: 'GitHub 设置无效，请检查高亮字段。',
      CLAUDEX_GITHUB_ENCRYPTION_KEY_MISSING: '服务器没有固定的密钥加密密钥（TOTP_ENCRYPTION_KEY），无法保存客户端密钥。'
    }
  }
}

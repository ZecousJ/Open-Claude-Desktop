// CLAUDEX: claudexRelease 控制台页面文案（admin.claudexRelease 下的键）。
export default {
  claudexRelease: {
    title: '桌面端发布',
    description: 'Claudex 桌面端的最新版本、最低版本、更新说明与下载链接。',
    updatedAt: '上次保存：{time}',
    versions: {
      title: '版本',
      description: '桌面端会把自己的版本与这里比较，并显示更新提示。',
      latest: '最新版本',
      latestHint: '例如 1.4.0。如果不在这里发布桌面端版本，请留空。',
      minimum: '最低版本',
      minimumHint: '更旧的版本会被要求更新。不能高于最新版本。',
      publishedAt: '发布时间',
      publishedAtHint: '随更新提示显示。按你的本地时间填写。',
      notesUrl: '更新说明链接',
      notesUrlHint: '可选。完整更新说明所在的页面。'
    },
    notes: {
      title: '更新说明',
      description: '在更新提示中显示的 Markdown。原始 HTML 会显示为文本，图片不会加载（预览与 Claudex 中都一样）。',
      markdown: 'Markdown',
      placeholder: '## 1.4.0\n- 这个版本的改动',
      hint: '预览与 Claudex 中的显示方式一致。',
      count: '{count} / {max}',
      preview: '预览',
      previewEmpty: '暂无可预览的内容。'
    },
    downloads: {
      title: '下载',
      description: '每个平台一个下载地址。桌面端只会打开 https 链接。某个平台留空时，该平台不显示下载按钮。',
      url: '下载地址',
      sha256: 'SHA-256（可选）',
      sha256Placeholder: '64 位十六进制字符'
    },
    platforms: {
      macosArm64: 'macOS（Apple 芯片）',
      macosX64: 'macOS（Intel）',
      macosUniversal: 'macOS（通用）',
      windowsX64: 'Windows（x64）',
      windowsArm64: 'Windows（Arm64）',
      linuxX64: 'Linux（x64）',
      linuxArm64: 'Linux（Arm64）'
    },
    enforcement: {
      title: '网关强制',
      label: '在网关强制最低版本',
      hint: '默认关闭。只对使用 Claudex 设备 Key 的请求生效。',
      warning: '开启后，旧版 Claudex 在更新之前将无法使用。关闭时，旧版只会看到更新提示。',
      noMinimum: '尚未设置最低版本，因此目前不会强制任何版本。'
    },
    problems: {
      version: '请输入类似 1.4.0 或 1.4.0-beta.1 的版本号（最多 32 个字符）。',
      minimumWithoutLatest: '请先设置最新版本。',
      minimumAboveLatest: '最低版本不能高于最新版本。',
      date: '请输入有效的日期和时间。',
      https: '请输入完整的 https:// 地址。',
      tooLong: '地址过长。',
      notesTooLong: '更新说明最多 {max} 个字符。',
      sha256: '请输入 64 位十六进制字符。',
      sha256WithoutUrl: '请为这个校验值填写下载地址。',
      server: '服务端未接受此值。'
    },
    fixProblems: '请修正标出的字段后再保存。',
    serverField: '（字段：{field}）',
    errors: {
      CLAUDEX_RELEASE_INVALID: '部分发布信息无效，请检查表单后重试。',
      CLAUDEX_SETTING_INVALID: '部分值无效，请检查表单后重试。'
    }
  }
}

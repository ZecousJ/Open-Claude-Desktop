// CLAUDEX: 记忆控制台页面文案（admin.claudexMemory 下的键，R3-S3）。
export default {
  claudexMemory: {
    nav: '记忆',
    title: '记忆',
    description: 'Claudex 桌面端用户的记忆：使用情况与按用户的元数据。记忆正文加密保存，管理员可以清除，但不能查看。',
    refresh: '刷新',
    policyNote: '记忆是否开启、用户可以打开哪些开关以及默认值，在客户端策略中设置。',
    policyLink: '打开客户端策略',
    keyMissing: {
      title: '无法保存记忆',
      body: '服务端没有配置固定加密密钥，用户无法保存记忆。请在服务端环境变量中设置 TOTP_ENCRYPTION_KEY 并重启；在此之前 Claudex 客户端中的记忆不可用。'
    },
    stats: {
      title: '使用情况',
      optedIn: '开启记忆的用户',
      optedInHint: '策略默认开启记忆时，用户改动过开关后才会计入。',
      withMemory: '有记忆的用户',
      documents: '记忆文档',
      edits: '记忆条目',
      size: '存储大小',
      keyReady: '加密密钥',
      ready: '已就绪',
      missing: '缺失'
    },
    user: {
      title: '用户记忆',
      description: '查看单个用户的记忆：每个范围的大小、版本和时间。清除会删除该用户的记忆文档和条目，记忆开关保持不变。',
      pick: '用户',
      pickHint: '搜索用户以查看其记忆。',
      loadFailed: '无法加载该用户的记忆',
      switches: '记忆开关',
      searchChats: '搜索并引用对话',
      generate: '根据聊天记录生成记忆',
      on: '开',
      off: '关',
      notSet: '未设置（按策略默认）',
      changed: '修改于 {time}',
      summary: '{documents} 份文档，{edits} 条条目，{size}',
      empty: '该用户没有已保存的记忆。',
      clear: '清除记忆',
      clearTitle: '清除该用户的记忆？',
      clearMessage: '将删除 {user} 的全部记忆文档和条目，且无法撤销。其记忆开关保持不变；如果仍开着，记忆会从空白重新开始。',
      cleared: '已清除记忆：删除 {documents} 份文档和 {edits} 条条目。',
      userId: '用户 #{id}'
    },
    columns: {
      scope: '范围',
      document: '文档',
      source: '来源',
      revision: '版本',
      edits: '条目',
      updated: '更新时间'
    },
    scope: {
      global: '全局',
      project: '项目 {id}'
    },
    source: {
      user: '用户编辑',
      import: '导入',
      generated: '自动生成',
      none: '—'
    },
    noDocument: '无文档',
    generatedAt: '生成于 {time}',
    overviewWarning: {
      title: '无法保存记忆',
      body: '服务端没有配置固定加密密钥（TOTP_ENCRYPTION_KEY），Claudex 用户无法保存记忆。',
      link: '记忆设置'
    },
    errors: {
      CLAUDEX_MEMORY_USER_NOT_FOUND: '该用户已不存在。',
      CLAUDEX_MEMORY_STORE_FAILED: '服务端无法读取或修改记忆，请稍后再试。'
    }
  }
}

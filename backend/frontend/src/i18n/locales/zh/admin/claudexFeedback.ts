// CLAUDEX: claudexFeedback 控制台页面文案（admin.claudexFeedback 下的键）。
export default {
  claudexFeedback: {
    title: '诊断与反馈',
    description: '桌面端发送的诊断报告与回复反馈。开启之前不会收集任何内容。',
    consentNote: '在你开启之前不会收集任何内容，并且每位用户还需要在 Claudex 应用中同意。',
    collecting: '收集已开启。报告从不包含提示词或回复；只有用户主动附带对话且下方允许对话摘录时，反馈才会包含对话。',
    notCollecting: '两项均已关闭，服务端不接收任何报告。',
    retentionDays: '保留天数',
    perDay: '每位用户每天上限',
    retentionNote: '超过保留期的报告每小时自动删除。数据库备份可能让它们保留更久。',
    fixProblems: '请修正标出的字段后再保存。',
    problems: {
      diagnosticsRetention: '请输入 1 至 365 之间的整数。',
      feedbackRetention: '请输入 1 至 730 之间的整数。',
      perDay: '请输入 1 至 1000 之间的整数。'
    },
    diagnostics: {
      title: '诊断',
      description: '桌面端出错时的错误码以及应用与系统版本。不含提示词、回复或文件路径。',
      empty: '暂无诊断报告。',
      detailTitle: '诊断报告',
      deleteTitle: '删除这条报告？',
      deleteMessage: '报告将被永久删除。',
      deleted: '报告已删除'
    },
    feedback: {
      title: '回复反馈',
      description: '用户对某条回复点赞或点踩，以及用户选择的分类和备注。',
      allowExcerpt: '允许对话摘录',
      allowExcerptHint: '保存用户主动附带在反馈中的对话。关闭时，摘录会被丢弃。',
      empty: '暂无反馈。',
      detailTitle: '反馈',
      noComment: '没有备注。',
      noExcerpt: '未附带。',
      deleteTitle: '删除这条反馈？',
      deleteMessage: '反馈及其对话摘录将被永久删除。',
      deleted: '反馈已删除'
    },
    tabs: {
      diagnostics: '诊断报告',
      feedback: '回复反馈'
    },
    filters: {
      userId: '用户 ID',
      any: '全部',
      kind: '类型',
      anyKind: '全部类型',
      code: '错误码',
      appVersion: '应用版本',
      from: '开始日期',
      to: '结束日期',
      rating: '评价',
      anyRating: '全部评价',
      apply: '筛选',
      reset: '重置'
    },
    kinds: {
      turn_error: '对话出错',
      gateway_refusal: '网关拒绝',
      crash: '崩溃',
      update_failed: '更新失败',
      mcp_start_failed: 'MCP 服务启动失败',
      provision_failed: '设备配置失败'
    },
    ratings: {
      up: '有帮助',
      down: '没有帮助'
    },
    fields: {
      occurredAt: '发生时间',
      receivedAt: '接收时间',
      user: '用户',
      kind: '类型',
      code: '错误码',
      message: '消息',
      model: '模型',
      appVersion: '应用版本',
      codexVersion: 'Codex 版本',
      platform: '平台',
      osVersion: '系统版本',
      requestId: '请求 ID',
      context: '上下文',
      reportId: '报告 ID',
      feedbackId: '反馈 ID',
      rating: '评价',
      categories: '分类',
      comment: '备注',
      excerpt: '对话摘录',
      actions: '操作'
    },
    actions: {
      view: '查看',
      delete: '删除'
    },
    requestId: {
      copy: '复制请求 ID',
      copied: '请求 ID 已复制',
      openOps: '打开运维监控',
      opsHint: '可在那里的系统日志中按客户端请求 ID 搜索。'
    },
    drawer: {
      close: '关闭'
    },
    loadListFailed: '无法加载列表',
    loadDetailFailed: '无法加载详情',
    deleteFailed: '删除失败',
    errors: {
      CLAUDEX_SETTING_INVALID: '部分值无效，请检查表单后重试。',
      CLAUDEX_REPORT_NOT_FOUND: '该报告不存在或已被删除。',
      CLAUDEX_REPORT_FILTER_INVALID: '筛选条件无效，请检查后重试。'
    }
  }
}

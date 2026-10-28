// CLAUDEX: claudexUsageRules 控制台页面文案（admin.claudexUsageRules 下的键）。
// 归 K3（views/admin/claudex/ClaudexUsageRulesView.vue、components/admin/claudex/usage）。
export default {
  claudexUsageRules: {
    title: '用量规则',
    description: '当前会话（5 小时）与按模型的每周限额，对分组内的全部 Key 生效。',
    errors: {
      CLAUDEX_USAGE_RULE_INVALID: '部分规则值无效，请检查表单后重试。',
      CLAUDEX_USAGE_RULE_NOT_FOUND: '该规则已不存在，请重新加载查看当前规则。',
      CLAUDEX_GROUP_NOT_FOUND: '该分组已不存在，请重新加载后选择其他分组。',
      CLAUDEX_USER_NOT_FOUND: '该用户已不存在，请重新加载后选择其他用户。',
      CLAUDEX_NO_PLAN: '该用户没有 Claudex 可用的套餐分组。'
    },
    create: '新建规则',
    rulesTitle: '规则',
    rulesHint:
      '规则限制每个用户在一个窗口内的花费（美元，按实际计费），窗口从该用户的第一次请求开始计算。规则对分组内的全部 Key 生效，包括用户自己创建的 Key。',
    allGroups: '所有分组',
    addToGroup: '添加',
    sectionEmpty: '没有规则。',
    allModels: '全部模型',
    enabled: '启用',
    disabled: '停用',
    shownInClaudex: '在 Claudex 中显示',
    missingGroup: '分组 #{id}',
    groupDeleted: '分组已删除 · 这些规则不再生效',
    deletedGroupOption: '{name}（已删除）',
    columns: {
      label: '名称',
      kind: '类型',
      models: '模型',
      window: '窗口',
      limit: '限额',
      state: '状态',
      sort: '排序',
      actions: '操作'
    },
    kinds: {
      session: '当前会话',
      all_models: '全部模型',
      models: '指定模型'
    },
    kindHints: {
      session: '在 Claudex 中显示为“Current session”，通常为 5 小时。',
      all_models: '限制所有模型的花费，显示在每周限额中。',
      models: '限制与下方模式匹配的模型的花费。'
    },
    window: {
      '5h': '5 小时',
      '24h': '24 小时',
      '7d': '7 天',
      '30d': '30 天',
      custom: '自定义',
      hours: '{n} 小时'
    },
    defaults: {
      sessionLabel: 'Current session',
      allModelsLabel: 'All models'
    },
    validation: {
      kind: '请选择类型。',
      labelRequired: '请输入名称。',
      labelTooLong: '名称不能超过 60 个字符。',
      patternsRequired: '请至少添加一个模型。',
      patternsTooMany: '模式不能超过 50 条。',
      patternEmpty: '请输入模型名。',
      patternTooLong: '不能超过 200 个字符。',
      patternSpaces: '模型名不能包含空格。',
      patternAll: '要限制全部模型，请使用“全部模型”类型。',
      patternWildcard: '* 只能放在末尾，例如 claude-opus-*。',
      patternDuplicate: '每个模式只能出现一次。',
      customHours: '请输入 1–720 的整数小时。',
      limit: '请输入大于 0 的金额。',
      sort: '请输入整数。'
    },
    form: {
      createTitle: '新建用量规则',
      editTitle: '编辑用量规则',
      group: '分组',
      groupHint: '规则对使用该分组 Key 的请求生效。',
      kind: '类型',
      label: '名称',
      labelPlaceholder: '例如 Opus',
      labelHint: '在 Claudex 中显示给用户，最多 60 个字符。',
      patterns: '模型',
      patternsPlaceholder: 'claude-opus-*',
      patternsHint: '精确的模型名，或以 * 结尾的前缀（最多 {max} 条）。请求的模型、计费模型或上游模型任一匹配即计入。',
      window: '窗口',
      customHours: '小时数',
      hours: '小时',
      windowHint: '从该用户的第一次请求开始计算，结束后重新开始。',
      limit: '限额（USD）',
      limitHint: '用户达到限额后请求会被拒绝。',
      sort: '排序',
      sortHint: '数字小的排在前面。',
      enabled: '启用',
      enabledHint: '停用的规则不限制任何人。',
      showInClient: '在 Claudex 中显示',
      showInClientHint: '在用户的用量页面显示此限额；不显示的规则同样生效。',
      save: '保存规则'
    },
    actions: {
      counters: '按用户查看用量',
      edit: '编辑',
      delete: '删除'
    },
    counters: {
      title: '用量：{label}',
      summary: '每 {window} 限额 {limit}。',
      close: '关闭',
      filterUser: '用户',
      user: '用户',
      used: '已用',
      requests: '请求数',
      window: '窗口',
      empty: '还没有人使用这条规则。',
      resetsAt: '{time} 重置',
      startedAt: '{time} 开始',
      windowEnded: '已于 {time} 结束',
      nextWindow: '下一次请求开始新窗口',
      reset: '重置',
      loadFailed: '无法加载用量',
      confirmTitle: '重置这项用量？',
      confirmMessage: '{user} 在 {label} 中的用量将归零，下一次请求开始新的窗口。',
      resetDone: '用量已重置。'
    },
    status: {
      title: '查看用户用量',
      description: '某个用户在 Claudex 中看到的限额与用量。',
      user: '用户',
      group: '分组',
      planGroup: '该用户的套餐分组',
      show: '刷新',
      plan: '套餐分组',
      noPlan: '无',
      balance: '余额',
      updatedAt: '截至 {time}',
      blocked: '该用户已达到限额。',
      blockedUntil: '该用户已达到限额，{time} 前不可用。',
      limit: '限额',
      used: '已用',
      resets: '重置时间',
      empty: '该用户没有适用的限额。',
      notStarted: '未开始',
      pickUser: '选择一个用户以查看其用量。',
      loadFailed: '无法加载该用户的用量',
      sources: {
        rule: '规则',
        subscription: '订阅',
        key: '设备 Key'
      }
    },
    confirm: {
      createTitle: '添加这条规则？',
      saveTitle: '保存这条规则？',
      saveMessage: '规则会立即对 {group} 中的全部 Key 生效，包括用户自己创建的 Key。',
      saved: '规则已保存。',
      deleteTitle: '删除“{label}”？',
      deleteMessage: '它的用量计数会一并删除，之后不再限制任何人。',
      deleted: '规则已删除。'
    }
  }
}

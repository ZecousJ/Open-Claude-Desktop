// CLAUDEX: claudexStatus 控制台页面文案（admin.claudexStatus）。
export default {
  claudexStatus: {
    nav: '服务状态',
    title: '服务状态',
    description: 'Claudex 应用“服务状态”页展示的内容：各渠道（渠道监控，按名称）每日状态条，以及你在这里处理的事件。',
    level: { none: '无数据', operational: '正常', degraded: '性能下降', outage: '故障' },
    status: { investigating: '调查中', identified: '已定位', monitoring: '监控中', resolved: '已解决' },
    impact: { degraded: '性能下降', outage: '重大故障' },
    channels: {
      title: '渠道',
      hint: '数据来自渠道监控（渠道 → 监控），每 5 分钟统计一次，保留 400 天。每天的颜色按可用率：90% 及以上为绿色，80%–90% 为黄色（降级），低于 80% 为红色（故障）；响应慢的检测算作成功。',
      none: '还没有启用的渠道监控。在“渠道 → 监控”中添加后，状态条就会有数据。',
      uptime: '可用率 {x}',
      components: '{n} 个模型'
    },
    incidents: {
      title: '事件',
      hint: '渠道连续两次检测失败时会自动探测到事件，并以草稿形式留在这里：需要你批准后，用户才能在状态页看到。自动探测的事件在渠道恢复后会自动解决；如果你发布过更新，则保持开启，直到你手动标记为已解决。',
      draft: '待批准',
      approve: '批准并上线',
      unpublish: '下线',
      new: '新建事件',
      none: '近 90 天没有事件。',
      auto: '自动',
      started: '开始于 {date}',
      resolved: '解决于 {date}',
      post: '发布更新',
      edit: '编辑',
      history: '更新记录（{n}）',
      deleteTitle: '删除这个事件？',
      deleteMessage: '它会连同更新记录一起从状态页消失。如果只是想结束事件，请改为标记“已解决”。'
    },
    fields: {
      title: '标题',
      platform: '渠道',
      allServices: '所有服务',
      impact: '影响',
      status: '状态',
      message: '说明',
      messageHint: '用户会在标题下看到最新的说明。',
      updateMessage: '本次更新的说明',
      publishNow: '立即上线（用户会在状态页看到）'
    },
    actions: { create: '开启事件', save: '保存', post: '发布', cancel: '取消' },
    saved: '已保存。',
    errors: {
      CLAUDEX_STATUS_INVALID: '请检查填写内容：{message}',
      CLAUDEX_STATUS_INCIDENT_NOT_FOUND: '这个事件已不存在。',
      CLAUDEX_STATUS_UNAVAILABLE: '服务状态需要数据库。'
    }
  }
}

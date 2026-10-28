// CLAUDEX: claudexSharing 控制台页面文案（admin.claudexSharing 下的键，R1-K）。
export default {
  claudexSharing: {
    nav: '分享',
    title: '分享',
    description: '从 Claudex 桌面端分享的对话与 Artifact 公开链接：设置、内容管理与举报处理。',
    storageUnavailable: '此服务器没有用于分享链接的数据库，因此无法使用分享。设置会保留，待可用时生效。',
    offNote:
      '分享已关闭。Claudex 桌面端不显示分享选项，所有公开链接都返回“未找到”。已有链接会保留，重新开启分享后恢复。',
    onNote: '分享已开启。任何拿到链接的人无需登录即可查看。',
    fixProblems: '请先修正标出的字段，再保存。',
    settings: {
      title: '分享',
      description: '允许 Claudex 桌面端用户发布只读快照，任何拿到链接的人都能查看。',
      enabled: '允许分享',
      conversations: '对话',
      conversationsHint: '分享对话或会话的快照：只含提示与回复，不含命令及其输出。',
      artifacts: 'Artifact',
      artifactsHint: '把单个 Artifact（HTML、SVG、Markdown、图表或代码）发布为独立页面。',
      allowReports: '举报按钮',
      allowReportsHint: '访客可以举报分享页面，举报会出现在下方“举报”中。'
    },
    links: {
      title: '链接',
      description: '链接在读取时拼出，修改地址后所有已有链接会自动更新。',
      publicBaseUrl: '公开地址',
      publicBaseUrlHint: '公开页面所在地址，例如 https://share.example.com。留空则使用服务器的前端地址。',
      effective: '当前链接以 {url} 开头',
      sources: {
        setting: '在此处设置。',
        frontend_url: '来自服务器的前端地址。',
        none: '未设置地址，Claudex 桌面端会用它登录的服务器地址拼出链接。'
      },
      contentBaseUrl: '独立内容地址',
      contentBaseUrlHint:
        '可选。Artifact 文档从这个主机提供，与控制台隔离。需要先设置公开地址，且主机不同、能访问到本服务器。',
      usagePolicyUrl: '使用政策链接',
      usagePolicyUrlHint: '分享弹窗中引用的链接。留空则使用本服务器的使用政策文档。',
      effectivePolicy: '分享弹窗链接到 {url}',
      noPolicy: '未设置使用政策，分享弹窗不显示政策链接。'
    },
    limits: {
      title: '限制',
      maxSnapshot: '单个对话大小上限（KiB）',
      maxArtifact: '单个 Artifact 大小上限（KiB）',
      maxActive: '每个用户的链接数上限',
      ttl: '链接有效期（天）',
      ttlHint: '0 表示永不过期。只对保存后新建或更新的链接生效。'
    },
    problems: {
      baseUrl: '请输入不带查询参数和片段的 https:// 地址（http:// 仅限本机）。',
      httpsUrl: '请输入完整的 https:// 地址。',
      requiresPublicBase: '请先设置公开地址。',
      sameHost: '请使用与公开地址不同的主机。',
      snapshotSize: '请输入 64 到 32768 之间的整数。',
      artifactSize: '请输入 16 到单个对话上限之间的整数。',
      activePerUser: '请输入 1 到 100000 之间的整数。',
      ttlDays: '请输入 0 到 3650 之间的整数。'
    },
    tabs: {
      shares: '分享链接',
      reports: '举报',
      artifactReports: 'Artifact 举报',
      blocks: '已禁止的用户'
    },
    kinds: {
      conversation: '对话',
      artifact: 'Artifact'
    },
    statuses: {
      active: '公开',
      disabled: '已下架',
      revoked: '已删除',
      expired: '已过期'
    },
    fields: {
      title: '标题',
      kind: '类型',
      author: '作者',
      status: '状态',
      views: '浏览',
      reports: '举报',
      size: '大小',
      created: '分享时间',
      expires: '过期时间',
      actions: '操作',
      reason: '原因',
      detail: '详情',
      share: '分享链接',
      artifact: 'Artifact',
      reported: '举报时间',
      user: '用户',
      blockedAt: '禁止时间',
      untitled: '无标题',
      never: '永不'
    },
    filters: {
      status: '状态',
      liveStatuses: '公开和已下架',
      kind: '类型',
      anyKind: '全部类型',
      userId: '用户 ID',
      any: '全部',
      search: '搜索',
      searchPlaceholder: '标题或作者邮箱',
      apply: '应用',
      reset: '重置',
      anyStatus: '全部状态'
    },
    shares: {
      empty: '没有分享链接。',
      loadFailed: '无法加载分享链接',
      takenDownReason: '原因：{reason}'
    },
    actions: {
      open: '打开',
      review: '查看内容',
      takeDown: '下架',
      restore: '恢复',
      delete: '删除',
      blockAuthor: '禁止作者分享',
      dismiss: '驳回',
      unblock: '解除禁止',
      takeDownAll: '下架全部链接',
      resolve: '标为已处理',
      block: '禁止'
    },
    reason: {
      label: '原因（可选）',
      placeholder: '例如：包含个人信息',
      hint: '随链接保存，作者可在 Claudex 桌面端看到。',
      tooLong: '原因请少于 500 个字符。'
    },
    confirm: {
      takeDownTitle: '下架这个链接？',
      takeDownMessage: '“{title}”将不再公开，页面会显示内容已被管理员移除。之后可以恢复。',
      restoreTitle: '恢复这个链接？',
      restoreMessage: '“{title}”会重新对所有拿到链接的人公开。',
      deleteTitle: '删除这个链接？',
      deleteMessage: '“{title}”的快照将被永久删除，链接随即失效，无法撤销。',
      blockTitle: '禁止 {user} 分享？',
      blockMessage: '该用户将无法新建或更新分享链接。已有链接仍然在线，如需下架请另行操作。',
      unblockTitle: '允许 {user} 重新分享？',
      unblockMessage: '在分享开启时，该用户可以重新创建分享链接。',
      takeDownAllTitle: '下架 {user} 的全部链接？',
      takeDownAllMessage: '该用户的所有公开链接都会被下架，之后可以逐个恢复。',
      dismissTitle: '驳回这条举报？',
      dismissMessage: '举报将被关闭，链接保持在线。',
      reportTakeDownTitle: '下架被举报的链接？',
      reportTakeDownMessage: '“{title}”将被下架，关于它的所有待处理举报都会关闭。之后可以恢复。',
      artifactDismissMessage: '举报将被关闭，不做处理。',
      artifactResolveTitle: '将这条举报标为已处理？',
      artifactResolveMessage: '在你已处理后使用，例如禁止了该账号。Artifact 本身在举报人的电脑上，不在此服务器。'
    },
    toasts: {
      takenDown: '链接已下架',
      restored: '链接已恢复',
      deleted: '链接已删除',
      blocked: '已禁止该用户分享',
      unblocked: '该用户可以重新分享',
      takenDownAll: '已下架 {count} 个链接',
      dismissed: '举报已驳回',
      resolved: '举报已处理',
      actionFailed: '操作未完成'
    },
    content: {
      title: '查看分享内容',
      loadFailed: '无法加载分享内容',
      user: '用户',
      assistant: 'Claude',
      activity: '活动',
      artifacts: 'Artifact',
      artifactRef: 'Artifact {n}',
      model: '模型',
      mode: '模式',
      empty: '这个快照没有消息。',
      note: '以纯文本显示。公开页面会渲染 Markdown，并在沙箱中运行 Artifact。'
    },
    reports: {
      empty: '没有举报。',
      loadFailed: '无法加载举报',
      noDetail: '无详情。',
      reasons: {
        illegal: '违法内容',
        harmful: '有害内容',
        privacy: '个人信息',
        spam: '垃圾信息',
        other: '其他'
      },
      categories: {
        child_safety: '儿童安全/性虐待',
        fraud: '欺诈',
        sexually_explicit_content: '色情内容',
        non_consensual_intimate_imagery: '未经同意的私密影像',
        violence_and_hate: '暴力和/或仇恨言论',
        illegal_goods: '违禁商品',
        defamation: '诽谤',
        other_illegal: '其他违法或非法内容',
        violation_of_terms: '违反条款或使用政策'
      },
      reporter: '举报人：{who}',
      optedOut: '已选择不用于训练',
      optedOutHint: '举报人已选择退出：请勿使用此举报训练模型。',
      statuses: {
        open: '待处理',
        resolved: '已下架',
        dismissed: '已驳回'
      },
      reportsOff: '举报按钮已关闭，访客无法提交新的举报。'
    },
    artifactReports: {
      description: '来自 Claudex 应用中“举报 Artifact”的举报。Artifact 在举报人的电脑上，所以每条举报都保存了一份副本。',
      empty: '没有 Artifact 举报。',
      loadFailed: '无法加载 Artifact 举报',
      reportsOff: '举报按钮已关闭，应用无法提交新的 Artifact 举报。',
      reviewTitle: '查看被举报的 Artifact',
      reviewNote: '副本以纯文本显示，不会运行。',
      copyLoadFailed: '无法加载 Artifact 副本',
      copyCut: '副本只包含 {total} 中的前 {size}。',
      noCopy: '没有文本副本：这是一个 {total} 的二进制文件。',
      statuses: {
        open: '待处理',
        resolved: '已处理',
        dismissed: '已驳回'
      }
    },
    blocks: {
      description: '被禁止的用户无法新建或更新分享链接，但仍可查看并停止自己已有的链接。',
      addTitle: '禁止用户分享',
      userId: '用户 ID',
      invalidUser: '请输入用户 ID。',
      empty: '没有被禁止的用户。',
      loadFailed: '无法加载被禁止的用户'
    },
    errors: {
      CLAUDEX_SHARE_NOT_FOUND: '该分享链接已不存在，列表已刷新。',
      CLAUDEX_SHARE_REPORT_NOT_FOUND: '该举报已不存在，列表已刷新。',
      CLAUDEX_SHARING_UNAVAILABLE: '此服务器没有用于分享链接的数据库。',
      CLAUDEX_USER_NOT_FOUND: '没有这个 ID 的用户。',
      CLAUDEX_SHARE_INVALID: '原因太长。',
      CLAUDEX_SHARE_REPORT_INVALID: '原因太长。',
      CLAUDEX_SHARE_FILTER_INVALID: '有筛选条件无效。',
      CLAUDEX_SHARING_STORE_FAILED: '无法读取或保存分享链接，请稍后再试。',
      CLAUDEX_SHARING_SETTINGS_FAILED: '无法读取或保存分享设置。'
    }
  }
}

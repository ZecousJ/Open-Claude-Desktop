// CLAUDEX: 网页版控制台页面文案（admin.claudexWeb 下的键，W-ADMIN1）。
export default {
  claudexWeb: {
    nav: '网页版',
    title: '网页版',
    description: '谁可以使用 Claudex 网页版、运行的并发与时长限制，以及承载运行的 runner。',
    fixProblems: '请修正标红的字段后再保存。',
    signInNote: '网页版的登录选项（邮箱验证码、隐私政策）在“通用”页面。',
    signInLink: '打开通用',
    access: {
      title: '访问',
      description: '开启或关闭网页版，并选择谁可以使用。开启时管理员始终可以登录。关闭后正在使用的人会被断开。',
      mode: '谁可以使用',
      off: '关闭',
      allowlist: '管理员和名单中的用户',
      everyone: '所有人',
      offHint: '网页版已关闭，任何人都无法登录，管理员也不例外。',
      allowlistHint: '管理员，加上下面名单中的用户。名单留空则只有管理员可以使用。',
      everyoneHint: '所有启用状态的用户都可以登录网页版。',
      offNote: '保存后网页版将关闭，正在使用的人会在一分钟内被断开。',
      maxSessions: '每位用户的会话数',
      maxSessionsHint: '同时最多 1 到 50 个浏览器会话。超过上限再登录会结束最早的会话。',
      emails: '允许的邮箱',
      emailsPlaceholder: "name{'@'}example.com",
      emailsHint: '按回车或逗号添加，最多 1000 个。',
      userIds: '允许的用户 ID',
      userIdsPlaceholder: '用户 ID',
      userIdsHint: '“用户”页面中的编号，最多 1000 个。'
    },
    limits: {
      title: '运行限制',
      description: 'runner 上同时可以运行多少个对话，以及每个运行最长多久。',
      maxConcurrent: '同时运行数（所有用户）',
      maxConcurrentHint: '所有用户合计 1 到 500 个运行。新的运行需等待空闲名额。',
      maxConcurrentPerUser: '同时运行数（单个用户）',
      maxConcurrentPerUserHint: '1 到 20，不能超过所有用户的上限。',
      maxSessionMinutes: '单次运行最长时间（分钟）',
      maxSessionMinutesHint: '1 到 1440。运行达到这个时长会被停止。',
      minutePriceUsd: 'Runner 每分钟价格（美元）',
      minutePriceUsdHint: '0 到 100。仅供参考：runner 时间只记录，不计费。'
    },
    runners: {
      title: 'Runner',
      description:
        'Runner 是运行网页版对话的程序。本地 runner 与服务器在同一台机器上；添加 runner 可用独立令牌接入另一台机器。',
      add: '添加 runner',
      name: '名称',
      status: '状态',
      version: '版本',
      capacity: '容量',
      users: '用户',
      lastSeen: '最近在线',
      actions: '操作',
      empty: '还没有 runner。',
      localRunner: '与服务器在同一台机器',
      created: '添加于 {date}',
      now: '当前在线',
      neverSeen: '从未接入',
      status_online: '在线',
      status_offline: '离线',
      status_disabled: '已停用',
      status_revoked: '已吊销',
      statusDraining: '排空中',
      capacityValue: '{engines} 个引擎，{users} 位用户',
      loadValue: '使用 {engines} 个引擎，{users} 位用户',
      summary: '当前 {runs} 个运行，{tabs} 位用户打开着网页版。',
      noLocal: '本服务器没有配置本地 runner。',
      disable: '停用',
      enable: '启用',
      disableTitle: '停用这个 runner？',
      disableMessage: '“{name}”会立即断开，启用之前无法再接入。它的令牌仍然有效。其上的运行会停止。',
      disabledDone: '已停用“{name}”。',
      enabledDone: '已启用“{name}”，可以重新接入。',
      rename: {
        action: '重命名',
        title: '重命名 runner',
        submit: '重命名',
        done: '已重命名。'
      },
      drain: {
        action: '排空',
        title: '排空这个 runner？',
        message: '“{name}”会做完手头的工作，不再接收新用户，其用户会转到其他 runner。',
        done: '“{name}”正在排空。'
      },
      revoke: {
        action: '吊销',
        title: '吊销这个 runner？',
        message: '“{name}”的令牌将永久失效，runner 会被断开。此操作无法撤销。',
        done: '已吊销“{name}”。'
      },
      create: {
        title: '添加 runner',
        submit: '生成令牌',
        namePlaceholder: '例如：办公室服务器',
        nameHint: '用来区分 runner 的名称，最多 100 个字符。',
        createdFor: '已为“{name}”生成令牌。',
        token: 'Runner 令牌',
        copy: '复制',
        copied: '已复制',
        copiedToast: '令牌已复制',
        onceNotice: '请现在复制令牌并填入 runner 的配置。令牌只显示这一次，服务器只保存哈希，之后无法再次显示。',
        done: '完成'
      }
    },
    problems: {
      sessionsPerUser: '请输入 1 到 50 的整数。',
      listTooLong: '名单最多 1000 项。',
      perUser: '请输入 1 到 20 的整数。',
      concurrent: '请输入 1 到 500 的整数。',
      perUserOverTotal: '不能超过所有用户的上限。',
      minutes: '请输入 1 到 1440 的整数。',
      price: '请输入 0 到 100 的价格。',
      email: "请输入形如 name{'@'}example.com 的邮箱。",
      userId: '请输入用户 ID（大于 0 的整数）。',
      runnerName: '请输入 1 到 100 个字符的名称。'
    },
    errors: {
      CLAUDEX_WEB_SETTINGS_INVALID: '网页版设置中有无效的值，请检查表单后重试。',
      CLAUDEX_WEB_SETTINGS_CONFLICT: '另一位管理员先修改了这些设置。表单现在显示已保存的内容，请重新修改。',
      CLAUDEX_WEB_USAGE_SETTINGS_INVALID: '运行限制中有无效的值，请检查表单后重试。',
      CLAUDEX_WEB_USAGE_SETTINGS_CONFLICT: '另一位管理员先修改了这些限制。表单现在显示已保存的内容，请重新修改。',
      CLAUDEX_WEB_RUNNER_INVALID: '请为 runner 填写 1 到 100 个字符的名称。',
      CLAUDEX_WEB_RUNNER_NOT_FOUND: '这个 runner 已不存在或已被吊销。',
      CLAUDEX_WEB_RUNNERS_UNAVAILABLE: 'Runner 列表暂时不可用，请稍后重试。',
      CLAUDEX_SETTING_INVALID: '有无效的值，请检查表单后重试。'
    }
  }
}

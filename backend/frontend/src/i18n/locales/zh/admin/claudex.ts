// CLAUDEX: Claudex 管理页面文案（admin.claudex 下的键）。各控制台页面有自己的模块
// （admin.claudexPolicy、admin.claudexModels 等）。
export default {
  claudex: {
    nav: {
      root: 'Claudex',
      overview: '概览',
      policy: '客户端策略',
      models: '模型目录',
      devices: '设备',
      usageRules: '用量规则',
      release: '桌面端发布',
      voice: '语音',
      feedback: '诊断与反馈',
      general: '通用'
    },
    common: {
      save: '保存',
      saving: '正在保存…',
      saved: '已保存',
      saveFailed: '无法保存更改',
      loading: '正在加载…',
      loadFailed: '无法加载此页面',
      retry: '重试',
      reload: '重新加载',
      unsavedChanges: '有尚未保存的更改。',
      inherit: '继承',
      required: '此项为必填。',
      https: '请输入完整的 https:// 地址。',
      urlTooLong: '地址过长。',
      notAvailable: '此版本尚未提供此页面。',
      notAvailableHint: '当前版本的 Claudex 服务端与控制台还不包含此功能，部署包含它的版本后会在这里显示。',
      tags: {
        placeholder: '输入后按回车添加',
        add: '添加',
        remove: '移除 {value}',
        duplicate: '列表中已有该值。',
        limit: '最多可添加 {max} 个值。',
        empty: '尚未添加。'
      }
    },
    errors: {
      CLAUDEX_SETTING_INVALID: '部分值无效，请检查表单后重试。',
      CLAUDEX_GROUP_NOT_FOUND: '该分组已不存在，请重新加载后选择其他分组。',
      CLAUDEX_USER_NOT_FOUND: '该用户已不存在，请重新加载后选择其他用户。'
    },
    overview: {
      title: 'Claudex',
      description: 'Claudex 桌面端服务的服务器状态。终端用户通过 Claudex 桌面端登录，此控制台仅供管理员使用。',
      refresh: '刷新',
      loadFailed: '无法加载 Claudex 概览',
      server: '服务器',
      serverVersion: '版本',
      buildType: '构建类型',
      apiVersion: 'Claudex API 版本',
      upstream: '基于 Sub2API',
      upstreamCommit: '上游提交',
      license: '服务器是修改版 Sub2API（LGPL-3.0），源码和修改清单随 Claudex 一起提供。',
      features: '服务器功能',
      featuresEmpty: '此版本尚未安装 Claudex 服务器功能。',
      settingKeys: '设置键',
      noSettings: '无设置'
    },
    selfUpdate: {
      disabled: '在线更新已关闭',
      disabledHint:
        '此服务器运行的是 Claudex 版 Sub2API。请通过部署新的 Claudex 后端版本来更新；安装上游 Sub2API 版本会丢失 Claudex 的修改。'
    },
    directory: {
      title: '目录提交',
      description: '审核 Claudex 用户的提交。',
      notes: '审核者备注', approve: '批准', reject: '拒绝', empty: '暂无提交。',
      status: { submitted: '已提交，等待审核', in_review: '审核中', approved: '已批准', rejected: '已拒绝' }
    }
  }
}

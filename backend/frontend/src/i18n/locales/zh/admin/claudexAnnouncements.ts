// CLAUDEX: claudexAnnouncements 控制台页面文案（admin.claudexAnnouncements）。
export default {
  claudexAnnouncements: {
    nav: '公告弹窗',
    title: '公告弹窗与邮件',
    description:
      'Claudex 向每位登录用户弹出一次的公告弹窗，以及发给指定用户的邮件通知。弹窗使用标准版式：只需填写标题、正文、按钮和（可选的）配图。',
    tabs: { popups: '弹窗', mail: '邮件' },
    status: { draft: '草稿', published: '已发布', withdrawn: '已下架', expired: '已到期' },
    popups: {
      intro: '弹窗对每个人只出现一次（桌面端和网页版），无论点了哪个按钮都不会再弹。到期后自动下架，看没看过都一样。',
      new: '新建弹窗',
      none: '还没有弹窗。',
      untitled: '未命名',
      reads: '{n} 人已关闭',
      until: '展示至 {date}',
      endedOn: '{date} 结束',
      updatedOn: '{date} 编辑',
      publish: '发布',
      withdraw: '下架',
      deleteTitle: '删除这条弹窗？',
      deleteMessage: '正在展示的弹窗会立即消失，谁关闭过它的记录也会一并删除。'
    },
    fields: {
      badge: '角标（可选）',
      title: '标题',
      body: '正文',
      bodyHint: '每一行是一段。标题、按钮和配图沿用标准弹窗版式。',
      bodyHtml: '正文（HTML）',
      bodyHintHtml: '可自带 <style> 的 HTML。它在无脚本的框架中渲染，样式随你定，但不能运行代码。',
      useHtml: '改写自定义 HTML',
      useTemplate: '改用纯文本',
      image: '配图（可选）',
      imageHint: 'https:// 地址。配图占卡片右半边；不配图则是单栏卡片。',
      primaryLabel: '按钮文字',
      primaryUrl: '按钮链接（可选）',
      primaryUrlHint: '填了链接：弹窗有该按钮和一个“Not now”按钮；不填：只有一个“Done”按钮。',
      dismissLabel: '次按钮文字',
      resetReads: '让已经关闭过的人再看一次'
    },
    publish: { duration: '发布时长', extend: '保存并重新发布' },
    durations: { day: '1 天', threeDays: '3 天', week: '1 周', twoWeeks: '2 周', month: '30 天' },
    preview: {
      title: '预览',
      light: '浅色',
      dark: '深色',
      frame: '公告内容',
      dismissDefault: 'Not now',
      doneDefault: 'Done',
      openDefault: 'Open',
      note: '这就是弹窗在应用里的样子，这里的按钮不会执行操作。'
    },
    mail: {
      off: '服务尚未配置 SMTP，无法发送邮件。请先在设置里配置 SMTP。',
      subject: '主题',
      body: '正文（HTML）',
      bodyHint: '和邮件一样的 HTML。请用行内样式：很多邮件客户端会忽略 <style>。',
      recipients: '发送给',
      searchPlaceholder: '按邮箱搜索用户…',
      addAll: '添加所有启用用户',
      clear: '清空',
      count: '已选 {n} / {max}',
      tooMany: '一次最多发送给 {max} 人。',
      send: '发送邮件',
      confirmTitle: '发送这封邮件？',
      confirmMessage: '将发送给 {n} 人，发出后无法撤回。',
      history: '已发送',
      none: '还没有发送记录。',
      state: { sending: '发送中', done: '已完成' },
      progress: '已发 {sent}，失败 {failed}，共 {total}',
      previewNote: '各邮件客户端渲染 HTML 略有差异，版式请尽量简单。'
    },
    toasts: {
      saved: '已保存。',
      published: '已发布。',
      withdrawn: '已下架。',
      deleted: '已删除。',
      mailQueued: '正在发送给 {n} 人。',
      actionFailed: '操作没有成功，请重试。'
    },
    errors: {
      CLAUDEX_ANNOUNCEMENT_NOT_FOUND: '这条弹窗已不存在。',
      CLAUDEX_ANNOUNCEMENT_MAIL_OFF: '服务无法发送邮件：请先在设置里配置 SMTP。'
    }
  }
}

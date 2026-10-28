// CLAUDEX: claudexVoice 控制台页面文案（admin.claudexVoice 下的键）。
export default {
  claudexVoice: {
    title: '语音',
    description: 'Claudex 桌面端的听写，经实时语音识别服务提供。',
    transcription: {
      title: '听写',
      description: '输入框中的语音转文字。桌面端把麦克风音频流式发送到本服务器，再由服务器用下面的密钥转发到识别服务。'
    },
    upstreamUrl: '识别服务地址',
    upstreamUrlHint: 'wss:// 地址（ws:// 仅限 localhost）。密钥放在 Authorization 请求头中，不会出现在地址里。',
    apiKey: 'API 密钥',
    keyStored: '已保存密钥',
    keyNotStored: '尚未保存密钥。添加密钥之前无法开启听写。',
    keyWillBeRemoved: '保存后将删除已保存的密钥，并关闭听写。',
    removeKey: '删除密钥',
    undoRemoveKey: '撤销',
    apiKeyPlaceholder: '输入 API 密钥',
    apiKeyReplacePlaceholder: '输入新密钥以替换已保存的密钥',
    apiKeyHint: '只写。密钥在本服务器加密保存，之后不会再显示，也不会下发到桌面端。',
    cannotStoreKey: '本服务器需要先配置固定的密钥加密密钥，才能保存密钥。',
    maxSession: '单次会话最长时长（秒）',
    maxSessionHint: '10 至 3600。超过该时长后听写会话结束。',
    maxAudio: '单次会话最多音频（秒）',
    maxAudioHint: '一次会话发送给识别服务的音频，1 至 3600 秒。',
    idleTimeout: '空闲超时（秒）',
    idleTimeoutHint: '5 至 300。在该时长内没有音频或文字往来时关闭会话。',
    billing:
      '按音频时长以模型 {model} 计费：{bytes} 字节为 1 秒（{format}，{rate} Hz，{channels} 声道）。价格由各分组的 audio_stt_price_per_hour 决定。',
    problems: {
      upstreamUrl: '请输入 wss:// 地址，不能包含凭据、片段或放在查询参数里的密钥。',
      apiKey: '请输入 8 至 512 个字符且不含空格的密钥。',
      keyRequired: '请先添加 API 密钥，再开启听写。',
      sessionSeconds: '请输入 10 至 3600 之间的整数。',
      audioSeconds: '请输入 1 至 3600 秒之间的时长。',
      idleSeconds: '请输入 5 至 300 之间的整数。'
    },
    fixProblems: '请修正标出的字段后再保存。',
    sessions: {
      title: '听写会话',
      description: '每次会话按发送的音频计费，以每秒 32,000 字节估算时长。可按请求 ID 与用量记录对照。',
      userId: '用户 ID',
      anyUser: '全部用户',
      apply: '筛选',
      clear: '清除',
      columns: {
        time: '时间',
        user: '用户',
        requestId: '请求 ID',
        audio: '音频',
        duration: '会话时长',
        cost: '费用',
        ended: '结束原因'
      },
      notBilled: '未计费',
      endReasons: {
        finished: '正常结束',
        client_closed: '客户端关闭',
        upstream_closed: '服务端关闭',
        upstream_failed: '服务出错',
        idle_timeout: '空闲超时',
        max_bytes: '达到音频上限',
        max_duration: '达到时长上限',
        bad_start: '开始消息无效',
        canceled: '服务器停止'
      },
      minutesSeconds: '{minutes} 分 {seconds} 秒',
      seconds: '{seconds} 秒',
      empty: '暂无听写会话。',
      loadFailed: '无法加载听写会话'
    },
    errors: {
      CLAUDEX_VOICE_INVALID: '部分语音设置无效，请检查表单后重试。',
      CLAUDEX_SETTING_INVALID: '部分值无效，请检查表单后重试。'
    }
  }
}

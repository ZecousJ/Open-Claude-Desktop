package com.claudex.core

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

interface ClaudexRepository {
    val snapshot: StateFlow<Snapshot>
    val connection: StateFlow<Connection>
    suspend fun refresh()
    suspend fun send(input: SendInput): String
    suspend fun steerTurn(conversationId: String, text: String, attachments: List<Attachment>): SteerResult? = null
    suspend fun interrupt(conversationId: String)
    suspend fun attach(name: String, mime: String, bytes: ByteArray): Attachment
    suspend fun updateConversation(id: String, title: String? = null, pinned: Boolean? = null, archived: Boolean? = null, unread: Boolean? = null)
    /** Code session menu "Change model": the session's model from its next message on (a running turn is not interrupted). */
    suspend fun setConversationModel(id: String, providerId: String, model: String)
    /** Adds the conversation to a project, or removes it from its project with null. */
    suspend fun moveConversation(id: String, projectId: String?)
    suspend fun retryResponse(id: String, turnId: String, providerId: String, model: String)
    suspend fun editPrompt(id: String, turnId: String, text: String, providerId: String, model: String)
    suspend fun selectVersion(id: String, turnId: String, versionTurnId: String, prompt: Boolean)
    suspend fun setReplyFeedback(id: String, turnId: String, rating: String?)
    suspend fun deleteConversation(id: String)
    suspend fun readGeneratedFile(file: GeneratedFile): ByteArray
    suspend fun deleteProject(id: String)
    suspend fun saveProject(project: Project)
    suspend fun signOut()
}

/** Explicit offline fixture backend. Every response identifies itself as a local simulation. */
class DemoRepository(private val scope: CoroutineScope, initial: Snapshot = DemoFixtures.snapshot()): ClaudexRepository {
    private val state = MutableStateFlow(initial)
    override val snapshot = state.asStateFlow()
    private val link = MutableStateFlow<Connection>(Connection.Connected)
    override val connection = link.asStateFlow()
    private val generation = SessionEpoch()
    private val jobs = mutableMapOf<String, Job>()
    var failNextSend: Boolean = false
    override suspend fun refresh() { link.value = Connection.Connected }
    override suspend fun send(input: SendInput): String {
        val id = input.conversationId ?: newId()
        if (jobs[id]?.isActive == true) throw ApiException("BUSY", "请先停止当前回复")
        // Local-only demonstration of an acknowledgement arriving after the pending UI appears.
        delay(1200)
        require(input.text.isNotBlank() || input.attachments.isNotEmpty()) { "请输入消息或添加附件" }
        if (failNextSend) { failNextSend = false; throw ApiException("DEMO_NETWORK", "模拟网络中断。草稿已保留，可手动重试") }
        check(link.value is Connection.Connected) { "当前离线，请连接后重试" }
        if (jobs[id]?.isActive == true) throw ApiException("BUSY", "请先停止当前回复")
        val turnId = newId()
        val old = state.value.conversations.find { it.id == id } ?: Conversation(id, input.text.take(26).ifBlank { "附件分析" }, input.mode, input.model.providerId, input.model.id, projectId = input.projectId)
        val turn = Turn(turnId, input.text, input.attachments, status = TurnStatus.IN_PROGRESS)
        replace(old.copy(turns = old.turns + turn, updatedAt = System.currentTimeMillis()))
        val epoch = generation.value
        jobs[id] = scope.launch {
            val worker = currentCoroutineContext()[Job]
            val result = if (input.mode == Mode.CODE) "本地演示 · 这不是云端执行结果。\n\n已收到代码任务：${input.text}\n\n正式连接后，任务会在服务器分配的云端工作区执行。这里不会启动手机终端、提交代码或发布应用。" else "本地演示 · 这是一段用于测试原生流式界面的回复。\n\n关于「${input.text.ifBlank { "分析附件" }}」，可以先明确目标，再整理关键内容，最后逐步验证结果。\n\n附件：${input.attachments.size} 个。演示模式不会上传文件或调用模型。\n\n你可以继续追问、停止生成，或从历史记录重新打开这段对话。"
            try {
                for (length in 0..result.length step 7) {
                    delay(45)
                    if (!generation.accepts(epoch)) return@launch
                    patchTurn(id, turnId) { it.copy(items = it.items.filter { item -> item.type == "userMessage" } + Item("$turnId-answer", "agentMessage", result.take(length))) }
                }
                // A complete snapshot can synchronously start queued work: release this worker first.
                if (jobs[id] === worker) jobs.remove(id)
                patchTurn(id, turnId) { it.copy(items = it.items.filter { item -> item.type == "userMessage" } + Item("$turnId-answer", "agentMessage", result), status = TurnStatus.COMPLETED) }
            } catch (cancelled: CancellationException) { throw cancelled }
            finally { if (jobs[id] === worker) jobs.remove(id) }
        }
        return id
    }
    override suspend fun interrupt(conversationId: String) {
        jobs[conversationId]?.cancelAndJoin()
        val c = state.value.conversations.find { it.id == conversationId } ?: return
        replace(c.copy(turns = c.turns.map { if (it.status == TurnStatus.IN_PROGRESS) it.copy(status = TurnStatus.INTERRUPTED) else it }))
    }
    override suspend fun steerTurn(conversationId: String, text: String, attachments: List<Attachment>): SteerResult? {
        val current = state.value.conversations.find { it.id == conversationId } ?: return null
        if (current.turns.none { it.status == TurnStatus.IN_PROGRESS } || current.mode == Mode.CHAT || attachments.isNotEmpty()) return null
        val messageId = "demo-steer-${newId()}"
        val turn = current.turns.last { it.status == TurnStatus.IN_PROGRESS }
        // Local simulation: the next snapshot records that the running turn read the instruction.
        patchTurn(conversationId, turn.id) { it.copy(items = it.items + Item(messageId, "userMessage", text,
            rawJson = """{"id":"$messageId","type":"userMessage","steered":true,"clientId":"$messageId"}""")) }
        return SteerResult(messageId, state.value.conversations.first { it.id == conversationId })
    }
    override suspend fun attach(name: String, mime: String, bytes: ByteArray): Attachment {
        AttachmentPolicy.validate(name, bytes.size.toLong(), 0)
        return Attachment(newId(), name, "local-only", if (mime.startsWith("image/")) "image" else if (mime.startsWith("text/")) "text" else "document", bytes.size.toLong(), mime)
    }
    override suspend fun updateConversation(id: String, title: String?, pinned: Boolean?, archived: Boolean?, unread: Boolean?) {
        val c = state.value.conversations.find { it.id == id } ?: return
        replace(c.copy(title = title?.trim()?.takeIf { it.isNotEmpty() } ?: c.title, pinned = pinned ?: c.pinned, archived = archived ?: c.archived, unread = unread ?: c.unread))
    }
    override suspend fun setConversationModel(id: String, providerId: String, model: String) {
        val c = state.value.conversations.find { it.id == id } ?: return
        require(c.mode == Mode.CODE && state.value.models.any { it.id == model && it.providerId == providerId })
        replace(c.copy(providerId = providerId, model = model))
    }
    override suspend fun moveConversation(id: String, projectId: String?) {
        val c = state.value.conversations.find { it.id == id } ?: return
        require(projectId == null || state.value.projects.any { it.id == projectId })
        replace(c.copy(projectId = projectId))
    }
    override suspend fun retryResponse(id: String, turnId: String, providerId: String, model: String) = branch(id, turnId, null, providerId, model)
    override suspend fun editPrompt(id: String, turnId: String, text: String, providerId: String, model: String) = branch(id, turnId, text, providerId, model)
    private suspend fun branch(id: String, turnId: String, text: String?, providerId: String, model: String) {
        val c = state.value.conversations.first { it.id == id }
        require(c.turns.none { it.status == TurnStatus.IN_PROGRESS }) { "请先停止当前回复" }
        val index = c.turns.indexOfFirst { it.id == turnId }; require(index >= 0)
        val old = c.turns[index]; require(!old.compaction)
        val group = old.promptGroupId ?: TurnVersions.responseGroup(old)
        val response = if (text == null) TurnVersions.responseGroup(old) else newId()
        replace(c.copy(turns = c.turns.take(index), activeBranchId = newId(), branchVisit = c.branchVisit + 1,
            savedBranches = c.savedBranches + ConversationBranch(c.activeBranchId ?: "original", c.turns, c.branchVisit)))
        send(SendInput(id, text ?: old.prompt, c.mode, ModelOption(model, model, "本地演示", providerId), old.attachments, c.projectId))
        val current = state.value.conversations.first { it.id == id }
        replace(current.copy(turns = current.turns.dropLast(1) + current.turns.last().copy(responseGroupId = response, promptGroupId = group, promptVersionId = if (text == null) old.promptVersionId ?: TurnVersions.responseGroup(old) else response)))
    }
    override suspend fun selectVersion(id: String, turnId: String, versionTurnId: String, prompt: Boolean) {
        val c = state.value.conversations.first { it.id == id }
        require(c.turns.none { it.status == TurnStatus.IN_PROGRESS })
        val t = c.turns.first { it.id == turnId }
        val v = TurnVersions.versions(c, t, prompt).first { it.turnId == versionTurnId }
        if (v.turnId == turnId) return
        val next = c.savedBranches.first { it.id == v.branchId }
        replace(c.copy(turns = next.turns, activeBranchId = next.id, branchVisit = maxOf(c.branchVisit, next.visited) + 1,
            savedBranches = c.savedBranches.filterNot { it.id == next.id } + ConversationBranch(c.activeBranchId ?: "original", c.turns, c.branchVisit)))
    }
    override suspend fun setReplyFeedback(id: String, turnId: String, rating: String?) {
        require(rating == null || rating in listOf("up", "down"))
        val key = feedbackKey(id, turnId)
        state.update { it.copy(replyFeedback = if (rating == null) it.replyFeedback - key else it.replyFeedback + (key to rating)) }
    }
    override suspend fun deleteConversation(id: String) {
        jobs[id]?.cancelAndJoin(); jobs.remove(id)
        state.update { it.copy(conversations = it.conversations.filterNot { c -> c.id == id }, replyFeedback = it.replyFeedback.filterKeys { key -> !key.startsWith("[\"$id\",") }) }
    }
    override suspend fun readGeneratedFile(file: GeneratedFile): ByteArray {
        GeneratedFilePolicy.validate(file)
        require(!file.blob) { "本地演示没有此二进制快照" }
        return file.content.orEmpty().toByteArray()
    }
    override suspend fun deleteProject(id: String) { state.update { it.copy(projects = it.projects.filterNot { p -> p.id == id }, conversations = it.conversations.map { c -> if (c.projectId == id) c.copy(projectId = null) else c }) } }
    override suspend fun saveProject(project: Project) { state.update { it.copy(projects = it.projects.filterNot { p -> p.id == project.id } + project) } }
    override suspend fun signOut() {
        generation.invalidate()
        jobs.values.toList().forEach { it.cancelAndJoin() }
        jobs.clear()
        state.value = Snapshot()
        link.value = Connection.Offline
    }
    fun pinArtifact(id: String, pinned: Boolean) { state.update { it.copy(artifacts = it.artifacts.map { a -> if (a.id == id) a.copy(pinned = pinned) else a }) } }
    fun duplicateArtifact(artifact: Artifact) { state.update { it.copy(artifacts = it.artifacts + artifact.copy(id = newId(), name = artifact.name + " 副本", pinned = false)) } }
    suspend fun simulateDisconnect() {
        link.value = Connection.Reconnecting(1)
        delay(1500)
        link.value = Connection.Connected
    }
    private fun replace(c: Conversation) { state.update { it.copy(conversations = it.conversations.filterNot { existing -> existing.id == c.id } + c) } }
    private fun patchTurn(id: String, turnId: String, edit: (Turn) -> Turn) {
        val c = state.value.conversations.find { it.id == id } ?: return
        replace(c.copy(turns = c.turns.map { if (it.id == turnId) edit(it) else it }))
    }
}
object DemoFixtures {
    fun snapshot(): Snapshot {
        val models = listOf(ModelOption("demo-auto", "默认模型", "适合日常任务的本地测试模型", "demo", listOf("low", "medium", "high")), ModelOption("demo-reason", "推理模型", "测试推理模型选择，不会调用真实模型", "demo", listOf("low", "medium", "high", "xhigh")), ModelOption("demo-fast", "快速模型", "快速响应轻量任务 · 本地示例", "demo"), ModelOption("demo-extra", "更多模型示例", "仅用于验证账户模型列表", "demo", listOf("medium", "high")))
        val project = Project("demo-project", "Claudex 移动体验", "让想法与工作在手机上自然延续", "回答使用简体中文，先给结论。优先考虑清晰、直接的手机体验。")
        val turns = listOf(Turn("demo-turn", "帮我梳理手机端的核心体验，优先考虑日常使用。", items = listOf(Item("demo-answer", "agentMessage", "先把三件事做好\n\n1. 随时开始\n打开即提问，附件与听写随手可及。\n\n2. 连续工作\n项目保留指令、文件与对话上下文。\n\n3. 看得见进展\n云端任务的状态和结果一目了然。\n\n以上是本地演示内容。"), Item("demo-diff", "fileChange", changes = listOf(Change("src/composer/Attachments.tsx", "@@ -18,3 +18,4 @@\n const preview = attachment.preview;\n-<div className=\"preview\">\n+<section className=\"preview\">\n+  <PreviewHeader />\n   <FileContent />\n-</div>\n+</section>"))))))
        return Snapshot(conversations = listOf(Conversation("demo-chat", "移动端体验方案", providerId = "demo", model = "demo-auto", pinned = true, turns = turns, projectId = project.id), Conversation("demo-code", "优化移动端附件预览", Mode.CODE, "demo", "demo-reason", turns = listOf(Turn("code-turn", "优化移动端附件预览", items = turns.first().items, status = TurnStatus.COMPLETED)))), projects = listOf(project, Project("research", "产品研究", "汇总洞察，形成可执行的方向", "标注资料来源，区分事实与推测。"), Project("planning", "季度规划", "跟进目标与关键事项", "先列目标，再整理执行步骤。")), artifacts = listOf(Artifact("demo-artifact", "交互原型.html", "html", "<!doctype html><html lang=\"zh\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{font-family:system-ui;background:#fff;padding:22px;color:#242522;line-height:1.8}h1{font-size:24px;line-height:1.4}small,p{color:#7b7d76}section{margin:30px 0}b{color:#bc684d;font-size:24px;font-weight:400;margin-right:14px}strong{font-size:17px}</style><small>Claudex · 本地示例产物</small><h1>移动端体验原则</h1><section><b>01</b><strong>专注当前任务</strong><p>减少干扰，让内容成为主角。</p></section><section><b>02</b><strong>操作触手可及</strong><p>常用操作保持清晰，易于点击。</p></section><section><b>03</b><strong>保持一致</strong><p>统一导航、间距与反馈方式。</p></section></html>", "demo-chat", true), Artifact("demo-note", "发布说明.md", "markdown", "# 移动体验\n\n这是本地演示资料。\n\n- 原生导航\n- 系统附件选择\n- 清晰的任务状态", "demo-chat"), Artifact("demo-diagram", "架构示意.svg", "svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"260\" height=\"200\" viewBox=\"0 0 260 200\"><rect width=\"260\" height=\"200\" fill=\"white\"/><path d=\"M130 50V100M60 100H200M60 100V130M200 100V130\" stroke=\"#8a8d85\" fill=\"none\"/><g fill=\"#eef0eb\" stroke=\"#a2a69b\"><rect x=\"85\" y=\"20\" width=\"90\" height=\"45\" rx=\"8\"/><rect x=\"15\" y=\"130\" width=\"90\" height=\"45\" rx=\"8\"/><rect x=\"155\" y=\"130\" width=\"90\" height=\"45\" rx=\"8\"/></g><text x=\"20\" y=\"195\" font-size=\"10\">Local demo diagram</text></svg>", "demo-chat")), models = models, selectedModel = models.first().id, engine = "ready")
    }
}

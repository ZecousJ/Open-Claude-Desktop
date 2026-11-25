package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** A failed turn reduced to a code and a short description. The original text is not kept. */
internal data class DescribedTurnError(val code: String, val message: String)

/** One report waiting to be sent. It never contains a prompt, a reply or a file path. */
internal data class PendingDiagnostic(
    val id: String,
    val turnId: String,
    val occurredAt: Long,
    val code: String,
    val message: String,
    val model: String,
    val appVersion: String,
    val platform: String,
    val arch: String,
    val osVersion: String,
    val kind: String = "turn_error",
)

internal data class FailedTurn(val id: String, val error: String?, val model: String)

internal data class DiagnosticClient(val appVersion: String, val platform: String, val arch: String, val osVersion: String)

/**
 * The same diagnostic rules as the desktop reporter: a failed turn is reported as a category,
 * secrets and paths are removed, and nothing is offered for upload unless the person consented
 * and the service is collecting diagnostics.
 */
internal object DiagnosticPolicy {
    private const val maxMessage = 300
    private val clientTemplates = setOf(
        "The Claudex service is unreachable.",
        "No model is assigned to this account yet.",
    )

    fun serviceCollectsDiagnostics(body: JSONObject): Boolean = flag(body, "diagnostics")
    fun serviceCollectsFeedback(body: JSONObject): Boolean = flag(body, "feedback")
    private fun flag(body: JSONObject, name: String): Boolean {
        val data = body.optJSONObject("data") ?: body
        return data.optJSONObject("features")?.opt(name) == true
    }

    fun redactMessage(text: String): String {
        var value = redactSecrets(text.take(2000))
        value = value.replace(Regex("[\\u0000-\\u001f\\u007f]+"), " ")
        value = value.replace(Regex("([\"'`])[^\"'`]*[\\\\/][^\"'`]*\\1"), "$1[path]$1")
        value = value.replace(Regex("\\b[a-z][a-z0-9+.-]*://\\S+", RegexOption.IGNORE_CASE), "[url]")
        value = value.replace(Regex("\\b[A-Za-z]:\\\\[^\\s\"'<>|]*"), "[path]")
        value = value.replace(Regex("\\\\\\\\[^\\s\"'<>|]+"), "[path]")
        value = value.replace(Regex("(^|[\\s\"'(=:])~?/[^\\s\"'<>)]+"), "$1[path]")
        value = value.replace(Regex("\\b[\\w.-]+(?:[\\\\/][\\w.-]+)+\\.[A-Za-z0-9]{1,8}\\b"), "[path]")
        return value.replace(Regex("\\s+"), " ").trim().take(maxMessage)
    }

    fun describeTurnError(error: String): DescribedTurnError? {
        val text = error.trim()
        if (text.isEmpty()) return null
        if (text in clientTemplates) return DescribedTurnError("TURN_CLIENT", redactMessage(text))
        val category = category(text.lowercase())
        return DescribedTurnError("TURN_${category.uppercase()}", category)
    }

    private fun redactSecrets(text: String): String {
        var value = text
        value = value.replace(Regex("\\bsk-[A-Za-z0-9_-]{6,}"), "[key]")
        value = value.replace(Regex("\\bBearer\\s+\\S+", RegexOption.IGNORE_CASE), "Bearer [token]")
        value = value.replace(Regex("\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*"), "[token]")
        value = value.replace(Regex("\\b((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password)\\s*[:=]\\s*)[\"']?[^\\s\"',;]+", RegexOption.IGNORE_CASE), "$1[secret]")
        value = value.replace(Regex("[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,8}\\.[A-Za-z]{2,24}\\b"), "[email]")
        return value
    }

    private fun category(text: String): String = when {
        Regex("context (length|window)|maximum context|too many tokens").containsMatchIn(text) -> "context_length"
        Regex("timed? ?out|timeout").containsMatchIn(text) -> "timeout"
        Regex("\\b429\\b|rate.?limit|too many requests").containsMatchIn(text) -> "rate_limited"
        Regex("\\b401\\b|\\b403\\b|unauthori[sz]ed|forbidden|invalid api key").containsMatchIn(text) -> "auth"
        Regex("\\bmodel\\b").containsMatchIn(text) && Regex("not (found|supported|available)|does not exist|unknown").containsMatchIn(text) -> "model_unavailable"
        Regex("\\b5\\d\\d\\b|server error|internal error|bad gateway|overloaded|service unavailable").containsMatchIn(text) -> "server_error"
        Regex("unreachable|econn|enotfound|network|fetch failed|socket|disconnect|stream (closed|ended)|connection").containsMatchIn(text) -> "network"
        else -> "unknown"
    }

    /** A stored row may only be a category, or one of the two fixed client sentences. */
    fun keepsStoredMessage(code: String, message: String): Boolean {
        if (code == "TURN_CLIENT") return message in clientTemplates
        return message in setOf("timeout", "rate_limited", "auth", "model_unavailable", "server_error", "network", "context_length", "unknown") &&
            code == "TURN_${message.uppercase()}"
    }

    /** A crash report is the exception name and up to three `File.ext:line` frames. No message and no path. */
    fun keepsCrash(code: String, message: String): Boolean {
        if (!code.matches(Regex("^[A-Za-z][A-Za-z0-9_]{0,40}$"))) return false
        if (message == code) return true
        if (!message.startsWith("$code at ")) return false
        val frames = message.removePrefix("$code at ").split(", ")
        return frames.size in 1..3 && frames.all { it.matches(Regex("^[A-Za-z0-9_.]+:[0-9]{1,6}$")) }
    }
}

internal class DiagnosticQueue(
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val reports = mutableListOf<PendingDiagnostic>()
    private val seen = mutableSetOf<String>()
    private var retryAt = 0L
    private val feedback = mutableListOf<PendingFeedback>()
    private var feedbackRetryAt = 0L
    val pendingIds: List<String> get() = reports.map { it.id }
    val pendingFeedbackIds: List<String> get() = feedback.map { it.id }

    fun clear() { reports.clear(); feedback.clear() }

    /** Failed turns already on screen while consent is off are remembered and not uploaded later. */
    fun observe(failures: List<FailedTurn>, consent: Boolean, client: DiagnosticClient) {
        if (!consent) {
            clear()
            seen += failures.map { it.id }
            trimSeen()
            return
        }
        for (turn in failures) {
            if (turn.id in seen) continue
            seen += turn.id
            val described = DiagnosticPolicy.describeTurnError(turn.error ?: "") ?: continue
            reports += PendingDiagnostic(
                newId(), turn.id, now(), described.code, described.message, turn.model.take(200),
                client.appVersion.take(32), client.platform.take(16), client.arch.take(16), client.osVersion.take(64),
            )
            if (reports.size > 500) reports.removeAt(0)
        }
        trimSeen()
    }

    /** The upload body, or null when consent, collection or the retry wait says not to send. */
    fun payload(consent: Boolean, serviceEnabled: Boolean): JSONObject? {
        if (!consent) { clear(); return null }
        if (!serviceEnabled || reports.isEmpty() || now() < retryAt) return null
        val batch = JSONArray()
        reports.take(50).forEach { report ->
            batch.put(JSONObject()
                .put("id", report.id)
                .put("occurred_at", Instant.ofEpochMilli(report.occurredAt).toString())
                .put("kind", report.kind)
                .put("code", report.code.take(64))
                .put("message", report.message.take(300))
                .put("request_id", "")
                .put("model", report.model)
                .put("app_version", report.appVersion)
                .put("codex_version", "")
                .put("platform", report.platform)
                .put("arch", report.arch)
                .put("os_version", report.osVersion)
                .put("context", JSONObject().put("surface", if (report.kind == "crash") "app" else "chat")))
        }
        return JSONObject().put("consent", true).put("reports", batch)
    }

    fun postpone() { retryAt = now() + 60_000 }
    fun acknowledge(ids: Set<String>) {
        retryAt = 0
        reports.removeAll { it.id in ids }
    }

    /** A thumbs rating, without the conversation. Withdrawing a rating does not create a report. */
    fun recordFeedback(rating: String, model: String, client: DiagnosticClient) {
        if (rating != "up" && rating != "down") return
        feedback += PendingFeedback(newId(), rating, model.take(200), client.appVersion.take(32), client.platform.take(16))
        if (feedback.size > 200) feedback.removeAt(0)
    }

    fun feedbackPayload(consent: Boolean, serviceEnabled: Boolean): JSONObject? {
        if (!consent) { feedback.clear(); return null }
        val next = feedback.firstOrNull() ?: return null
        if (!serviceEnabled || now() < feedbackRetryAt) return null
        return JSONObject()
            .put("consent", true)
            .put("id", next.id)
            .put("rating", next.rating)
            .put("categories", org.json.JSONArray())
            .put("comment", "")
            .put("model", next.model)
            .put("request_id", "")
            .put("conversation_excerpt", JSONObject.NULL)
            .put("app_version", next.appVersion)
            .put("platform", next.platform)
    }

    fun postponeFeedback() { feedbackRetryAt = now() + 60_000 }
    fun acknowledgeFeedback(id: String) { feedbackRetryAt = 0; feedback.removeAll { it.id == id } }

    /** An uncaught exception, reduced to its type and source frames. The exception text is not kept. */
    fun recordCrash(name: String, frames: List<String>, client: DiagnosticClient) {
        val code = name.takeIf { it.matches(Regex("^[A-Za-z][A-Za-z0-9_]{0,40}$")) } ?: "Error"
        val kept = frames.filter { it.matches(Regex("^[A-Za-z0-9_.]+:[0-9]{1,6}$")) }.distinct().take(3)
        val message = if (kept.isEmpty()) code else "$code at ${kept.joinToString(", ")}"
        reports += PendingDiagnostic(
            newId(), "crash", now(), code, message, "",
            client.appVersion.take(32), client.platform.take(16), client.arch.take(16), client.osVersion.take(64),
            "crash",
        )
        if (reports.size > 500) reports.removeAt(0)
    }

    /** Drops unsent reports and ratings. Turns already seen stay seen. */
    fun dropPending() { reports.clear(); feedback.clear() }

    /** Forgets this account's queue in memory. The file for that account is left for the next sign-in. */
    fun forget() { dropPending(); seen.clear(); retryAt = 0; feedbackRetryAt = 0 }

    /** The on-disk queue. It has no prompt, reply, path or original error text. */
    fun document(): JSONObject {
        trimSeen()
        val diagnostics = JSONArray()
        reports.forEach { report ->
            diagnostics.put(JSONObject()
                .put("id", report.id)
                .put("turn_id", report.turnId)
                .put("occurred_at", report.occurredAt)
                .put("code", report.code)
                .put("message", report.message)
                .put("model", report.model)
                .put("app_version", report.appVersion)
                .put("platform", report.platform)
                .put("arch", report.arch)
                .put("os_version", report.osVersion)
                .put("kind", report.kind))
        }
        val ratings = JSONArray()
        feedback.forEach { item ->
            ratings.put(JSONObject()
                .put("id", item.id)
                .put("rating", item.rating)
                .put("model", item.model)
                .put("app_version", item.appVersion)
                .put("platform", item.platform))
        }
        return JSONObject()
            .put("version", 1)
            .put("diagnostics", diagnostics)
            .put("feedback", ratings)
            .put("seen", JSONArray(seen.toList()))
            .put("retry_at", retryAt)
            .put("feedback_retry_at", feedbackRetryAt)
    }

    /** Replaces this queue with a document this app wrote. A damaged document is refused whole. */
    fun restore(document: JSONObject): Boolean {
        if (document.optInt("version") != 1 || !document.has("diagnostics") || !document.has("feedback") || !document.has("seen")) return false
        val diagnostics = document.optJSONArray("diagnostics") ?: return false
        val ratings = document.optJSONArray("feedback") ?: return false
        val seenIds = document.optJSONArray("seen") ?: return false
        if (diagnostics.length() > 500 || ratings.length() > 200 || seenIds.length() > 2000) return false
        val nextReports = mutableListOf<PendingDiagnostic>()
        for (index in 0 until diagnostics.length()) {
            val row = diagnostics.optJSONObject(index) ?: return false
            if (row.has("conversation_excerpt") || row.has("error") || row.has("prompt")) return false
            val id = row.optString("id")
            val turnId = row.optString("turn_id")
            val code = row.optString("code")
            val message = row.optString("message")
            val kind = row.optString("kind", "turn_error").ifBlank { "turn_error" }
            val kept = if (kind == "turn_error") DiagnosticPolicy.keepsStoredMessage(code, message) else kind == "crash" && DiagnosticPolicy.keepsCrash(code, message)
            if (!uuid(id) || !plain(turnId, 128) || !kept) return false
            val model = row.optString("model")
            val appVersion = row.optString("app_version")
            val platform = row.optString("platform")
            val arch = row.optString("arch")
            val osVersion = row.optString("os_version")
            if (!bounded(model, 200) || !bounded(appVersion, 32) || !bounded(platform, 16) || !bounded(arch, 16) || !bounded(osVersion, 64)) return false
            val occurredAt = row.optLong("occurred_at", -1)
            if (occurredAt < 0) return false
            nextReports += PendingDiagnostic(id, turnId, occurredAt, code, message, model, appVersion, platform, arch, osVersion, kind)
        }
        val nextFeedback = mutableListOf<PendingFeedback>()
        for (index in 0 until ratings.length()) {
            val row = ratings.optJSONObject(index) ?: return false
            if (row.has("conversation_excerpt") || row.has("comment") || row.has("prompt")) return false
            val id = row.optString("id")
            val rating = row.optString("rating")
            if (!uuid(id) || (rating != "up" && rating != "down")) return false
            val model = row.optString("model")
            val appVersion = row.optString("app_version")
            val platform = row.optString("platform")
            if (!bounded(model, 200) || !bounded(appVersion, 32) || !bounded(platform, 16)) return false
            nextFeedback += PendingFeedback(id, rating, model, appVersion, platform)
        }
        val nextSeen = mutableSetOf<String>()
        for (index in 0 until seenIds.length()) {
            val id = seenIds.optString(index)
            if (!plain(id, 128)) return false
            nextSeen += id
        }
        reports.clear(); reports += nextReports
        feedback.clear(); feedback += nextFeedback
        seen.clear(); seen += nextSeen
        retryAt = document.optLong("retry_at", 0).coerceAtLeast(0)
        feedbackRetryAt = document.optLong("feedback_retry_at", 0).coerceAtLeast(0)
        return true
    }

    private fun trimSeen() {
        while (seen.size > 2000) seen.remove(seen.first())
    }

    private fun uuid(value: String) = uuidPattern.matches(value)
    private fun plain(value: String, limit: Int) = value.length in 1..limit && value.none { it.code < 32 }
    private fun bounded(value: String, limit: Int) = value.length <= limit && value.none { it.code < 32 }

    private companion object {
        val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    }
}

internal data class PendingFeedback(val id: String, val rating: String, val model: String, val appVersion: String, val platform: String)

/** One account's queue file. The file name is a hash, so the account is not written on disk. */
internal object DiagnosticQueueFile {
    private val lock = Any()

    fun location(directory: File, account: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(account.toByteArray(Charsets.UTF_8))
        val name = digest.take(16).joinToString("") { "%02x".format(it) }
        return directory.resolve("diagnostics").resolve("$name.json")
    }

    fun load(file: File, queue: DiagnosticQueue) = synchronized(lock) {
        if (!file.isFile) return
        val parsed = runCatching { JSONObject(file.readText()) }.getOrNull()
        if (parsed == null || !queue.restore(parsed)) file.delete()
    }

    fun store(file: File, queue: DiagnosticQueue, consent: Boolean) = synchronized(lock) {
        if (!consent) queue.dropPending()
        val document = queue.document()
        val empty = document.getJSONArray("diagnostics").length() == 0 &&
            document.getJSONArray("feedback").length() == 0 &&
            document.getJSONArray("seen").length() == 0
        if (empty) {
            file.delete()
            File(file.parentFile, file.name + ".tmp").delete()
            return
        }
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, file.name + ".tmp")
        temporary.writeText(document.toString())
        if (!temporary.renameTo(file)) {
            file.writeText(document.toString())
            temporary.delete()
        }
    }
}

package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * What a button sends. [Session] is the Code card's "Always allow for this session" (Codex `acceptForSession`,
 * permissions `scope: session`); [Always] is a connector tool's "Always allow" (the request's own `persist` choice).
 */
internal enum class ApprovalAnswer { Once, Session, Always, Deny }

/**
 * A connector tool's approval, as Codex asks it: an MCP elicitation (`mcpServer/elicitation/request`) whose `_meta`
 * carries `codex_approval_kind: "mcp_tool_call"`, the call's parameters and `persist`, the choices that outlive the
 * request ("session" and/or "always"). The answer is `action: accept` with `_meta: { persist }`. The same reading as
 * `shared/mcp-tool-approval.ts` (checked against the real codex-cli 0.144.1 app-server,
 * tests/mcp-tool-approval.e2e.test.ts); the tool's name is only in the message (`Allow the <server> MCP server to run
 * tool "<tool>"?`), a title and connector name only for apps.
 */
internal class ConnectorToolApproval private constructor(
    val server: String, val tool: String?, val title: String?, val connector: String?,
    val rows: List<Row>, val canSession: Boolean, val canAlways: Boolean,
) {
    class Row(val label: String, val value: String) { override fun equals(other: Any?) = other is Row && other.label == label && other.value == value; override fun hashCode() = label.hashCode() * 31 + value.hashCode() }

    /** What the sentence calls the tool. */
    val toolName: String? get() = title ?: tool
    /** The connector the sentence names: its own name, else the server's. */
    val connectorName: String? get() = connector ?: server.takeIf { it.isNotEmpty() }
    /** "Always allow" keeps the persistent choice when offered, else the session's. */
    val alwaysScope: String? get() = if (canAlways) "always" else if (canSession) "session" else null

    fun response(answer: ApprovalAnswer): JSONObject {
        if (answer == ApprovalAnswer.Deny) return JSONObject().put("action", "decline").put("content", JSONObject.NULL).put("_meta", JSONObject.NULL)
        val scope = when (answer) { ApprovalAnswer.Always -> alwaysScope; ApprovalAnswer.Session -> if (canSession) "session" else null; else -> null }
        return JSONObject().put("action", "accept").put("content", JSONObject.NULL)
            .put("_meta", if (scope != null) JSONObject().put("persist", scope) else JSONObject.NULL)
    }

    companion object {
        fun parse(method: String, params: JSONObject): ConnectorToolApproval? {
            if (method != "mcpServer/elicitation/request" || params.optString("mode") == "url") return null
            val meta = params.optJSONObject("_meta") ?: return null
            if (meta.optString("codex_approval_kind") != "mcp_tool_call") return null
            val server = text(params.opt("serverName"), 100).orEmpty()
            val named = Regex("to run tool \"([^\"]{1,200})\"").find(params.optString("message"))?.groupValues?.get(1)
            val tool = text(meta.opt("tool_name"), 200) ?: named
            val title = text(meta.opt("tool_title"), 200) ?: tool
            val name = text(meta.opt("connector_name"), 100)
            val persist = meta.opt("persist")
            val values = when (persist) {
                is JSONArray -> (0 until persist.length()).mapNotNull { persist.opt(it) as? String }
                is String -> listOf(persist)
                else -> emptyList()
            }
            return ConnectorToolApproval(server, tool, title, name?.takeIf { it != server }, rows(meta), "session" in values, "always" in values)
        }

        private fun text(value: Any?, limit: Int): String? = (value as? String)?.trim()?.takeIf { it.isNotEmpty() }?.take(limit)

        private fun shown(value: Any?): String {
            val text = when (value) {
                null, JSONObject.NULL -> ""
                is String -> value
                is Boolean -> value.toString()
                is Number -> ElicitationForm.format(value.toDouble())
                else -> value.toString()
            }
            val flat = text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
            return if (flat.length > 400) flat.take(400) + "…" else flat
        }

        /** `tool_params_display` when Codex sends it, else the raw `tool_params` (sorted: object order is not kept). */
        private fun rows(meta: JSONObject): List<Row> {
            val out = mutableListOf<Row>()
            meta.optJSONArray("tool_params_display")?.objects()?.take(40)?.forEach { entry ->
                val label = text(entry.opt("display_name"), 80) ?: text(entry.opt("name"), 80) ?: return@forEach
                out += Row(label, shown(entry.opt("value")))
            }
            if (out.isNotEmpty()) return out
            meta.optJSONObject("tool_params")?.let { params ->
                params.keys().asSequence().toList().sorted().take(40).forEach { out += Row(it.take(80), shown(params.opt(it))) }
            }
            return out
        }

        fun parse(approval: com.claudex.core.Approval): ConnectorToolApproval? =
            parse(approval.method, runCatching { JSONObject(approval.params) }.getOrDefault(JSONObject()))
    }
}

/**
 * An MCP elicitation `requestedSchema` (a flat object of primitives) as form fields and back: the same rules as the
 * web card (`src/approval/elicitation-form.ts`). `tests/fixtures/elicitation-form-cases.json` holds the cases the
 * web, the iOS Core and this app all pass. The field order is the engine's `claudexFieldOrder` (the schema's
 * property order), since JSON objects are unordered here.
 */
internal object ElicitationForm {
    enum class FieldType { Text, Number, Integer, Boolean, Choice, Multi }
    class Option(val value: String, val label: String)
    sealed interface Value {
        data class Text(val value: String) : Value
        data class Flag(val value: Boolean) : Value
        data class Items(val value: List<String>) : Value
    }
    class Field(
        val name: String, val label: String, val description: String?, val type: FieldType, val required: Boolean,
        val options: List<Option>, val format: String?, val minimum: Double?, val maximum: Double?,
        val minLength: Int?, val maxLength: Int?, val initial: Value,
    )

    /** What is wrong with the values: the kind, the field's label and the limit it broke. The phone words each kind in its own language. */
    sealed interface Problem {
        val label: String
        data class Required(override val label: String) : Problem
        data class ChooseOne(override val label: String) : Problem
        data class Number(override val label: String) : Problem
        data class Integer(override val label: String) : Problem
        data class Minimum(override val label: String, val limit: Double) : Problem
        data class Maximum(override val label: String, val limit: Double) : Problem
        data class MinLength(override val label: String, val limit: Int) : Problem
        data class MaxLength(override val label: String, val limit: Int) : Problem
        data class Email(override val label: String) : Problem
        data class Uri(override val label: String) : Problem
        data class DateTime(override val label: String) : Problem
    }

    sealed interface Result {
        data class Content(val content: JSONObject) : Result
        data class Invalid(val problem: Problem) : Result
    }

    /** The form fields of a `requestedSchema`; [order] is the schema's property order when known. */
    fun fields(schema: JSONObject?, order: List<String>? = null): List<Field> {
        val properties = schema?.optJSONObject("properties") ?: return emptyList()
        val required = schema.optJSONArray("required")?.let { list -> (0 until list.length()).mapNotNull { list.opt(it) as? String } }.orEmpty().toSet()
        val known = properties.keys().asSequence().toSet()
        val names = order.orEmpty().filter { it in known }.distinct() + known.filter { it !in order.orEmpty() }.sorted()
        return names.map { name ->
            val field = properties.optJSONObject(name) ?: JSONObject()
            val choices = options(field)
            val type = when {
                field.optString("type") == "array" -> FieldType.Multi
                choices.isNotEmpty() -> FieldType.Choice
                field.optString("type") == "boolean" -> FieldType.Boolean
                field.optString("type") == "integer" -> FieldType.Integer
                field.optString("type") == "number" -> FieldType.Number
                else -> FieldType.Text
            }
            val default = field.opt("default")
            val initial: Value = when (type) {
                FieldType.Boolean -> Value.Flag(default as? Boolean ?: false)
                FieldType.Multi -> Value.Items((default as? JSONArray)?.let { list -> (0 until list.length()).map { display(list.opt(it)) } }.orEmpty())
                else -> Value.Text(if (default == null || default == JSONObject.NULL) "" else display(default))
            }
            Field(name, if (field.isNull("title") || !field.has("title")) name else display(field.opt("title")),
                (field.opt("description") as? String), type, name in required, choices, field.opt("format") as? String,
                (field.opt("minimum") as? Number)?.toDouble(), (field.opt("maximum") as? Number)?.toDouble(),
                whole(field.opt("minLength")), whole(field.opt("maxLength")), initial)
        }
    }

    private fun whole(value: Any?): Int? = (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it == Math.rint(it) }?.toInt()

    private fun options(schema: JSONObject): List<Option> {
        schema.optJSONArray("oneOf")?.let { list ->
            return (0 until list.length()).map { index ->
                val option = list.optJSONObject(index) ?: JSONObject()
                val const = display(option.opt("const"))
                Option(const, if (option.isNull("title") || !option.has("title")) const else display(option.opt("title")))
            }
        }
        schema.optJSONArray("enum")?.let { list ->
            val names = schema.optJSONArray("enumNames")
            return (0 until list.length()).map { index ->
                val value = display(list.opt(index))
                val name = names?.takeIf { index < it.length() && !it.isNull(index) }?.opt(index)
                Option(value, if (name != null) display(name) else value)
            }
        }
        val items = schema.optJSONObject("items") ?: return emptyList()
        return options(items.optJSONArray("anyOf")?.let { JSONObject().put("oneOf", it) } ?: items)
    }

    /** JavaScript's `String(value)` for the JSON values a schema holds. */
    internal fun display(value: Any?): String = when (value) {
        is String -> value
        is Number -> format(value.toDouble())
        is Boolean -> value.toString()
        null, JSONObject.NULL -> "null"
        else -> ""
    }

    /** A number as JavaScript prints it: 3, 2.5, never 3.0. */
    fun format(number: Double): String =
        if (number == Math.rint(number) && Math.abs(number) < 1e15) number.toLong().toString() else number.toString()

    /** The content of an accepted form, or the first problem with the values. */
    fun content(fields: List<Field>, values: Map<String, Value>): Result {
        val content = JSONObject()
        for (field in fields) {
            val value = values[field.name] ?: field.initial
            val label = field.label
            when (field.type) {
                FieldType.Boolean -> { content.put(field.name, (value as? Value.Flag)?.value ?: false); continue }
                FieldType.Multi -> {
                    val list = (value as? Value.Items)?.value.orEmpty()
                    if (field.required && list.isEmpty()) return Result.Invalid(Problem.ChooseOne(label))
                    if (list.isNotEmpty()) content.put(field.name, JSONArray(list))
                    continue
                }
                else -> Unit
            }
            val text = ((value as? Value.Text)?.value.orEmpty()).trim()
            if (text.isEmpty()) {
                if (field.required) return Result.Invalid(Problem.Required(label))
                continue
            }
            if (field.type == FieldType.Number || field.type == FieldType.Integer) {
                val number = text.toDoubleOrNull()?.takeIf { it.isFinite() && !Regex("[A-Za-z]").containsMatchIn(text.replace(Regex("[eE][+-]?\\d+$"), "")) }
                if (number == null || (field.type == FieldType.Integer && number != Math.rint(number)))
                    return Result.Invalid(if (field.type == FieldType.Integer) Problem.Integer(label) else Problem.Number(label))
                if (field.minimum != null && number < field.minimum) return Result.Invalid(Problem.Minimum(label, field.minimum))
                if (field.maximum != null && number > field.maximum) return Result.Invalid(Problem.Maximum(label, field.maximum))
                content.put(field.name, if (number == Math.rint(number) && Math.abs(number) < 1e15) number.toLong() else number)
                continue
            }
            if (field.minLength != null && text.length < field.minLength) return Result.Invalid(Problem.MinLength(label, field.minLength))
            if (field.maxLength != null && text.length > field.maxLength) return Result.Invalid(Problem.MaxLength(label, field.maxLength))
            if (field.format == "email" && !Regex("^[^\\s@]+@[^\\s@]+$").matches(text)) return Result.Invalid(Problem.Email(label))
            if (field.format == "uri" && !Regex("^[A-Za-z][A-Za-z0-9+.-]*:.*", RegexOption.DOT_MATCHES_ALL).matches(text)) return Result.Invalid(Problem.Uri(label))
            if (field.format == "date-time") {
                content.put(field.name, isoDateTime(text) ?: return Result.Invalid(Problem.DateTime(label)))
                continue
            }
            content.put(field.name, text)
        }
        return Result.Content(content)
    }

    private val isoMillis: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** A date and time (ISO 8601 with `Z` or an offset, or a date alone as midnight UTC) as `toISOString()` writes it. */
    internal fun isoDateTime(text: String): String? {
        val instant = runCatching { Instant.parse(text) }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()
            ?: runCatching { LocalDate.parse(text).atStartOfDay().toInstant(ZoneOffset.UTC) }.getOrNull()
        return instant?.let { isoMillis.format(it) }
    }

    /** The page a URL request opens: http or https only. */
    fun openablePage(url: String?): String? {
        val page = runCatching { URI(url ?: return null) }.getOrNull() ?: return null
        val scheme = page.scheme?.lowercase()
        return if ((scheme == "http" || scheme == "https") && !page.host.isNullOrEmpty()) page.toString() else null
    }
}

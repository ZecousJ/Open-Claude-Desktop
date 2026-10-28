package com.claudex.mobile

import com.claudex.core.ApiException
import com.claudex.core.ModelOption
import org.json.JSONArray
import org.json.JSONObject

/** One kept approval of a scheduled task ("Always allowed"): its kind, the tool named and the pattern that was allowed. */
data class ScheduleAllowed(val kind: String, val tool: String, val pattern: String?)

/** Positional runner contracts at main 7dda489; no browser-only credential/key methods. */
class ManagementApi(private val transport: suspend (String, Array<out Any?>) -> Any?) {
    constructor(repository: RemoteRepository): this({ method, args -> repository.rpc(method, *args) })
    private suspend fun call(method: String, args: Array<out Any?>): Any? {
        require(method in runnerMethods) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        return transport(method, args)
    }
    private fun objectResult(value: Any?) = value as? JSONObject ?: throw ApiException("BAD_RESPONSE", UserText.get(R.string.generic_error_something_went_wrong_try_again))
    private fun arrayResult(value: Any?) = (value as? JSONArray)?.objects() ?: throw ApiException("BAD_RESPONSE", UserText.get(R.string.generic_error_something_went_wrong_try_again))
    suspend fun schedules() = arrayResult(call("listSchedules", emptyArray()))
    suspend fun saveSchedule(value: JSONObject) = objectResult(call("saveSchedule", arrayOf(value)))
    suspend fun deleteSchedule(id: String) { call("deleteSchedule", arrayOf(id)) }
    suspend fun runSchedule(id: String) = objectResult(call("runSchedule", arrayOf(id)))
    suspend fun routineRuns(id: String) = arrayResult(call("routineRuns", arrayOf(id)))
    suspend fun memoryStatus() = objectResult(call("memoryStatus", emptyArray()))
    suspend fun memoryDoc(projectId: String?): JSONObject? {
        val result = call("memoryDoc", arrayOf(scope(projectId)))
        return if (result == null || result == JSONObject.NULL) null else objectResult(result)
    }
    suspend fun setMemoryPrefs(searchChats: Boolean? = null, generate: Boolean? = null): JSONObject {
        val patch = JSONObject(); searchChats?.let { patch.put("searchChats", it) }; generate?.let { patch.put("generate", it) }
        return objectResult(call("setMemoryPrefs", arrayOf(patch)))
    }
    suspend fun saveMemory(projectId: String?, text: String, revision: Long): JSONObject {
        require(text.length <= 1_000_000 && revision >= 0)
        return objectResult(call("saveMemoryDoc", arrayOf<Any?>(scope(projectId), text, revision)))
    }
    /**
     * Manage memory (the official "remember or forget" edit): adds one instruction to a scope and/or removes some, and
     * answers the scope's memory with how the change went (the service's `outcome`).
     */
    internal suspend fun updateMemoryEdits(projectId: String?, add: String? = null, remove: List<String> = emptyList()): MemoryEditResult {
        require(add != null || remove.isNotEmpty()); require(add == null || (add.isNotBlank() && add.length <= 2_000))
        val change = JSONObject(); add?.let { change.put("add", it.trim()) }; if (remove.isNotEmpty()) change.put("remove", JSONArray(remove))
        return MemoryEditResult.from(objectResult(call("updateMemoryEdits", arrayOf<Any?>(scope(projectId), change))), asked = add != null)
    }
    suspend fun resetMemory(projectId: String?) = objectResult(call("resetMemory", arrayOf(scope(projectId))))
    suspend fun removeMemoryEdit(id: String) = objectResult(call("removeMemoryEdit", arrayOf(id)))
    suspend fun previewMemoryImport(text: String): JSONObject {
        require(text.isNotBlank() && text.length <= 1_000_000)
        return objectResult(call("previewMemoryImport", arrayOf(text)))
    }
    suspend fun memoryReflection(refresh: Boolean = false) = objectResult(call("memoryReflection", arrayOf(refresh)))
    suspend fun apiGroups(fresh: Boolean = false) = objectResult(call("apiGroups", arrayOf(fresh)))
    suspend fun setApiGroup(providerId: String, groupId: Long): JSONObject { require(providerId.isNotBlank() && groupId in 1..9_007_199_254_740_991L); return objectResult(call("setApiGroup", arrayOf<Any?>(providerId, groupId))) }

    suspend fun setImageModel(model: String): JSONObject {
        require(ImageModelPolicy.valid(model)) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        return objectResult(call("setImageModel", arrayOf(model)))
    }
    companion object {
        // shared/web-bridge-methods.ts: collections overrides; memory default; API-keys only these two overrides.
        val runnerMethods = setOf("listSchedules", "saveSchedule", "deleteSchedule", "runSchedule", "routineRuns", "memoryStatus", "memoryDoc", "setMemoryPrefs", "saveMemoryDoc", "resetMemory", "removeMemoryEdit", "updateMemoryEdits", "previewMemoryImport", "memoryReflection", "apiGroups", "setApiGroup", "setImageModel")
        fun scope(projectId: String?) = if (projectId == null) JSONObject().put("kind", "global") else JSONObject().put("kind", "project").put("projectId", projectId)
        /** Preserve recurrence, remote environment and unknown server fields when editing an existing routine. */
        fun schedulePatch(original: JSONObject, name: String = original.optString("name"), prompt: String = original.optString("prompt"), enabled: Boolean = original.optBoolean("enabled")): JSONObject {
            require(name.isNotBlank() && name.length <= 120 && prompt.isNotBlank() && prompt.length <= 100_000)
            return JSONObject(original.toString()).put("name", name.trim()).put("prompt", prompt).put("enabled", enabled)
        }
        /** The permission modes a task can run with (`shared/settings-extras.ts` taskPermissions). */
        val permissionModes = listOf("default", "auto", "bypass")
        /** A one-time rule's moment is absolute (milliseconds since the epoch, whole minutes): the same instant on every device. */
        fun onceMoment(at: Long): Long { require(at > 0); return at - at % 60_000 }
        /** Whether a moment can no longer be chosen for a one-time task. */
        fun oncePast(at: Long, now: Long) = at <= now
        /**
         * A one-time task that has had its run (`isCompletedOnce` in shared/routines.ts): it switched itself off at its moment and its
         * run is not going. A run started by hand before the moment does not complete it.
         */
        fun isCompletedOnce(task: JSONObject): Boolean {
            val repeat = task.optJSONObject("repeat") ?: return false
            if (repeat.optString("kind") != "once" || task.optBoolean("enabled")) return false
            val lastRunAt = task.optLong("lastRunAt", -1)
            return lastRunAt >= 0 && lastRunAt >= repeat.optLong("at") && task.optString("lastRunStatus") !in listOf("starting", "running")
        }
        /** Active / Inactive / Completed, in the order the screen lists them. */
        fun sections(tasks: List<JSONObject>): Triple<List<JSONObject>, List<JSONObject>, List<JSONObject>> {
            val completed = tasks.filter(::isCompletedOnce)
            val rest = tasks - completed.toSet()
            return Triple(rest.filter { it.optBoolean("enabled") }, rest.filterNot { it.optBoolean("enabled") }, completed)
        }
        /** The mode a task runs with; a task without one has full access for Cowork and follows the Code setting for Code (null). */
        fun permissionOf(task: JSONObject): String? = task.optString("permission").takeIf { it in permissionModes }
            ?: if (task.optString("mode") == "cowork") "bypass" else null
        fun withPermission(task: JSONObject, mode: String): JSONObject { require(mode in permissionModes); return JSONObject(task.toString()).put("permission", mode) }
        /** The kept approvals ("Always allowed"): kind, the tool named and the pattern that was allowed. */
        fun allowed(task: JSONObject): List<ScheduleAllowed> = task.optJSONArray("alwaysAllowed")?.objects().orEmpty().mapNotNull { entry ->
            entry.optString("tool").takeIf { it.isNotBlank() }?.let { ScheduleAllowed(entry.optString("kind"), it, entry.optString("pattern").takeIf { p -> p.isNotBlank() }) }
        }
        fun repeatRule(kind: String, time: String, minute: Int, day: Int, expression: String = "", at: Long = 0): JSONObject {
            val result = JSONObject().put("kind", kind)
            when (kind) {
                "manual" -> Unit
                "once" -> result.put("at", onceMoment(at))
                "hourly" -> { require(minute in 0..59); result.put("minute", minute) }
                "daily", "weekdays", "weekly" -> { require(time.matches(Regex("([01][0-9]|2[0-3]):[0-5][0-9]"))); result.put("time", time); if (kind == "weekly") { require(day in 0..6); result.put("day", day) } }
                "custom" -> { val text = expression.trim(); require(CronRule.problem(text) == null); result.put("kind", "cron").put("expression", text) }
                else -> error(UserText.get(R.string.claudex_msg_repeat_web))
            }
            return result
        }
        fun withRepeat(original: JSONObject, rule: JSONObject): JSONObject = JSONObject(original.toString()).put("repeat", rule).put("frequency", when (rule.optString("kind")) { "hourly" -> "hourly"; "weekly" -> "weekly"; "cron" -> CronRule.frequency(rule.optString("expression")); else -> "daily" })
            .also { if (rule.optString("kind") == "once") it.put("nextRunAt", rule.getLong("at")) }
        /** No timezone is guessed: new tasks start as explicitly manual until runner-zone scheduling can be reviewed. */
        fun manualSchedule(name: String, prompt: String, mode: String, model: ModelOption, now: Long): JSONObject {
            require(mode in listOf("code", "cowork")); require(name.isNotBlank() && name.length <= 120 && prompt.isNotBlank() && prompt.length <= 100_000)
            return JSONObject().put("name", name.trim()).put("prompt", prompt).put("mode", mode).put("providerId", model.providerId).put("model", model.id)
                .put("frequency", "daily").put("repeat", JSONObject().put("kind", "manual")).put("enabled", true).put("nextRunAt", now).put("defaultModel", false)
        }
    }
}

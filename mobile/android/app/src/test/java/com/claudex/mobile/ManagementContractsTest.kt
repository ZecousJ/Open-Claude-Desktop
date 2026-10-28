package com.claudex.mobile

import com.claudex.core.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runCurrent
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import kotlin.test.*

/** Through real NativeApi/RemoteRepository encoding, not only a mock domain interface. */
class ManagementContractsTest {
    private class Harness(val handler: (String, JSONArray) -> Any?) : AutoCloseable {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val requests = mutableListOf<Pair<String, JSONArray>>()
        val api = NativeApi("https://example.test", NativeApiTest.MemoryVault(Session("access", "refresh", System.currentTimeMillis() + 3600000, "test@example.test")), OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request(); val method = request.url.pathSegments.last()
            val args = JSONObject(request.body!!.let { body -> Buffer().also(body::writeTo).readUtf8() }).getJSONArray("args")
            synchronized(requests) { requests += method to args }
            val result = handler(method, args)
            val envelope = if (result is ApiException) JSONObject().put("ok", false).put("error", JSONObject().put("code", result.code).put("message", result.message)) else JSONObject().put("ok", true).put("value", result ?: JSONObject.NULL)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("fixture").body(envelope.toString().toResponseBody("application/json".toMediaType())).build()
        }.build())
        val repository = RemoteRepository(api, scope)
        val management = ManagementApi(repository)
        override fun close() { repository.clearLocalSession(); scope.cancel(); api.client.dispatcher.executorService.shutdownNow() }
    }
    private fun routine() = JSONObject().put("id", "routine").put("name", "Monitor").put("prompt", "Check this project").put("mode", "code").put("providerId", "provider").put("model", "model").put("enabled", true).put("nextRunAt", 123456789).put("frequency", "weekly").put("repeat", JSONObject().put("kind", "weekly").put("time", "09:30").put("day", 1)).put("cwd", "/server/workspace").put("description", "Keep this").put("unknownFutureField", "preserved")
    @Test fun routineCrudAndHistoryUseActualArgumentsAndServerReturnedTimes() = runBlocking {
        Harness { method, args -> when (method) {
            "listSchedules" -> JSONArray(listOf(routine()))
            "saveSchedule" -> JSONObject(args.getJSONObject(0).toString()).put("nextRunAt", 999999999)
            "runSchedule" -> routine().put("lastRunStatus", "running")
            "routineRuns" -> JSONArray(listOf(JSONObject().put("id", "run").put("status", "completed").put("trigger", "manual").put("conversationId", "chat")))
            "deleteSchedule" -> null
            else -> error(method)
        } }.use { h ->
            val old = h.management.schedules().single(); val patched = ManagementApi.schedulePatch(old, name = "Updated", enabled = false)
            val saved = h.management.saveSchedule(patched)
            assertEquals(999999999L, saved.getLong("nextRunAt")); assertEquals("09:30", patched.getJSONObject("repeat").getString("time")); assertEquals("preserved", patched.getString("unknownFutureField")); assertEquals("/server/workspace", patched.getString("cwd")); assertTrue(old.getBoolean("enabled"))
            assertEquals("running", h.management.runSchedule("routine").getString("lastRunStatus"))
            assertEquals("chat", h.management.routineRuns("routine").single().getString("conversationId")); h.management.deleteSchedule("routine")
            assertEquals("[]", h.requests.first().second.toString()); assertTrue(h.requests.drop(2).all { it.second.toString() == "[\"routine\"]" })
        }
    }
    @Test fun manualDefaultNeverInventsTimezoneAndExplicitClockRuleIsPreserved() {
        val manual = ManagementApi.manualSchedule("Task", "Prompt", "cowork", ModelOption("m", "M", "", "p"), 1234)
        assertEquals("manual", manual.getJSONObject("repeat").getString("kind")); assertFalse(manual.has("timezone"))
        val next = ManagementApi.withRepeat(manual, ManagementApi.repeatRule("weekly", "23:45", 0, 0))
        assertEquals("weekly", next.getString("frequency")); assertEquals(0, next.getJSONObject("repeat").getInt("day")); assertEquals("23:45", next.getJSONObject("repeat").getString("time")); assertEquals(1234L, next.getLong("nextRunAt")) // Server recomputes; the client doesn't claim this as the actual next slot.
        assertFails { ManagementApi.repeatRule("daily", "25:60", 0, 0) }; assertFails { ManagementApi.repeatRule("hourly", "", 60, 0) }; assertFails { ManagementApi.repeatRule("weekly", "09:00", 0, 7) }
    }
    @Test fun customScheduleIsACronExpressionTheServiceWouldAccept() {
        val cron = ManagementApi.withRepeat(JSONObject().put("frequency", "daily"), ManagementApi.repeatRule("custom", "", 0, 0, " 30 9 * * 1,3 "))
        assertEquals("cron", cron.getJSONObject("repeat").getString("kind")); assertEquals("30 9 * * 1,3", cron.getJSONObject("repeat").getString("expression")); assertEquals("daily", cron.getString("frequency"))
        assertEquals("hourly", ManagementApi.withRepeat(JSONObject(), ManagementApi.repeatRule("custom", "", 0, 0, "15 * * * *")).getString("frequency"))
        assertNull(CronRule.problem("0 9 * * *")); assertEquals(CronRule.Problem.INVALID, CronRule.problem("0 9 * *")); assertEquals(CronRule.Problem.SUB_HOURLY, CronRule.problem("*/5 * * * *"))
        assertEquals(CronRule.Problem.NUMERIC_ONLY, CronRule.problem("0 9 * * MON")); assertEquals(CronRule.Problem.SUNDAY_IS_ZERO, CronRule.problem("0 9 * * 7")); assertEquals(CronRule.Problem.INVALID, CronRule.problem("61 9 * * *"))
        assertEquals("30 9 * * 1,2", CronRule.forDays("09:30", listOf(2, 1))); assertEquals("0 8 * * *", CronRule.forDays("08:00", (0..6).toList()))
        assertEquals("09:30" to listOf(1, 2), CronRule.asDays("30 9 * * 1,2")); assertNull(CronRule.asDays("30 9 1 * *"))
        assertFails { ManagementApi.repeatRule("custom", "", 0, 0, "*/5 * * * *") }
    }
    @Test fun legacyScheduleEditPreservesAnchorAndDoesNotAddRepeat() {
        val old = routine().apply { remove("repeat") }; val patch = ManagementApi.schedulePatch(old, prompt = "Edited")
        assertFalse(patch.has("repeat")); assertEquals(old.getLong("nextRunAt"), patch.getLong("nextRunAt")); assertEquals("weekly", patch.getString("frequency"))
    }
    @Test fun unsupportedAndPolicyErrorsRemainErrorsNotEmptySuccess() = runBlocking {
        Harness { _, _ -> ApiException("NOT_AVAILABLE", "Administrator disabled routines") }.use { h ->
            val error = assertFailsWith<ApiException> { h.management.schedules() }; assertEquals("NOT_AVAILABLE", error.code)
            assertFailsWith<ApiException> { h.management.runSchedule("routine") }; assertEquals(2, h.requests.size)
        }; Unit
    }
    @Test fun memoryScopeRevisionAndImportAreExplicit() = runBlocking {
        Harness { method, _ -> when(method) {
            "memoryStatus", "setMemoryPrefs", "resetMemory", "removeMemoryEdit" -> JSONObject().put("available", true)
            "memoryDoc" -> null
            "saveMemoryDoc" -> JSONObject().put("content", "saved").put("revision", 8)
            "previewMemoryImport" -> JSONObject().put("merged", "Merged preview").put("revision", 7)
            "memoryReflection" -> JSONObject().put("state", "empty")
            else -> error(method)
        } }.use { h ->
            h.management.memoryStatus(); assertNull(h.management.memoryDoc("project")); h.management.setMemoryPrefs(generate = false)
            h.management.saveMemory("project", "new text", 7); h.management.resetMemory("project"); h.management.removeMemoryEdit("edit")
            val preview = h.management.previewMemoryImport("imported"); assertEquals("Merged preview", preview.getString("merged")); h.management.memoryReflection()
            assertEquals("project", h.requests[1].second.getJSONObject(0).getString("kind")); assertEquals("project", h.requests[1].second.getJSONObject(0).getString("projectId"))
            assertFalse(h.requests[2].second.getJSONObject(0).has("searchChats")); assertFalse(h.requests[2].second.getJSONObject(0).getBoolean("generate"))
            assertEquals("project", h.requests[3].second.getJSONObject(0).getString("projectId")); assertEquals("new text", h.requests[3].second.getString(1)); assertEquals(7L, h.requests[3].second.getLong(2))
            assertEquals("project", h.requests[4].second.getJSONObject(0).getString("projectId")); assertEquals("[false]", h.requests.last().second.toString())
            assertEquals(1, h.requests.count { it.first == "saveMemoryDoc" }) // Preview does not save implicitly.
        }
    }
    @Test fun memoryConflictIsNotReplayedWithGuessedRevision() = runBlocking {
        Harness { _, _ -> ApiException("REVISION_CONFLICT", "Memory changed; refresh first") }.use { h ->
            val error = assertFailsWith<ApiException> { h.management.saveMemory(null, "unsaved text", 4) }
            assertEquals("REVISION_CONFLICT", error.code); assertEquals(1, h.requests.size); assertEquals(4, h.requests.single().second.getInt(2))
        }
    }
    @Test fun groupSelectionUsesProviderAndNumericGroupWithoutAnyKeyCalls() = runBlocking {
        Harness { _, _ -> JSONObject().put("providers", JSONArray(listOf(JSONObject().put("id", "openai").put("selected", 12)))).put("groups", JSONArray()) }.use { h ->
            h.management.apiGroups(true); val selected = h.management.setApiGroup("openai", 12)
            assertEquals("[true]", h.requests[0].second.toString()); assertEquals("[\"openai\",12]", h.requests[1].second.toString()); assertEquals(12, selected.getJSONArray("providers").getJSONObject(0).getInt("selected"))
            assertEquals(listOf("apiGroups", "setApiGroup"), h.requests.map { it.first })
        }
    }
    @Test fun featureEventsRefreshManagementButDoNotInventSnapshots() = runBlocking {
        Harness { _, _ -> error("no request") }.use { h ->
            listOf("schedules", "memory-changed", "service-changed").forEachIndexed { index, type -> h.repository.receiveFrame(JSONObject().put("t", "event").put("seq", index + 1).put("event", JSONObject().put("type", type))) }
            assertEquals(3L, h.repository.featureUpdates.value); assertTrue(h.requests.isEmpty())
        }
    }
    @Test fun browserOnlyApiKeyMethodsCannotEnterManagementRunnerAllowList() {
        assertTrue("apiGroups" in ManagementApi.runnerMethods); assertTrue("setApiGroup" in ManagementApi.runnerMethods)
        listOf("groupRates", "apiKeys", "createApiKey", "deleteApiKey").forEach { assertFalse(it in ManagementApi.runnerMethods) }
    }
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun panelCoalescesReadEventsAndBlocksRepeatedMutationClicks() = kotlinx.coroutines.test.runTest {
        val work = PanelWork(this); val gate = CompletableDeferred<Unit>(); var calls = 0
        work.run { calls++; gate.await() }; runCurrent()
        work.run { calls += 1000 } // Repeated mutation is ignored while the first is in flight.
        work.run(alert = false) { calls += 10 }; work.run(alert = false) { calls += 100 }
        gate.complete(Unit); runCurrent()
        assertEquals(101, calls); assertFalse(work.busy)
    }
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun queuedRefreshDoesNotHideFailedSaveOrAutomaticallyReplayIt() = kotlinx.coroutines.test.runTest {
        val work = PanelWork(this); val gate = CompletableDeferred<Unit>(); var reads = 0
        work.run { gate.await(); error("revision conflict") }; runCurrent()
        work.run(alert = false) { reads++ }; gate.complete(Unit); runCurrent()
        assertEquals("revision conflict", work.failure); assertTrue(work.showFailure); assertEquals(0, reads)
    }

    @Test fun oneTimeTaskIsAnAbsoluteMomentAndCompletesAfterItsRun() {
        val at = 1_790_000_000_000L
        val rule = ManagementApi.repeatRule("once", "", 0, 0, at = at + 30_000)
        assertEquals("once", rule.getString("kind")); assertEquals(at - at % 60_000, rule.getLong("at"))
        assertFails { ManagementApi.repeatRule("once", "", 0, 0, at = 0) }
        val saved = ManagementApi.withRepeat(JSONObject().put("name", "x"), rule)
        assertEquals("daily", saved.getString("frequency")); assertEquals(rule.getLong("at"), saved.getLong("nextRunAt")); assertEquals("once", saved.getJSONObject("repeat").getString("kind"))
        assertTrue(ManagementApi.oncePast(at, at)); assertTrue(ManagementApi.oncePast(at - 1, at)); assertFalse(ManagementApi.oncePast(at + 1, at))
        fun task(enabled: Boolean, lastRunAt: Long? = null, status: String? = null) = JSONObject().put("enabled", enabled).put("repeat", rule).also { t -> lastRunAt?.let { t.put("lastRunAt", it) }; status?.let { t.put("lastRunStatus", it) } }
        val waiting = task(true); val running = task(false, at + 1000, "running"); val done = task(false, at + 1000, "completed"); val paused = task(false); val earlyManual = task(false, at - 120_000, "completed")
        assertFalse(ManagementApi.isCompletedOnce(waiting)); assertFalse(ManagementApi.isCompletedOnce(running)); assertTrue(ManagementApi.isCompletedOnce(done))
        assertFalse(ManagementApi.isCompletedOnce(paused)); assertFalse(ManagementApi.isCompletedOnce(earlyManual))
        assertFalse(ManagementApi.isCompletedOnce(JSONObject().put("enabled", false).put("repeat", JSONObject().put("kind", "daily")).put("lastRunAt", at)))
        val (active, inactive, completed) = ManagementApi.sections(listOf(waiting, running, done, paused))
        assertEquals(listOf(waiting), active); assertEquals(listOf(running, paused), inactive); assertEquals(listOf(done), completed)
    }
    @Test fun permissionModeDefaultsToFullAccessForCoworkAndIsKeptForTheEditor() {
        assertEquals("bypass", ManagementApi.permissionOf(JSONObject().put("mode", "cowork")))
        assertNull(ManagementApi.permissionOf(JSONObject().put("mode", "code")))
        assertEquals("auto", ManagementApi.permissionOf(JSONObject().put("mode", "code").put("permission", "auto")))
        assertNull(ManagementApi.permissionOf(JSONObject().put("mode", "code").put("permission", "root")))
        val original = routine().put("permission", "default")
        val patched = ManagementApi.withPermission(ManagementApi.schedulePatch(original, enabled = false), "auto")
        assertEquals("auto", patched.getString("permission")); assertEquals("default", original.getString("permission")); assertEquals("preserved", patched.getString("unknownFutureField"))
        assertFails { ManagementApi.withPermission(original, "root") }
        val kept = JSONObject().put("alwaysAllowed", JSONArray().put(JSONObject().put("kind", "command").put("tool", "Run command").put("pattern", "npm test")).put(JSONObject().put("kind", "edit")))
        assertEquals(listOf(ScheduleAllowed("command", "Run command", "npm test")), ManagementApi.allowed(kept))
        // A save that does not touch the list sends it back as it was.
        assertEquals(2, ManagementApi.schedulePatch(kept.put("name", "n").put("prompt", "p")).getJSONArray("alwaysAllowed").length())
    }
    @Test fun oneTimePickersEditTheDayAndTheTimeInThePhonesZone() {
        val zone = java.time.ZoneId.of("Asia/Shanghai")
        val at = java.time.ZonedDateTime.of(2026, 10, 14, 15, 30, 0, 0, zone).toInstant().toEpochMilli()
        val day = OnceMoment.withDay(at, java.time.LocalDate.of(2026, 10, 20), zone)
        assertEquals(java.time.ZonedDateTime.of(2026, 10, 20, 15, 30, 0, 0, zone).toInstant().toEpochMilli(), day)
        assertEquals(java.time.ZonedDateTime.of(2026, 10, 14, 8, 5, 0, 0, zone).toInstant().toEpochMilli(), OnceMoment.withTime(at, 8, 5, zone))
        // The date picker names a day by its UTC midnight.
        assertEquals(java.time.LocalDate.of(2026, 10, 14), OnceMoment.dayOfPicker(OnceMoment.pickerMillis(at, zone)))
    }
}

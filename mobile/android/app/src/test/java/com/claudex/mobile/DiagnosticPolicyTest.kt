package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class DiagnosticPolicyTest {
    private val client = DiagnosticClient("0.8.1", "android", "arm64", "Android 16")
    private var clock = 1_000L
    private val queue = DiagnosticQueue(newId = { "11111111-1111-4111-8111-111111111111" }, now = { clock })

    @Test fun aFailedTurnKeepsTheCategoryNotTheOriginalText() {
        val secret = "timeout talking to user@example.com about sk-secretkey and /Users/a/secret.txt"
        queue.observe(listOf(FailedTurn("turn-1", secret, "sol")), true, client)
        val body = queue.payload(true, true)!!
        val report = body.getJSONArray("reports").getJSONObject(0)
        assertEquals("turn_error", report.getString("kind"))
        assertEquals("TURN_TIMEOUT", report.getString("code"))
        assertEquals("timeout", report.getString("message"))
        assertFalse(body.toString().contains("user@example.com"))
        assertFalse(body.toString().contains("sk-secretkey"))
        assertFalse(body.toString().contains("/Users/a"))
        assertTrue(body.getBoolean("consent"))
    }

    @Test fun nothingIsOfferedWithoutConsentOrCollection() {
        queue.observe(listOf(FailedTurn("turn-1", "connection reset", "sol")), true, client)
        assertNull(queue.payload(true, false))
        assertEquals(listOf("11111111-1111-4111-8111-111111111111"), queue.pendingIds)
        assertNull(queue.payload(false, true))
        assertTrue(queue.pendingIds.isEmpty())
    }

    @Test fun anOldFailureIsNotUploadedAfterConsent() {
        queue.observe(listOf(FailedTurn("old", "overloaded", "sol")), false, client)
        queue.observe(listOf(FailedTurn("old", "overloaded", "sol"), FailedTurn("new", "429 too many requests", "sol")), true, client)
        val body = queue.payload(true, true)!!
        assertEquals(1, body.getJSONArray("reports").length())
        assertEquals("TURN_RATE_LIMITED", body.getJSONArray("reports").getJSONObject(0).getString("code"))
    }

    @Test fun collectionIsOnlyABooleanTrue() {
        assertTrue(DiagnosticPolicy.serviceCollectsDiagnostics(JSONObject().put("data", JSONObject().put("features", JSONObject().put("diagnostics", true)))))
        assertFalse(DiagnosticPolicy.serviceCollectsDiagnostics(JSONObject().put("features", JSONObject().put("diagnostics", "true"))))
        assertFalse(DiagnosticPolicy.serviceCollectsDiagnostics(JSONObject()))
    }

    @Test fun aKnownClientSentenceStaysAndAPathInsideItWouldBeRemoved() {
        assertEquals("TURN_CLIENT", DiagnosticPolicy.describeTurnError("The Claudex service is unreachable.")?.code)
        assertEquals("see [path]", DiagnosticPolicy.redactMessage("see src/app/file.ts"))
    }

    @Test fun aRatingCarriesNoConversation() {
        val queue = DiagnosticQueue(newId = { "33333333-3333-4333-8333-333333333333" }, now = { clock })
        queue.recordFeedback("up", "sol", client)
        assertNull(queue.feedbackPayload(true, false))
        val body = queue.feedbackPayload(true, true)!!
        assertEquals("up", body.getString("rating"))
        assertTrue(body.isNull("conversation_excerpt"))
        assertEquals("", body.getString("comment"))
        assertNull(queue.feedbackPayload(false, true))
        assertTrue(queue.pendingFeedbackIds.isEmpty())
    }

    @Test fun aQueuedReportSurvivesARestartWithoutTheOriginalText() {
        val secret = "timeout talking to user@example.com about sk-secretkey and /Users/a/secret.txt"
        queue.observe(listOf(FailedTurn("turn-1", secret, "sol")), true, client)
        queue.recordFeedback("up", "sol", client)
        val directory = Files.createTempDirectory("diagnostics").toFile()
        val account = "person@example.com"
        val file = DiagnosticQueueFile.location(directory, account)
        assertFalse(file.path.contains("person@example.com"))
        assertNotEquals(file, DiagnosticQueueFile.location(directory, "other@example.com"))
        DiagnosticQueueFile.store(file, queue, true)
        val stored = file.readText()
        assertFalse(stored.contains("user@example.com"))
        assertFalse(stored.contains("sk-secretkey"))
        assertFalse(stored.contains("/Users/a"))
        assertFalse(stored.contains("person@example.com"))
        val revived = DiagnosticQueue(newId = { "22222222-2222-4222-8222-222222222222" }, now = { clock })
        DiagnosticQueueFile.load(file, revived)
        val report = revived.payload(true, true)!!.getJSONArray("reports").getJSONObject(0)
        assertEquals("TURN_TIMEOUT", report.getString("code"))
        assertEquals("timeout", report.getString("message"))
        assertEquals("up", revived.feedbackPayload(true, true)!!.getString("rating"))
        revived.observe(listOf(FailedTurn("turn-1", secret, "sol")), true, client)
        assertEquals(1, revived.payload(true, true)!!.getJSONArray("reports").length())
    }

    @Test fun consentOffKeepsTheTurnSeenAndDropsTheReport() {
        val directory = Files.createTempDirectory("diagnostics-off").toFile()
        val file = DiagnosticQueueFile.location(directory, "person@example.com")
        queue.observe(listOf(FailedTurn("old", "overloaded", "sol")), false, client)
        DiagnosticQueueFile.store(file, queue, false)
        val stored = file.readText()
        assertFalse(stored.contains("TURN_"))
        assertFalse(stored.contains("overloaded"))
        val revived = DiagnosticQueue(newId = { "22222222-2222-4222-8222-222222222222" }, now = { clock })
        DiagnosticQueueFile.load(file, revived)
        revived.observe(listOf(FailedTurn("old", "overloaded", "sol"), FailedTurn("new", "429 too many requests", "sol")), true, client)
        val rows = revived.payload(true, true)!!.getJSONArray("reports")
        assertEquals(1, rows.length())
        assertEquals("TURN_RATE_LIMITED", rows.getJSONObject(0).getString("code"))
    }

    @Test fun aDamagedQueueIsDeleted() {
        val directory = Files.createTempDirectory("diagnostics-bad").toFile()
        val file = DiagnosticQueueFile.location(directory, "person@example.com")
        file.parentFile?.mkdirs()
        file.writeText("""{"version":1,"diagnostics":[{"id":"11111111-1111-4111-8111-111111111111","turn_id":"turn-1","occurred_at":1,"code":"TURN_TIMEOUT","message":"user@example.com","model":"sol","app_version":"1","platform":"android","arch":"arm64","os_version":"Android 16"}],"feedback":[],"seen":[]}""")
        val revived = DiagnosticQueue()
        DiagnosticQueueFile.load(file, revived)
        assertFalse(file.exists())
        assertTrue(revived.pendingIds.isEmpty())
    }

    @Test fun aCrashKeepsTheTypeAndDropsTheMessage() {
        val crashed = DiagnosticQueue(newId = { "44444444-4444-4444-8444-444444444444" }, now = { clock })
        crashed.recordCrash(
            "IllegalStateException",
            listOf("AppViewModel.kt:10", "/Users/a/secret.txt:3", "user@example.com said sk-secret"),
            client,
        )
        crashed.recordCrash("user@example.com", emptyList(), client)
        val report = crashed.payload(true, true)!!.getJSONArray("reports").getJSONObject(0)
        assertEquals("crash", report.getString("kind"))
        assertEquals("IllegalStateException", report.getString("code"))
        assertEquals("IllegalStateException at AppViewModel.kt:10", report.getString("message"))
        val stored = crashed.document().toString()
        assertFalse(stored.contains("/Users/a"))
        assertFalse(stored.contains("user@example.com"))
        assertFalse(stored.contains("sk-secret"))
        val revived = DiagnosticQueue(now = { clock })
        assertTrue(revived.restore(crashed.document()))
        assertEquals("crash", revived.payload(true, true)!!.getJSONArray("reports").getJSONObject(0).getString("kind"))
        assertEquals("Error", revived.payload(true, true)!!.getJSONArray("reports").getJSONObject(1).getString("code"))
    }
}

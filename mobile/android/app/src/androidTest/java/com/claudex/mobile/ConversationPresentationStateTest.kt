package com.claudex.mobile

import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.claudex.core.Conversation
import com.claudex.core.Snapshot
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

/** Real Android Compose invalidation test. No Compose test rule, WebView or network fixture.
 * Replaces content only for this narrow production-helper test; never full-route pixel acceptance.
 */
@RunWith(AndroidJUnit4::class)
class ConversationPresentationStateTest {
    @Test fun unchangedConversationPublishesBusyOperationsFeedbackAndMedia() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val args = InstrumentationRegistry.getArguments()
        assertEquals("true", args.getString("qaFixtureOnly"))
        assertFalse(BuildConfig.DEMO_MODE)
        assertEquals("com.claudex.mobile", context.packageName)
        val expected = args.getString("expectedApkSha256").orEmpty()
        assertTrue(expected.matches(Regex("[0-9a-f]{64}")))
        val digest = MessageDigest.getInstance("SHA-256")
        File(context.applicationInfo.sourceDir).inputStream().use { input ->
            val bytes = ByteArray(65536)
            while (true) { val n = input.read(bytes); if (n < 0) break; digest.update(bytes, 0, n) }
        }
        assertEquals(expected, digest.digest().joinToString("") { "%02x".format(it) })
        val originHash = MessageDigest.getInstance("SHA-256").digest(BuildConfig.SERVER_ORIGIN.trimEnd('/').toByteArray()).joinToString("") { "%02x".format(it) }
        assertFalse("Never launch over account storage", context.getSharedPreferences("session-$originHash", 0).contains("encrypted"))

        val c = Conversation("fixture-state-publication", "State fixture", providerId = "fixture", model = "fixture")
        val snapshot = mutableStateOf(Snapshot(conversations = listOf(c)))
        val busy = mutableStateOf(false)
        val operations = mutableStateOf(emptySet<String>())
        val media = mutableStateOf(ConversationMedia())
        val unrelated = mutableStateOf(0)
        val observed = mutableListOf<ConversationPresentation>()
        var calls = 0
        val publish: (ConversationPresentation) -> Unit = { value ->
            calls++
            assertSame("Conversation identity must not change", c, value.conversation)
            if (shouldQueueConversationPresentation(value, null, null, observed.lastOrNull())) observed += value
        }
        val report = JSONObject().put("apkSha256", expected)
            .put("scope", "Actual Android Compose production presentation helper; no WebView, routes, flow collection, account or full-acceptance proof")
        val phases = JSONArray()
        var succeeded = false
        var scenario: ActivityScenario<MainActivity>? = null
        fun awaitValue(name: String, expectedCount: Int, predicate: (ConversationPresentation) -> Boolean) {
            val deadline = SystemClock.elapsedRealtime() + 20_000
            while (true) {
                var ready = false
                instrumentation.runOnMainSync { ready = observed.size == expectedCount && observed.lastOrNull()?.let(predicate) == true }
                if (ready) break
                if (SystemClock.elapsedRealtime() >= deadline) error("State publication timed out at $name")
                Thread.sleep(50)
            }
            instrumentation.runOnMainSync {
                val value = observed.last()
                phases.put(JSONObject().put("name", name).put("acceptedCount", observed.size).put("rawOfferCalls", calls)
                    .put("sameConversationIdentity", value.conversation === c).put("sending", value.sending)
                    .put("feedback", JSONObject(value.feedback)).put("media", value.media.json()))
            }
        }
        try {
            val activityScenario = ActivityScenario.launch(MainActivity::class.java)
            scenario = activityScenario
            activityScenario.onActivity { activity ->
                activity.setContent {
                    Text("State publication fixture ${unrelated.value}")
                    PublishConversationPresentation(c, false, snapshot, busy, operations, media, null, publish)
                }
            }
            awaitValue("initial", 1) { !it.sending && it.feedback.isEmpty() && it.media == ConversationMedia() }
            activityScenario.onActivity { busy.value = true }
            awaitValue("busy-true", 2) { it.sending }
            activityScenario.onActivity { busy.value = false }
            awaitValue("busy-false", 3) { !it.sending }
            activityScenario.onActivity { operations.value = setOf(c.id) }
            awaitValue("operation-start", 4) { it.sending }
            activityScenario.onActivity { operations.value = emptySet() }
            awaitValue("operation-clear-idle", 5) { !it.sending }
            val key = JSONArray(listOf(c.id, "turn")).toString()
            activityScenario.onActivity { snapshot.value = snapshot.value.copy(replyFeedback = mapOf(key to "up", "[\"other\",\"turn\"]" to "down")) }
            awaitValue("feedback-arrives", 6) { it.feedback == mapOf(key to "up") }
            activityScenario.onActivity { snapshot.value = snapshot.value.copy(replyFeedback = emptyMap()) }
            awaitValue("feedback-clears", 7) { it.feedback.isEmpty() }
            val preview = ConversationMedia(mapOf("fixture-image" to "data:image/png;base64,AA=="))
            activityScenario.onActivity { media.value = preview }
            awaitValue("media-arrives", 8) { it.media == preview }
            activityScenario.onActivity { media.value = ConversationMedia() }
            awaitValue("media-clears", 9) { it.media == ConversationMedia() }
            var callsBefore = 0
            instrumentation.runOnMainSync { callsBefore = calls }
            activityScenario.onActivity { unrelated.value++ }
            instrumentation.waitForIdleSync()
            Thread.sleep(1_000)
            instrumentation.runOnMainSync {
                assertEquals("Unrelated recomposition must not create a new delivery", 9, observed.size)
                assertTrue("No unbounded publish/recomposition loop", calls <= callsBefore + 2)
                report.put("rawOfferCallsAfterUnrelatedChange", calls).put("acceptedDeliveries", observed.size)
            }
            succeeded = true
        } catch (failure: Throwable) {
            report.put("failure", JSONObject().put("type", failure.javaClass.name).put("message", failure.message?.take(2048)).put("stack", failure.stackTraceToString().take(12_000)).put("stackTruncated", failure.stackTraceToString().length > 12_000))
            throw failure
        } finally {
            try { scenario?.close() } finally {
                report.put("status", if (succeeded) "PASS_STATE_PUBLICATION_HELPER" else "FAIL").put("phases", phases)
                val bytes = report.toString(2).toByteArray()
                check(bytes.size < 64 * 1024)
                instrumentation.sendStatus(2, Bundle().apply {
                    putString("qa_file_name", "presentation-state/${System.currentTimeMillis()}/state-publication.json")
                    putInt("qa_file_chunk", 0); putInt("qa_file_chunks", 1)
                    putString("qa_file_base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                })
            }
        }
    }
}

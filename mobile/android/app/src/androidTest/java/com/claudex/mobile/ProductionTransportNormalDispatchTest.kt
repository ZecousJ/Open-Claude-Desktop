package com.claudex.mobile

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.claudex.core.Connection
import com.claudex.core.Mode
import com.claudex.core.TurnStatus
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicLong
import com.claudex.mobile.LoopbackTransportFixture.Companion.CHAT
import com.claudex.mobile.LoopbackTransportFixture.Companion.TITLE
import com.claudex.mobile.LoopbackTransportFixture.Companion.PROMPT
import com.claudex.mobile.LoopbackTransportFixture.Companion.FIRST_TURN
import com.claudex.mobile.LoopbackTransportFixture.Companion.RETRY_TURN
import com.claudex.mobile.LoopbackTransportFixture.Companion.DELTA_ONE
import com.claudex.mobile.LoopbackTransportFixture.Companion.DELTA_TWO
import com.claudex.mobile.LoopbackTransportFixture.Companion.FIRST_FINAL
import com.claudex.mobile.LoopbackTransportFixture.Companion.RETRY_DELTA
import com.claudex.mobile.LoopbackTransportFixture.Companion.RETRY_FINAL
import com.claudex.mobile.LoopbackTransportFixture.Companion.RETRY_FAILURE
import com.claudex.mobile.LoopbackTransportFixture.Companion.REPLAY_POISON
import com.claudex.mobile.LoopbackTransportFixture.Companion.EMAIL
import com.claudex.mobile.LoopbackTransportFixture.Companion.PASSWORD

/**
 * Separate ordinary-dispatch control: deliberately NO Compose test APIs, rule or virtual clock.
 * The prior Compose-rule failure remains a distinct failed run, never reclassified by this test.
 *
 * Launches MainActivity's ORIGINAL ClaudexApp. No setContent, replacement screens, DemoRepository,
 * direct send/retry VM calls, receiveFrame calls, or post-seed repository/turn state writes.
 * The signed test runner supplies an Application-owned factory before Activity/VM construction.
 * NativeApi uses one ephemeral HTTPS/WSS loopback fixture and an in-memory credential store;
 * RemoteRepository and both normal VM collectors are constructed and retained without alteration.
 * Synthetic login drives the original navigation.
 * This proves only the client contract if it passes; never backend persistence or deployed streaming.
 */
@RunWith(AndroidJUnit4::class)
class ProductionTransportNormalDispatchTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val ui by lazy { NativeTransportUiDriver(instrumentation) }
    private var currentStage = "not-started"
    private var fixtureActivity: MainActivity? = null
    private var lastObservedProbe: JSONObject? = null
    private var bootstrapReloadUsed = false

    @Test fun ordinaryDispatcherComposerStreamsAndSharedRetryOverTls() {
        currentStage = "guards"
        val apkHash = enforceGuards()
        val evidence = Evidence(apkHash)
        val fixture = LoopbackTransportFixture(rejectFirstRetry = true)
        var scenario: ActivityScenario<MainActivity>? = null
        var vm: AppViewModel? = null
        var repo: RemoteRepository? = null
        var succeeded = false
        var primaryFailure: Throwable? = null
        var failureRecord: JSONObject? = null
        try {
            currentStage = "bind-before-launch"
            val fixtureApp = instrumentation.targetContext.applicationContext as? LoopbackFixtureApplication
                ?: error("Use the signed LoopbackFixtureRunner; the default runner cannot bind a fixture")
            instrumentation.runOnMainSync { fixtureApp.installOnce(AppNativeApiFactory { NativeApi(fixture.origin, fixture.vault, fixture.client) }) }
            currentStage = "launch-with-bound-factory"
            val activityScenario = ActivityScenario.launch(MainActivity::class.java)
            scenario = activityScenario
            activityScenario.onActivity { activity ->
                fixtureActivity = activity
                val model = ViewModelProvider(activity)[AppViewModel::class.java]
                assertNull("Fixture must begin signed out", model.api.session)
                val repository = model.repository as? RemoteRepository ?: error("Real RemoteRepository required")
                assertFalse(model.signedIn.value)
                assertEquals(fixture.origin, model.api.origin)
                assertSame(fixture.client, model.api.client)
                assertSame(repository.snapshot, model.snapshot)
                assertSame(repository.connection, model.connection)
                assertEquals(1, fixtureApp.createdModels)
                vm = model; repo = repository
            }
            val model = requireNotNull(vm)
            val repository = requireNotNull(repo)
            currentStage = "synthetic-login"
            loginThroughOriginalGraph(evidence)
            currentStage = "wait-initial-tls-websocket-ready"
            waitUntil { fixture.assertHealthy(); fixture.ready() && model.connection.value is Connection.Connected && model.snapshot.value.conversations.any { it.id == CHAT } }
            assertTrue(model.signedIn.value)
            assertEquals(EMAIL, model.api.session?.accountLabel)
            assertEquals(1, model.snapshot.value.conversations.size)
            assertTrue(model.snapshot.value.conversations.single().turns.isEmpty())
            assertEquals(0, fixture.count("send"))

            currentStage = "open-chat-and-compose"
            ui.touch("打开侧边栏", description = true)
            ui.revealForTouch(TITLE)
            evidence.environment("nativeReveal", JSONObject().put("observations", ui.revealEvidence()))
            ui.touch(TITLE)
            waitForText(TITLE)
            assertEquals(Mode.CHAT, model.snapshot.value.conversations.single().mode)
            prepareRendererForNarrowControl(evidence)
            ui.input("消息输入框", PROMPT, description = true)
            settleImeAfterInput(evidence, "composer")
            assertEquals(PROMPT, model.draft.value)
            val before = diagnosticUiProbe()
            assertOrdinaryDispatcher(before)
            evidence.environment("ordinaryScopeBeforeSend", before)
            evidence.environment("nativeTouchGeometry", JSONObject().put("observations", ui.hitEvidence()))
            // One real native UI touch, no vm.send(), repository.send(), or injected bridge action.
            currentStage = "composer-send"
            ui.touch("发送", description = true)
            currentStage = "wait-send-response"
            waitUntil { fixture.assertHealthy(); fixture.count("send") == 1 && currentTurn(model)?.id == FIRST_TURN && !model.busy.value }
            assertEquals("Composer clears after the accepted HTTP response", "", model.draft.value)
            assertEquals(PROMPT, currentTurn(model)?.prompt)
            assertEquals(TurnStatus.IN_PROGRESS, currentTurn(model)?.status)
            ui.assertEnabled("停止", true, description = true)

            fixture.advance(FIRST_TURN, DELTA_ONE, completed = false)
            observeStage(activityScenario, model, fixture, evidence, "01-delta-one", FIRST_TURN, DELTA_ONE, TurnStatus.IN_PROGRESS)
            fixture.advance(FIRST_TURN, DELTA_TWO, completed = false)
            observeStage(activityScenario, model, fixture, evidence, "02-delta-two", FIRST_TURN, DELTA_TWO, TurnStatus.IN_PROGRESS)

            currentStage = "03-stale-sequence-barrier"
            val featureRevision = repository.featureUpdates.value
            fixture.replayOldSequenceThenBarrier()
            waitUntil { fixture.assertHealthy(); repository.featureUpdates.value == featureRevision + 1 }
            assertEquals("Stale sequence must not overwrite the second update", DELTA_TWO, currentTurn(model)?.items?.single()?.text)
            val duplicate = visibleReply(activityScenario, DELTA_TWO)
            assertTrue("Second update must remain visibly rendered after receive-order barrier", duplicate.getBoolean("visible"))
            evidence.json("03-stale-sequence-rejected.json", duplicate.put("featureRevisionBefore", featureRevision)
                .put("featureRevisionAfter", repository.featureUpdates.value).put("receiveOrderBarrier", "service-changed seq 3"))

            fixture.advance(FIRST_TURN, FIRST_FINAL, completed = true)
            observeStage(activityScenario, model, fixture, evidence, "04-first-terminal", FIRST_TURN, FIRST_FINAL, TurnStatus.COMPLETED)
            ui.assertAbsent("停止", description = true)
            assertEquals(1, fixture.count("send"))
            assertEquals(0, fixture.count("retryResponse"))

            // Locate the canonical React ReplyVersions Retry button read-only, then dispatch a real
            // native touch at its checked on-screen center. No evaluateJavascript(...click()).
            currentStage = "05-retry-cancel-open"
            touchSharedRetry(activityScenario, evidence)
            waitForText("重新生成回复？")
            assertEquals("Opening confirmation must not mutate the backend contract", 0, fixture.count("retryResponse"))
            ui.touch("取消")
            waitUntil { !ui.hasText("重新生成回复？") }
            ui.assertAbsent("重新生成回复？")
            assertEquals("Cancel must not issue retryResponse", 0, fixture.count("retryResponse"))
            assertEquals(FIRST_FINAL, currentTurn(model)?.items?.single()?.text)
            val cancelBoundary = ordinaryPresentationBoundary(activityScenario)
            assertTrue("Cancel presentation must settle", cancelBoundary.getBoolean("completed"))
            val cancelStarted = SystemClock.elapsedRealtime()
            var cancelUi = JSONObject()
            while (SystemClock.elapsedRealtime() - cancelStarted < 1_000) {
                cancelUi = terminalUiProbe(activityScenario)
                assertEquals("An explicit user decline is not a shared error", 0, cancelUi.getInt("errorCount"))
                Thread.sleep(100)
            }
            evidence.json("05-retry-cancel.json", JSONObject().put("retryRpcCount", 0).put("originalReplyPreserved", true)
                .put("observedNoErrorMs", SystemClock.elapsedRealtime() - cancelStarted).put("ui", cancelUi)
                .put("settledScreenshot", evidence.screenshot("05-retry-cancel-settled.png")))

            currentStage = "05b-retry-http-error"
            touchSharedRetry(activityScenario, evidence)
            waitForText("重新生成回复？")
            ui.touch("继续")
            waitUntil { fixture.assertHealthy(); fixture.count("retryResponse") == 1 && model.conversationActions.value.isEmpty() }
            assertEquals("A rejected HTTP retry must preserve the original turn", FIRST_TURN, currentTurn(model)?.id)
            assertEquals(FIRST_FINAL, currentTurn(model)?.items?.single()?.text)
            assertTrue(model.snapshot.value.conversations.single().savedBranches.isEmpty())
            var rejected = JSONObject()
            waitUntil { rejected = sharedErrorProbe(activityScenario); rejected.optBoolean("visible") && rejected.optString("errorText") == RETRY_FAILURE }
            val rejectionBoundary = ordinaryPresentationBoundary(activityScenario)
            assertTrue(rejectionBoundary.getBoolean("completed"))
            Thread.sleep(1_000)
            rejected = sharedErrorProbe(activityScenario)
            assertTrue("Genuine HTTP failure must stay visibly reported", rejected.getBoolean("visible"))
            assertEquals(RETRY_FAILURE, rejected.getString("errorText"))
            evidence.json("05b-retry-http-error.json", rejected.put("httpStatus", 422)
                .put("fixtureOnly", true).put("retryRpcCount", fixture.count("retryResponse"))
                .put("originalTurnPreserved", true).put("repository", repositoryProbe(model, repository))
                .put("settledScreenshot", evidence.screenshot("05b-retry-http-error-settled.png")))

            currentStage = "06-retry-confirm-open"
            touchSharedRetry(activityScenario, evidence)
            waitForText("重新生成回复？")
            currentStage = "06-retry-confirm-click"
            ui.touch("继续")
            currentStage = "06-wait-retry-response"
            waitUntil { fixture.assertHealthy(); fixture.count("retryResponse") == 2 && currentTurn(model)?.id == RETRY_TURN && model.conversationActions.value.isEmpty() }
            assertEquals(TurnStatus.IN_PROGRESS, currentTurn(model)?.status)
            assertEquals(2, fixture.count("retryResponse"))
            assertEquals(1, fixture.count("send"))
            assertEquals("Retry must preserve the prior branch returned by the contract", FIRST_FINAL,
                model.snapshot.value.conversations.single().savedBranches.single().turns.single().items.single().text)
            fixture.advance(RETRY_TURN, RETRY_DELTA, completed = false)
            observeStage(activityScenario, model, fixture, evidence, "06-retry-delta", RETRY_TURN, RETRY_DELTA, TurnStatus.IN_PROGRESS)
            fixture.advance(RETRY_TURN, RETRY_FINAL, completed = true)
            observeStage(activityScenario, model, fixture, evidence, "07-retry-terminal", RETRY_TURN, RETRY_FINAL, TurnStatus.COMPLETED)
            ui.assertAbsent("停止", description = true)
            ui.assertEnabled("发送", false, description = true)
            val after = diagnosticUiProbe()
            assertOrdinaryDispatcher(after)
            evidence.environment("ordinaryScopeAfterRetry", after)
            evidence.environment("nativeTouchGeometry", JSONObject().put("observations", ui.hitEvidence()))
            currentStage = "final-contract-assertions"
            fixture.assertComplete()
            succeeded = true
        } catch (failure: Throwable) {
            primaryFailure = failure
            val record = throwableEvidence(failure).put("stage", currentStage)
                .put("lastObservedProbe", lastObservedProbe ?: JSONObject.NULL)
                .put("repository", repositoryProbe(vm, repo))
            failureRecord = record
            record.put("nativeTouchGeometry", ui.hitEvidence())
            record.put("nativeReveal", ui.revealEvidence())
            try { record.put("nativeHierarchy", ui.hierarchy()) } catch (diagnostic: Throwable) {
                failure.addSuppressed(diagnostic); record.put("hierarchyFailure", throwableEvidence(diagnostic))
            }
            // None of these diagnostics waits for Compose idle; an earlier Compose/coroutine
            // exception must not hide the actual UI/model state or prevent a raw screenshot.
            try { record.put("currentUi", diagnosticUiProbe()) } catch (diagnostic: Throwable) {
                failure.addSuppressed(diagnostic); record.put("uiDiagnosticFailure", throwableEvidence(diagnostic))
            }
            try { record.put("failureScreenshot", evidence.screenshot("failure.png", synchronizeWithNativeIdle = false)) }
            catch (diagnostic: Throwable) { failure.addSuppressed(diagnostic); record.put("screenshotFailure", throwableEvidence(diagnostic)) }
            try { evidence.json("failure.json", record) } catch (diagnostic: Throwable) { failure.addSuppressed(diagnostic) }
            throw failure
        } finally {
            val cleanupFailures = JSONArray()
            var firstCleanupFailure: Throwable? = null
            fun cleanup(label: String, action: () -> Unit) {
                try { action() } catch (failure: Throwable) {
                    cleanupFailures.put(throwableEvidence(failure).put("action", label))
                    val original = primaryFailure
                    if (original != null) original.addSuppressed(failure)
                    else if (firstCleanupFailure == null) firstCleanupFailure = failure
                    else firstCleanupFailure?.addSuppressed(failure)
                }
            }
            // Preserve primary test failure even if any write, lifecycle callback or shutdown fails.
            cleanup("write-transport-ledger") { evidence.json("transport-ledger.json", fixture.evidence()) }
            cleanup("mark-fixture-closing") { fixture.expectClose() }
            // Activity finish owns onStop/event shutdown and ViewModelStore/scope destruction.
            // Never cancel collector jobs or swap dependencies, including during fixture setup.
            cleanup("close-activity") { scenario?.close() }
            fixtureActivity = null
            cleanup("close-loopback-fixture") { fixture.close() }
            cleanup("write-result") {
                evidence.json("result.json", JSONObject().put("status", if (succeeded && cleanupFailures.length() == 0) { if (bootstrapReloadUsed) "PASS_RECOVERED_CLIENT_CONTRACT_WITH_FAILED_COLD_BOOTSTRAP" else "PASS_CLIENT_CONTRACT" } else "FAIL")
                    .put("bootstrapReloadUsed", bootstrapReloadUsed).put("coldBootstrap", if (bootstrapReloadUsed) "FAIL_PRESERVED" else "NO_RECOVERY_USED")
                    .put("lastStage", currentStage).put("cleanupFailures", cleanupFailures)
                    .put("assertionScope", "Original root, synthetic HTTPS login, HTTPS send, WSS ordered whole-turn updates and stale-sequence rejection, visible transcript, quiet user cancellation, real local HTTP422 rejection preserved, same-target confirmed retry clears only its previous failure")
                    .put("dependencyBinding", "Application-owned factory before Activity/ViewModel construction")
                    .put("disabledVmCollectors", JSONArray())
                    .put("collectorCoverage", "Both collectors are retained; this streaming case alone does not certify session cleanup or settings propagation")
                    .put("notProven", JSONArray(listOf("real account", "deployed events-ticket", "model output", "real backend persistence", "general mutation idempotency", "network failure recovery", "401/logout/account rotation/instructions assertions", "attachment picker/upload", "pixel review", "whole-app acceptance"))))
            }
            failureRecord?.let { record -> cleanup("write-original-failure-with-cleanup") {
                record.put("cleanupFailures", cleanupFailures)
                record.put("suppressed", JSONArray(primaryFailure?.suppressed?.take(12)?.map { throwableEvidence(it) }.orEmpty()))
                evidence.json("failure.json", record)
            } }
            cleanup("export-registered-evidence") { evidence.exportRegisteredFilesOnly() }
            if (primaryFailure == null) firstCleanupFailure?.let { throw it }
        }
    }

    private fun throwableEvidence(t: Throwable) = TransportContractDiagnostics.failure(t)
    private fun repositoryProbe(vm: AppViewModel?, repo: RemoteRepository?) = TransportContractDiagnostics.repository(vm, repo)
    private fun diagnosticUiProbe() = TransportContractDiagnostics.ui(fixtureActivity)

    private fun enforceGuards(): String {
        val context = instrumentation.targetContext
        val args = InstrumentationRegistry.getArguments()
        assertFalse("Demo APK prohibited", BuildConfig.DEMO_MODE)
        assertEquals("com.claudex.mobile", context.packageName)
        assertEquals("Explicit fixture invocation required", "true", args.getString("qaFixtureOnly"))
        assertEquals("Explicit loopback transport opt-in required", "true", args.getString("qaLoopbackTransport"))
        assertEquals("Production host must remain unmodified", "readOnly", args.getString("qaWebHostProbe") ?: "readOnly")
        val expected = args.getString("expectedApkSha256").orEmpty().lowercase()
        assertTrue("Exact installed APK SHA-256 required", expected.matches(Regex("[0-9a-f]{64}")))
        val actual = sha256(File(context.applicationInfo.sourceDir))
        assertEquals("Installed artifact mismatch", expected, actual)
        val originHash = MessageDigest.getInstance("SHA-256").digest(BuildConfig.SERVER_ORIGIN.trimEnd('/').toByteArray()).joinToString("") { "%02x".format(it) }
        // Presence only, before launch: never call SessionVault.load() over existing account storage.
        assertFalse("Existing session storage: use a clean disposable emulator", context.getSharedPreferences("session-$originHash", 0).contains("encrypted"))
        return actual
    }
    private fun loginThroughOriginalGraph(evidence: Evidence) {
        waitForText("欢迎使用 Claudex")
        ui.assertEnabled("继续", false)
        ui.syntheticLoginInput("邮箱地址", EMAIL)
        ui.syntheticLoginContinue()
        waitForText("账户密码")
        ui.syntheticLoginInput("账户密码", PASSWORD)
        ui.syntheticLoginContinue()
        waitForText("今天想探索什么？")
        evidence.environment("authSetup", JSONObject().put("method", "Exact fixed credentials via ACTION_SET_TEXT without focus/touch; app-owned login Continue ACTION_CLICK")
            .put("preservedPath", "Original login handler, ViewModel, NativeApi HTTPS login and root navigation")
            .put("physicalLoginTouchAcceptance", false).put("nativeGeometry", ui.hitEvidence()))
    }

    /** Passive keyboard/frame settling. A single early hidden sample cannot permit a later touch. */
    private fun settleImeAfterInput(evidence: Evidence, name: String) {
        val activity = requireNotNull(fixtureActivity)
        val started = SystemClock.elapsedRealtime()
        val deadline = started + 20_000 // Same bounded wait budget as other normal-control conditions.
        val samples = JSONArray()
        val record = JSONObject().put("startedElapsedMs", started).put("timeoutMs", 20_000)
            .put("minimumNoImeObservationMs", 3_000).put("stableHiddenMs", 1_000)
            .put("method", "Native insets + ordinary frame callbacks; Back only after visible IME; no forced layout or input API change")
        var totalSamples = 0
        var backSent = false
        var sawVisible = false
        val firstFrame = AtomicLong(0); val secondFrame = AtomicLong(0)
        fun requestOrdinaryFrames() {
            firstFrame.set(0); secondFrame.set(0)
            instrumentation.runOnMainSync { activity.window.decorView.postOnAnimation {
                firstFrame.set(SystemClock.elapsedRealtime())
                activity.window.decorView.postOnAnimation { secondFrame.set(SystemClock.elapsedRealtime()) }
            } }
        }
        fun observe(): JSONObject {
            val value = AtomicReference<JSONObject>()
            instrumentation.runOnMainSync {
                val decor = activity.window.decorView
                val insets = androidx.core.view.ViewCompat.getRootWindowInsets(decor)
                val ime = androidx.core.view.WindowInsetsCompat.Type.ime()
                val frame = Rect().also(decor::getWindowVisibleDisplayFrame)
                value.set(JSONObject().put("elapsedMs", SystemClock.elapsedRealtime()).put("insetsAvailable", insets != null)
                    .put("imeVisible", insets?.isVisible(ime) == true).put("imeBottom", insets?.getInsets(ime)?.bottom ?: -1)
                    .put("windowFocused", decor.hasWindowFocus()).put("layoutRequested", decor.isLayoutRequested)
                    .put("visibleFrame", frame.toShortString()))
            }
            return requireNotNull(value.get()).also { sample ->
                totalSamples++
                if (samples.length() < 100) samples.put(sample) else samples.put(99, sample)
            }
        }
        fun stableHidden(sample: JSONObject) = sample.getBoolean("insetsAvailable") && !sample.getBoolean("imeVisible") &&
            sample.getInt("imeBottom") == 0 && sample.getBoolean("windowFocused") && !sample.getBoolean("layoutRequested")
        var hiddenSince = 0L
        var settled = false
        var originalFailure: Throwable? = null
        try {
            requestOrdinaryFrames()
            while (SystemClock.elapsedRealtime() < deadline) {
                val sample = observe()
                val now = sample.getLong("elapsedMs")
                if (sample.getBoolean("imeVisible")) {
                    sawVisible = true; hiddenSince = 0
                    if (!backSent) {
                        // Reobserve immediately before Back; if it already hid, simply settle.
                        val beforeBack = observe()
                        if (beforeBack.getBoolean("imeVisible")) {
                            record.put("beforeBack", beforeBack)
                            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                            backSent = true
                            record.put("backSentElapsedMs", SystemClock.elapsedRealtime())
                            requestOrdinaryFrames()
                        }
                    }
                } else if (stableHidden(sample)) {
                    if (hiddenSince == 0L) hiddenSince = now
                    val minimumObservation = if (sawVisible) 0L else 3_000L
                    if (secondFrame.get() > 0 && now - started >= minimumObservation && now - hiddenSince >= 1_000) {
                        settled = true; break
                    }
                } else hiddenSince = 0
                Thread.sleep(100)
            }
            check(settled) { "IME did not reach stable hidden insets at $name; no unsafe touch permitted" }
        } catch (failure: Throwable) { originalFailure = failure; throw failure }
        finally {
            record.put("settled", settled).put("sawVisibleIme", sawVisible).put("backSent", backSent)
                .put("firstOrdinaryFrameElapsedMs", firstFrame.get()).put("secondOrdinaryFrameElapsedMs", secondFrame.get())
                .put("completedElapsedMs", SystemClock.elapsedRealtime()).put("totalSamples", totalSamples)
                .put("samplesTruncated", totalSamples > 100).put("samples", samples)
            try { evidence.environment("imeAfterInput-$name", record) }
            catch (writeFailure: Throwable) { val prior = originalFailure; if (prior != null) prior.addSuppressed(writeFailure) else throw writeFailure }
        }
    }
    /** One real native recovery only to isolate the ordinary-dispatch send/retry control.
     * A failed first bootstrap is retained as failed, never promoted by the warm result. */
    private fun prepareRendererForNarrowControl(evidence: Evidence) {
        currentStage = "renderer-before-send"
        var first = JSONObject()
        fun applied(probe: JSONObject): Boolean {
            val c = probe.optJSONObject("controller") ?: return false
            return probe.optBoolean("completed") && c.optBoolean("ready") && !c.optBoolean("broken") &&
                c.optLong("appliedRevision") > 0 && probe.optJSONObject("dom")?.optDouble("rootHeight", 0.0)?.let { it > 0 } == true
        }
        waitUntil {
            first = diagnosticUiProbe(); lastObservedProbe = first
            first.optJSONObject("controller")?.optBoolean("broken") == true || applied(first)
        }
        if (applied(first)) {
            assertOrdinaryDispatcher(first)
            evidence.environment("rendererBeforeSend", JSONObject().put("coldBootstrap", "READY_WITHIN_NATIVE_POLICY").put("probe", first))
            return
        }
        val errorText = "共享对话资源未能加载，请检查应用安装包"
        waitForText(errorText)
        waitForText("重新加载对话界面")
        val record = JSONObject().put("coldBootstrap", "FAIL_PRESERVED").put("before", first)
            .put("elapsedTimeoutInferredFromExactNativeError", true)
            .put("scope", "One visible native Reload for narrow ordinary-dispatch transport control; cold acceptance remains failed")
        record.put("errorScreenshot", evidence.screenshot("00-cold-bootstrap-error.png"))
        evidence.environment("rendererBeforeSend", record)
        val oldController = first.getJSONObject("controller")
        bootstrapReloadUsed = true
        currentStage = "renderer-native-reload"
        ui.touch("重新加载对话界面")
        var recovered = JSONObject()
        waitUntil {
            recovered = diagnosticUiProbe(); lastObservedProbe = recovered
            if (recovered.optJSONObject("controller")?.optBoolean("broken") == true) {
                throw AssertionError("The one permitted native renderer Reload failed: $recovered")
            }
            applied(recovered)
        }
        assertNotEquals(first.getInt("webViewIdentity"), recovered.getInt("webViewIdentity"))
        assertNotEquals(oldController.getInt("identity"), recovered.getJSONObject("controller").getInt("identity"))
        assertNotEquals(oldController.getString("leaseId"), recovered.getJSONObject("controller").getString("leaseId"))
        assertOrdinaryDispatcher(recovered)
        record.put("recovered", recovered).put("recovery", "FRESH_VIEW_CONTROLLER_LEASE_APPLIED")
        evidence.environment("rendererBeforeSend", record)
    }
    private fun assertOrdinaryDispatcher(probe: JSONObject) {
        assertTrue("Ordinary-dispatch read-only probe must complete: $probe", probe.optBoolean("completed"))
        val interceptor = probe.getJSONObject("controller").getString("scopeInterceptor")
        assertFalse("Compose test interceptor must not be installed", interceptor.contains("ApplyingContinuationInterceptor") || interceptor.contains("FrameDeferringContinuationInterceptor"))
        assertTrue("Actual controller scope must remain active", probe.getJSONObject("controller").getBoolean("scopeJobActive"))
        assertTrue("Read-only callback must run on the UI thread", probe.getBoolean("probeCallbackOnMain"))
    }
    private fun currentTurn(vm: AppViewModel) = vm.snapshot.value.conversations.singleOrNull { it.id == CHAT }?.turns?.singleOrNull()
    private fun observeStage(scenario: ActivityScenario<MainActivity>, vm: AppViewModel, fixture: LoopbackTransportFixture,
        evidence: Evidence, name: String, turnId: String, text: String, status: TurnStatus) {
        val record = JSONObject().put("expectedTurnId", turnId).put("expectedStatus", status.name).put("expectedText", text)
            .put("pixelReview", "UNREVIEWED; DOM/bounds alone are not painted-pixel acceptance")
        try {
            currentStage = "$name:repository"
            waitUntil { fixture.assertHealthy(); currentTurn(vm)?.let { it.id == turnId && it.status == status && it.items.singleOrNull()?.text == text } == true }
            record.put("repository", repositoryProbe(vm, vm.repository as? RemoteRepository))
            currentStage = "$name:dom"
            var observed = JSONObject()
            waitUntil { observed = visibleReply(scenario, text); lastObservedProbe = observed; observed.optBoolean("visible") }
            assertEquals(text, observed.getString("replyText"))
            assertFalse(observed.getString("bodyText").contains(REPLAY_POISON))
            if (turnId == RETRY_TURN) {
                waitUntil { terminalUiProbe(scenario).getInt("errorCount") == 0 }
                record.put("sameTargetHttpErrorCleared", true)
            }
            record.put("firstProbe", observed).put("sendRpcCount", fixture.count("send")).put("retryRpcCount", fixture.count("retryResponse"))
            currentStage = "$name:first-screenshot"
            // Keep first and settled pixels separately: Compose idle/DOM match does not prove that
            // Chromium's latest display list has reached the captured Android surface.
            record.put("first", evidence.screenshot("$name-first.png"))
            currentStage = "$name:presentation-boundary"
            val boundary = ordinaryPresentationBoundary(scenario)
            record.put("presentationBoundary", boundary)
            assertTrue("Visual-state/two-frame callback timed out: $boundary", boundary.getBoolean("completed"))
            val settleStarted = SystemClock.elapsedRealtime()
            Thread.sleep(1_000) // Test thread only; no forced invalidate/layout/JS or render mutation.
            record.put("minimumSettleMs", 1_000).put("settleStartedElapsedMs", settleStarted)
                .put("settleCompletedElapsedMs", SystemClock.elapsedRealtime())
            currentStage = "$name:settled-probe"
            val settled = visibleReply(scenario, text)
            lastObservedProbe = settled
            record.put("settledProbe", settled)
            assertTrue("Expected reply lost visibility during settling: $settled", settled.getBoolean("visible"))
            assertEquals(text, settled.getString("replyText"))
            currentStage = "$name:settled-screenshot"
            record.put("settled", evidence.screenshot("$name-settled.png"))
            if (status == TurnStatus.COMPLETED) {
                val terminal = terminalUiProbe(scenario)
                record.put("terminalUi", terminal)
                assertEquals("No error banner after successful completion", 0, terminal.getInt("errorCount"))
                assertEquals("Canonical completed reply keeps one static end mark", 1, terminal.getInt("endMarkCount"))
                assertTrue("Completed end mark must remain visibly inside this fixture viewport", terminal.getBoolean("visible"))
                assertEquals("Streaming marker must be gone", 0, terminal.getInt("streamMarkCount"))
                assertEquals("Thinking/tool activity row must be gone", 0, terminal.getInt("activityCount"))
                assertTrue("Animation inspection must be supported", terminal.getBoolean("animationInspectionSupported"))
                assertEquals("Static end star must have no active animation", 0, terminal.getInt("activeEndAnimations"))
                assertTrue("Static end star CSS must have no animation", terminal.getBoolean("endStylesStatic"))
            }
            currentStage = "$name:observed"
        } catch (failure: Throwable) {
            record.put("failureStage", currentStage).put("originalFailure", throwableEvidence(failure))
                .put("repositoryAtFailure", repositoryProbe(vm, vm.repository as? RemoteRepository))
                .put("lastObservedProbe", lastObservedProbe ?: JSONObject.NULL)
            try { evidence.json("$name.json", record) } catch (writeFailure: Throwable) { failure.addSuppressed(writeFailure) }
            throw failure
        }
        evidence.json("$name.json", record)
    }

    private fun ordinaryPresentationBoundary(scenario: ActivityScenario<MainActivity>): JSONObject {
        check(Looper.myLooper() != Looper.getMainLooper()) { "Presentation waits must run off-main" }
        val latch = CountDownLatch(1)
        val visualAt = AtomicLong(0); val frameOneAt = AtomicLong(0); val frameTwoAt = AtomicLong(0)
        val started = SystemClock.elapsedRealtime()
        scenario.onActivity { activity ->
            val view = descendants(activity.window.decorView).filterIsInstance<WebView>().single()
            assertEquals(ConversationBridgePolicy.ENTRY, view.url)
            view.postVisualStateCallback(started, object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) {
                    visualAt.set(SystemClock.elapsedRealtime())
                    view.postOnAnimation {
                        frameOneAt.set(SystemClock.elapsedRealtime())
                        view.postOnAnimation { frameTwoAt.set(SystemClock.elapsedRealtime()); latch.countDown() }
                    }
                }
            })
        }
        val completed = latch.await(6, TimeUnit.SECONDS)
        return JSONObject().put("completed", completed).put("timeoutMs", 6_000)
            .put("startedElapsedMs", started).put("visualStateElapsedMs", visualAt.get())
            .put("frameOneElapsedMs", frameOneAt.get()).put("frameTwoElapsedMs", frameTwoAt.get())
            .put("returnedElapsedMs", SystemClock.elapsedRealtime())
            .put("method", "WebView visual-state callback then two ordinary postOnAnimation callbacks; no forced draw/layout")
    }
    private fun visibleReply(scenario: ActivityScenario<MainActivity>, expected: String): JSONObject = probe(scenario, """
        const roots = [...document.querySelectorAll('.turn[data-latest="true"] .assistant-message .markdown')];
        const root = roots.length === 1 ? roots[0] : null;
        const expected = ${JSONObject.quote(expected)}, replyText = root?.textContent ?? '';
        if (!root || replyText !== expected) return {visible:false,markdownCount:roots.length,replyText};
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
        let node;
        while ((node=walker.nextNode())) { if (node.textContent.length) nodes.push(node); }
        if (!nodes.length || nodes.map(n=>n.textContent).join('')!==expected) return {visible:false,replyText,error:'text interval mismatch'};
        // The canonical renderer wraps deltas in separate span.stream-chunk nodes. This range
        // spans the exact full descendant-text interval rather than assuming a single text node.
        const range = document.createRange();
        range.setStart(nodes[0],0); range.setEnd(nodes[nodes.length-1],nodes[nodes.length-1].textContent.length);
        const rects = [...range.getClientRects()];
        const clip = document.querySelector('[aria-label="Chat messages"]')?.getBoundingClientRect();
        const serialized = r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom});
        function effectiveClip(element) {
          let left=0, top=0, right=innerWidth, bottom=innerHeight, stylesVisible=true;
          if (clip) { left=Math.max(left,clip.left); top=Math.max(top,clip.top); right=Math.min(right,clip.right); bottom=Math.min(bottom,clip.bottom); }
          for (; element; element=element.parentElement) {
            const style=getComputedStyle(element), r=element.getBoundingClientRect();
            if (style.display==='none' || style.visibility!=='visible' || Number(style.opacity)<=0) stylesVisible=false;
            if (/^(hidden|clip|scroll|auto)$/.test(style.overflowX)) { left=Math.max(left,r.left); right=Math.min(right,r.right); }
            if (/^(hidden|clip|scroll|auto)$/.test(style.overflowY)) { top=Math.max(top,r.top); bottom=Math.min(bottom,r.bottom); }
          }
          return {left,top,right,bottom,stylesVisible};
        }
        const inside=(r,c)=>c.stylesVisible && r.width>0 && r.height>0 &&
          r.left>=c.left && r.top>=c.top && r.right<=c.right && r.bottom<=c.bottom;
        const rootClip=effectiveClip(root);
        // Descendant stream spans can have their own clipping. Check each contributing text node
        // against only its own ancestor chain, never against sibling span bounds.
        const textNodes=nodes.map(textNode=>{
          const nodeRange=document.createRange(); nodeRange.selectNodeContents(textNode);
          const nodeRects=[...nodeRange.getClientRects()], nodeClip=effectiveClip(textNode.parentElement);
          return {text:textNode.textContent,clip:nodeClip,rects:nodeRects.map(serialized),
            visible:nodeRects.length>0 && nodeRects.every(r=>inside(r,nodeClip))};
        });
        const visible = !!(clip && range.toString()===expected && rects.length &&
          rects.every(r=>inside(r,rootClip)) && textNodes.every(n=>n.visible));
        return {visible,replyText,markdownCount:roots.length,textNodeCount:nodes.length,rangeText:range.toString(),
          bodyText:document.body.innerText.slice(0,4096),clip:rootClip,rects:rects.map(serialized),textNodes};
    """.trimIndent())

    private fun sharedErrorProbe(scenario: ActivityScenario<MainActivity>): JSONObject = probe(scenario, """
        const nodes=[...document.querySelectorAll('.mobile-conversation-error[role="alert"]')];
        if(nodes.length!==1)return {visible:false,errorCount:nodes.length};
        const element=nodes[0],rect=element.getBoundingClientRect();
        let left=0,top=0,right=innerWidth,bottom=innerHeight,stylesVisible=true;
        for(let node=element;node;node=node.parentElement){
          const style=getComputedStyle(node),box=node.getBoundingClientRect();
          if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)<=0)stylesVisible=false;
          if(/^(hidden|clip|scroll|auto)$/.test(style.overflowX)){left=Math.max(left,box.left);right=Math.min(right,box.right);}
          if(/^(hidden|clip|scroll|auto)$/.test(style.overflowY)){top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
        }
        return {visible:stylesVisible&&rect.width>0&&rect.height>0&&rect.left>=left&&rect.top>=top&&rect.right<=right&&rect.bottom<=bottom,
          errorCount:1,errorText:[...element.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim(),
          rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}};
    """.trimIndent())

    private fun terminalUiProbe(scenario: ActivityScenario<MainActivity>): JSONObject = probe(scenario, """
        const latest=document.querySelector('.turn[data-latest="true"]');
        const ends=[...(latest?.querySelectorAll('.response-end-mark')||[])];
        const elements=ends.flatMap(e=>[e,...e.querySelectorAll('*')]);
        const styles=elements.map(e=>({tag:e.tagName,animationName:getComputedStyle(e).animationName,
          animationPlayState:getComputedStyle(e).animationPlayState,transform:getComputedStyle(e).transform}));
        const supported=typeof document.getAnimations==='function';
        const animations=supported?document.getAnimations().filter(a=>{
          const target=a.effect?.target;return target instanceof Element && ends.some(e=>e===target||e.contains(target));
        }):[];
        const rect=ends[0]?.getBoundingClientRect();
        let left=0,top=0,right=innerWidth,bottom=innerHeight,stylesVisible=true;
        for(let node=ends[0];node;node=node.parentElement){
          const style=getComputedStyle(node),box=node.getBoundingClientRect();
          if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)<=0)stylesVisible=false;
          if(/^(hidden|clip|scroll|auto)$/.test(style.overflowX)){left=Math.max(left,box.left);right=Math.min(right,box.right);}
          if(/^(hidden|clip|scroll|auto)$/.test(style.overflowY)){top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
        }
        const visible=!!(stylesVisible&&rect&&rect.width>0&&rect.height>0&&rect.left>=left&&rect.top>=top&&rect.right<=right&&rect.bottom<=bottom);
        return {visible,endRect:rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}:null,
          errorCount:document.querySelectorAll('.mobile-conversation-error[role="alert"]').length,
          errors:[...document.querySelectorAll('.mobile-conversation-error[role="alert"]')].map(e=>e.textContent),
          endMarkCount:ends.length,streamMarkCount:latest?.querySelectorAll('.response-stream-mark').length||0,
          activityCount:latest?.querySelectorAll('.turn-activity').length||0,
          animationInspectionSupported:supported,activeEndAnimations:animations.filter(a=>a.playState==='running'||a.pending).length,
          endStylesStatic:styles.length>0&&styles.every(s=>s.animationName==='none'),endStyles:styles,
          animationStates:animations.map(a=>a.playState),samplePerformanceMs:performance.now()};
    """.trimIndent())

    private fun touchSharedRetry(scenario: ActivityScenario<MainActivity>, evidence: Evidence) {
        var p = JSONObject()
        waitUntil {
            p = probe(scenario, """
            const nodes = [...document.querySelectorAll('.turn[data-latest="true"] .message-actions button[aria-label="Retry"]')];
            if (nodes.length !== 1) return {visible:false,count:nodes.length};
            const button = nodes[0], r = button.getBoundingClientRect(), x = r.left + r.width/2, y = r.top + r.height/2;
            const hit = document.elementFromPoint(x,y), style = getComputedStyle(button);
            return {visible:!button.disabled && r.width>0 && r.height>0 && r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight &&
              style.visibility==='visible' && style.display!=='none' && (hit===button || button.contains(hit)),
              count:nodes.length,disabled:button.disabled,hitMatches:hit===button||button.contains(hit),x,y,cssWidth:innerWidth,cssHeight:innerHeight,label:button.getAttribute('aria-label')};
            """.trimIndent())
            lastObservedProbe = p
            p.optBoolean("visible")
        }
        assertTrue("Canonical Retry control must be uniquely visible and hit-testable: $p", p.optBoolean("visible"))
        val x = p.getDouble("screenX") + p.getDouble("x") * p.getDouble("nativeWidth") / p.getDouble("cssWidth")
        val y = p.getDouble("screenY") + p.getDouble("y") * p.getDouble("nativeHeight") / p.getDouble("cssHeight")
        evidence.json("retry-touch-${SystemClock.elapsedRealtime()}.json", p.put("controllerBeforeTouch", diagnosticUiProbe()).put("touchX", x).put("touchY", y).put("method", "Native MotionEvent touch; DOM used read-only"))
        val now = SystemClock.uptimeMillis()
        for ((action, time) in listOf(MotionEvent.ACTION_DOWN to now, MotionEvent.ACTION_UP to now + 60)) {
            val event = MotionEvent.obtain(now, time, action, x.toFloat(), y.toFloat(), 0)
            try { event.source = InputDevice.SOURCE_TOUCHSCREEN; instrumentation.sendPointerSync(event) }
            finally { event.recycle() }
        }
        instrumentation.waitForIdleSync()
    }

    /** Read-only DOM and native bounds; no bridge envelope, synthetic data or style mutation. */
    private fun probe(scenario: ActivityScenario<MainActivity>, body: String): JSONObject {
        val result = AtomicReference<JSONObject>()
        val latch = CountDownLatch(1)
        scenario.onActivity { activity ->
            val views = descendants(activity.window.decorView).filterIsInstance<WebView>()
            assertEquals("Exactly one original shared WebView expected", 1, views.size)
            val view = views.single()
            assertEquals(ConversationBridgePolicy.ENTRY, view.url)
            val bounds = Rect(); val position = IntArray(2); view.getLocationOnScreen(position)
            val nativeVisible = view.isShown && view.alpha > 0f && view.width > 0 && view.height > 0 && view.getGlobalVisibleRect(bounds) && bounds.width() > 0 && bounds.height() > 0
            view.evaluateJavascript("""
                (() => { try {
                  if (window!==window.top || location.href!==${JSONObject.quote(ConversationBridgePolicy.ENTRY)}) return JSON.stringify({visible:false,error:'wrong origin'});
                  return JSON.stringify((() => { $body })());
                } catch(e) { return JSON.stringify({visible:false,error:String(e)}); } })()
            """.trimIndent()) { encoded ->
                try {
                    val parsed = JSONObject(JSONArray("[$encoded]").getString(0))
                    parsed.put("nativeVisible", nativeVisible).put("visible", nativeVisible && parsed.optBoolean("visible"))
                        .put("nativeWidth", view.width).put("nativeHeight", view.height).put("screenX", position[0]).put("screenY", position[1])
                        .put("sampleElapsedMs", SystemClock.elapsedRealtime()).put("entry", view.url)
                    result.set(parsed)
                } catch (failure: Exception) { result.set(JSONObject().put("visible", false).put("error", failure.javaClass.simpleName)) }
                finally { latch.countDown() }
            }
        }
        assertTrue("WebView read callback timed out", latch.await(5, TimeUnit.SECONDS))
        return requireNotNull(result.get())
    }
    private fun waitForText(text: String) { waitUntil { ui.hasText(text) } }
    private fun waitUntil(predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (!predicate()) {
            if (SystemClock.elapsedRealtime() >= deadline) throw AssertionError("Condition timed out after 20000 ms at $currentStage")
            Thread.sleep(50)
        }
    }
    private fun descendants(v: View): List<View> = listOf(v) + if (v is ViewGroup) (0 until v.childCount).flatMap { descendants(v.getChildAt(it)) } else emptyList()
    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private inner class Evidence(apkHash: String) {
        private val directory = File(instrumentation.targetContext.cacheDir, "transport-normal-dispatch-evidence/${System.currentTimeMillis()}").apply { check(mkdirs()) }
        private val registered = linkedSetOf<File>()
        init { json("environment.json", JSONObject().put("apkSha256", apkHash).put("fixtureOnly", true).put("api", android.os.Build.VERSION.SDK_INT)
            .put("webView", WebView.getCurrentWebViewPackage()?.versionName).put("root", "Original MainActivity ClaudexApp")
            .put("fixtureSetup", "Application-owned factory before Activity/ViewModel construction; no state swaps or presentation seed")
            .put("disabledVmCollectors", JSONArray())
            .put("retainedCollectors", "Both normal ViewModel collectors, original Compose UI collectors and real repository socket/event processing")
            .put("testScheduler", "No Compose test rule, test dispatcher or ComposeTest APIs")
            .put("loginMethod", "Synthetic auth setup: fixed ACTION_SET_TEXT without focus/touch and original Continue ACTION_CLICK; physical login acceptance unproven")) }
        private fun file(name: String): File {
            require(name.matches(Regex("[a-zA-Z0-9._-]{1,120}")))
            val file = File(directory, name)
            check(registered.contains(file) || registered.size < 32)
            registered += file
            return file
        }
        fun environment(key: String, value: JSONObject) {
            val prior = JSONObject(file("environment.json").readText())
            json("environment.json", prior.put(key, value))
        }
        fun json(name: String, data: JSONObject) { val text = data.toString(2); check(text.toByteArray().size <= 256 * 1024); file(name).writeText(text) }
        fun screenshot(name: String, synchronizeWithNativeIdle: Boolean = true): JSONObject {
            check(Looper.myLooper() != Looper.getMainLooper()) { "Screenshot waits must run off-main" }
            if (synchronizeWithNativeIdle) instrumentation.waitForIdleSync()
            val started = SystemClock.elapsedRealtime()
            val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("Screenshot unavailable")
            val returned = SystemClock.elapsedRealtime()
            try { file(name).outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
            finally { bitmap.recycle() }
            check(file(name).length() in 1..2L * 1024 * 1024)
            return JSONObject().put("file", name).put("synchronization", if (synchronizeWithNativeIdle) "Native instrumentation idle before capture; no Compose test rule" else "UNSYNCHRONIZED raw diagnostic capture; no idle wait")
                .put("captureStartedElapsedMs", started)
                .put("captureReturnedElapsedMs", returned).put("fileSavedElapsedMs", SystemClock.elapsedRealtime())
        }
        fun exportRegisteredFilesOnly() {
            check(registered.sumOf { it.length() } <= 16L * 1024 * 1024)
            registered.filter { it.isFile }.forEach { source ->
                check(source.canonicalFile.parentFile == directory.canonicalFile)
                val bytes = source.readBytes()
                val chunk = 192 * 1024
                val chunks = maxOf(1, (bytes.size + chunk - 1) / chunk)
                repeat(chunks) { index ->
                    instrumentation.sendStatus(2, Bundle().apply {
                        putString("qa_file_name", "transport-normal-dispatch/${directory.name}/${source.name}")
                        putInt("qa_file_chunk", index); putInt("qa_file_chunks", chunks)
                        putString("qa_file_base64", Base64.encodeToString(bytes.copyOfRange(index * chunk, minOf(bytes.size, (index + 1) * chunk)), Base64.NO_WRAP))
                    })
                }
            }
        }
    }
}

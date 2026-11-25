package com.claudex.mobile

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.claudex.core.Connection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Ordinary dispatcher only: no Compose test rule, TestDispatcher, virtual clock, setContent,
 * VM state swap, injected repository state, direct login/logout, or collector cancellation.
 *
 * The instructions-only assertion is a genuine regression assertion, never an expected-pass
 * assertion of the current bug. Its failure is recorded independently, then server invalidation
 * and cleanup still execute. The entire JUnit case remains failed if any phase fails.
 */
@RunWith(AndroidJUnit4::class)
class ProductionAuthObserverContractTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val ui by lazy { NativeTransportUiDriver(instrumentation) }
    private val phases = JSONObject()
    private val failures = mutableListOf<String>()
    private var currentStage = "not-started"
    private val phaseNames = listOf("android-json-null-contract", "initial-instructions", "capture-original-lease", "unsent-draft",
        "instructions-only-regression", "server-invalidation", "collector-cleanup", "old-session-action-rejection", "no-reconnect-after-signout", "wire-contract")

    @Test fun normalCollectorsObserveInstructionsAndServerSignOut() {
        check(Looper.myLooper() != Looper.getMainLooper())
        phaseNames.forEach { phases.put(it, JSONObject().put("status", "NOT_RUN")) }
        val args = InstrumentationRegistry.getArguments()
        // The runner verifies signer, target digest, application type, exact case and clean storage.
        check(instrumentation is LoopbackFixtureRunner && !BuildConfig.DEMO_MODE)
        val app = instrumentation.targetContext.applicationContext as? LoopbackFixtureApplication
            ?: error("Pre-construction fixture Application missing")
        val report = JSONObject().put("fixtureOnly", true).put("baseline", "ca0c59ece72a489c0bed26f4f55396c088af74bf")
            .put("apkSha256", args.getString("expectedApkSha256")).put("runner", instrumentation.componentName.flattenToString())
            .put("root", "Original MainActivity/ClaudexApp").put("dispatcher", "Ordinary Android main; no Compose test scheduler")
            .put("collectorsDisabled", JSONArray()).put("phases", phases)
            .put("loginMethod", "Existing guarded fixed-credential accessibility setup; original LoginScreen Continue handler")
            .put("physicalLoginTouchAcceptance", false).put("http401Exercised", false).put("refreshExercised", false)
            .put("persistenceExercised", false).put("reloginExercised", false).put("explicitLogoutExercised", false)
            .put("filePickerOrExportExercised", false).put("rendererVisualAcceptance", false)
        var fixture: LoopbackAuthObserverFixture? = null
        var scenario: ActivityScenario<MainActivity>? = null
        var fatal: Throwable? = null
        val cleanupFailures = JSONArray()
        try {
            phase("android-json-null-contract") { record ->
                // Actual APK/framework JSON behavior; Maven org.json is only a JVM unit dependency.
                try {
                    val explicitNull = JSONObject().put("instructions", JSONObject.NULL)
                    val missing = WireCodec.snapshot(JSONObject().put("settings", JSONObject()), null)
                    val nullValue = WireCodec.snapshot(JSONObject().put("settings", explicitNull), null)
                    val literal = WireCodec.snapshot(JSONObject().put("settings", JSONObject().put("instructions", "null")), null)
                    record.put("api", android.os.Build.VERSION.SDK_INT)
                        .put("frameworkNullOptString", explicitNull.optString("instructions"))
                        .put("missingDecoded", missing.instructions).put("nullDecoded", nullValue.instructions)
                        .put("literalNullDecoded", literal.instructions)
                    check(missing.instructions.isEmpty() && nullValue.instructions.isEmpty())
                    check(literal.instructions == "null")
                } finally { WireCodec.clear() }
            }
            currentStage = "fixture-before-activity"
            val local = LoopbackAuthObserverFixture().also { fixture = it }
            onMain { app.installOnce(AppNativeApiFactory { NativeApi(local.origin, local.vault, local.client) }) }
            val launched = ActivityScenario.launch(MainActivity::class.java).also { scenario = it }
            val modelRef = AtomicReference<AppViewModel>()
            launched.onActivity { modelRef.set(ViewModelProvider(it)[AppViewModel::class.java]) }
            val vm = requireNotNull(modelRef.get())
            val repo = vm.repository as? RemoteRepository ?: error("Real RemoteRepository required")
            onMain {
                check(app.createdModels == 1 && vm.api.origin == local.origin && vm.api.client === local.client)
                check(vm.snapshot === repo.snapshot && vm.connection === repo.connection)
                check(!vm.signedIn.value && vm.api.session == null && vm.snapshot.value.conversations.isEmpty())
            }
            check(local.requestCount() == 0)

            currentStage = "original-login"
            await { ui.hasText("欢迎使用 Claudex") }
            ui.assertEnabled("继续", false)
            ui.syntheticLoginInput("邮箱地址", LoopbackAuthObserverFixture.EMAIL)
            ui.syntheticLoginContinue()
            await { ui.hasText("账户密码") }
            ui.syntheticLoginInput("账户密码", LoopbackAuthObserverFixture.PASSWORD)
            ui.syntheticLoginContinue()
            await { local.assertHealthy(); local.ready() && vm.connection.value is Connection.Connected && !vm.busy.value }
            await { ui.hasText("今天想探索什么？") }
            onMain {
                check(vm.api.authenticated.value && vm.signedIn.value)
                check(vm.api.session?.accountLabel == LoopbackAuthObserverFixture.EMAIL)
                check(vm.api.session?.refreshToken?.isNotBlank() == true)
                check(vm.snapshot.value.conversations.single().id == LoopbackAuthObserverFixture.CHAT)
            }
            report.put("loginAndRepositoryStart", "PASS").put("normalAuthCollectorProvedByLoginAlone", false)

            phase("initial-instructions") { record ->
                await { onMain { vm.instructions.value == LoopbackAuthObserverFixture.INSTRUCTIONS_A } }
                record.put("observed", onMain { vm.instructions.value }).put("source", "Real initial HTTPS snapshot")
            }

            var oldLease: ConversationLease? = null
            phase("capture-original-lease") { record ->
                ui.touch("打开侧边栏", description = true)
                ui.revealForTouch(LoopbackAuthObserverFixture.TITLE)
                ui.touch(LoopbackAuthObserverFixture.TITLE)
                await { ui.hasText(LoopbackAuthObserverFixture.TITLE) }
                await {
                    oldLease = onMain {
                        // Read-only capture of a lease created by the actual SharedConversationView.
                        // Never call beginConversationBridge and never change a field by reflection.
                        vm.javaClass.getDeclaredField("conversationLease").apply { isAccessible = true }.get(vm) as? ConversationLease
                    }
                    oldLease?.conversationId == LoopbackAuthObserverFixture.CHAT
                }
                onMain {
                    check(vm.acceptsConversationBridge(requireNotNull(oldLease)))
                    ConversationBridgePolicy.requireCurrentText(vm.snapshot.value.conversations.single(), LoopbackAuthObserverFixture.REPLY)
                }
                record.put("capture", "Read-only actual original-route lease; no direct lease construction")
                    .put("sessionGeneration", requireNotNull(oldLease).generation)
                    .put("validCopyPayloadBeforeInvalidation", true)
            }

            var draftWasObserved = false
            phase("unsent-draft") { record ->
                ui.input("消息输入框", LoopbackAuthObserverFixture.DRAFT, description = true)
                await { vm.draft.value == LoopbackAuthObserverFixture.DRAFT }
                draftWasObserved = true
                record.put("input", "Actual native composer; no send").put("nonemptyDraftObserved", true)
            }

            phase("instructions-only-regression") { record ->
                val before = vm.snapshot.value
                val revision = repo.featureUpdates.value
                local.instructionsOnlyThenBarrier()
                await { local.assertHealthy(); repo.featureUpdates.value == revision + 1 }
                val received = onMain { WireCodec.rawSettings?.optString("instructions") }
                check(received == LoopbackAuthObserverFixture.INSTRUCTIONS_B) { "Instructions snapshot was not ingested" }
                // A bounded positive wait after the real receive-order barrier; no data/clock forcing.
                val propagated = eventually(3_000) { onMain { vm.instructions.value == LoopbackAuthObserverFixture.INSTRUCTIONS_B } }
                record.put("receiveOrderBarrier", "service-changed seq 2 after instructions-only snapshot seq 1")
                    .put("wireInstructions", received).put("observerInstructions", onMain { vm.instructions.value })
                    .put("typedSnapshotEqual", before == vm.snapshot.value).put("typedSnapshotSameInstance", before === vm.snapshot.value)
                    .put("observationBudgetMs", 3_000).put("expected", LoopbackAuthObserverFixture.INSTRUCTIONS_B)
                    .put("forcedSnapshotOrThemeChange", false)
                check(propagated) { "Instructions-only snapshot reached WireCodec but not the normal ViewModel observer" }
            }

            // These independent phases run even if the instructions regression above fails.
            val generationBeforeInvalidation = vm.api.sessionGeneration
            val requestsBeforeInvalidation = local.requestCount()
            val connectionsBeforeInvalidation = local.connectionCount()
            phase("server-invalidation") { record ->
                local.invalidateFromServer()
                await { local.assertHealthy(); !vm.api.authenticated.value && vm.api.session == null }
                check(vm.api.sessionGeneration > generationBeforeInvalidation)
                record.put("stimulus", "Real WSS signed-out event seq 3")
                    .put("directVmLogoutOrApiClear", false).put("sessionGenerationAdvanced", true)
            }
            phase("collector-cleanup") { record ->
                await { !vm.signedIn.value && vm.snapshot.value.conversations.isEmpty() && vm.draft.value.isEmpty() &&
                    vm.attachments.value.isEmpty() && vm.conversationActions.value.isEmpty() }
                record.put("sessionDraftAndRepositoryCleared", true)
                val instructionsCleared = eventually(20_000) { onMain { vm.instructions.value.isEmpty() && WireCodec.rawSettings == null } }
                record.put("observedInstructionsAfterCleanup", onMain { vm.instructions.value })
                    .put("legacySettingsCleared", onMain { WireCodec.rawSettings == null })
                check(instructionsCleared) { "Instructions observer did not clear after server sign-out" }
                await { ui.hasText("欢迎使用 Claudex") }
                record.put("loginRouteVisible", true).put("signedIn", false).put("emptyRepository", true)
                    .put("emptyDraft", true).put("emptyInstructions", true).put("nonemptyDraftBeforeInvalidation", draftWasObserved)
                    .put("attachmentDeletionExercised", false).put("actionLockCleanupExercised", false)
                    .put("physicalCacheDeletionExercised", false)
                check(draftWasObserved) { "Cannot certify draft cleanup without the preceding nonempty native draft" }
            }
            phase("old-session-action-rejection") { record ->
                val captured = requireNotNull(oldLease) { "No original-route lease was captured" }
                val host = NoSideEffectHost()
                val before = local.requestCount()
                val rejected = runBlocking {
                    withTimeout(5_000) {
                        withContext(Dispatchers.Main.immediate) {
                            runCatching {
                                vm.dispatchConversationAction(captured, ConversationAction(captured.id, "stale-auth-observer-copy",
                                    ConversationActionType.COPY, JSONObject().put("text", LoopbackAuthObserverFixture.REPLY).toString()), host)
                            }.exceptionOrNull()
                        }
                    }
                }
                record.put("probe", "Direct native dispatch of valid COPY payload with captured old lease; not a stale WebView click")
                    .put("rejection", rejected?.javaClass?.name ?: JSONObject.NULL)
                    .put("rejectionMessage", rejected?.message ?: JSONObject.NULL).put("hostSideEffects", host.calls)
                    .put("additionalHttpRequests", local.requestCount() - before)
                check(rejected is IllegalArgumentException && rejected.message == "对话视图已失效") { "Old-session action did not fail at the session/view gate" }
                check(host.calls == 0 && local.requestCount() == before)
            }
            phase("no-reconnect-after-signout") { record ->
                val started = SystemClock.elapsedRealtime()
                do {
                    local.assertHealthy()
                    check(!vm.api.authenticated.value && !vm.signedIn.value && vm.api.session == null)
                    check(vm.snapshot.value.conversations.isEmpty() && vm.draft.value.isEmpty())
                    check(local.requestCount() == requestsBeforeInvalidation && local.connectionCount() == connectionsBeforeInvalidation) {
                        "HTTP request or new socket connection occurred after sign-out"
                    }
                    Thread.sleep(100)
                } while (SystemClock.elapsedRealtime() - started < 5_000)
                record.put("observedMs", SystemClock.elapsedRealtime() - started).put("minimumObservationMs", 5_000)
                    .put("newHttpRequests", 0).put("newSocketConnections", 0)
                    .put("scope", "Bounded five-second stability window, beyond the first reconnect delay")
            }
            phase("wire-contract") { record -> local.assertComplete(); record.put("exactHttpRequestCount", local.requestCount()) }
            if (failures.isNotEmpty()) fatal = AssertionError("Auth-observer contract failed: ${failures.joinToString("; ")}")
        } catch (error: Throwable) { fatal = error; report.put("fatal", failure(error)) }
        finally {
            fun cleanup(label: String, block: () -> Unit) {
                try { block() } catch (error: Throwable) {
                    cleanupFailures.put(JSONObject().put("action", label).put("failure", failure(error)))
                    val prior = fatal; if (prior == null) fatal = error else prior.addSuppressed(error)
                }
            }
            cleanup("capture-ledger-before-teardown") { report.put("transport", fixture?.evidence() ?: JSONObject.NULL) }
            cleanup("mark-fixture-closing") { fixture?.expectClose() }
            // Only real Activity/store teardown cancels VM scope; do not touch collector jobs.
            cleanup("finish-original-activity") { scenario?.close() }
            cleanup("close-loopback-resources") { fixture?.close() }
            report.put("lastStage", currentStage).put("cleanupFailures", cleanupFailures)
                .put("status", if (fatal == null && failures.isEmpty()) "PASS_CLIENT_AUTH_OBSERVER_CONTRACT" else "FAIL")
                .put("independentPhaseFailures", JSONArray(failures)).put("nativeTouchObservations", ui.hitEvidence())
                .put("nativeRevealObservations", ui.revealEvidence())
            fatal?.let { report.put("finalFailure", failure(it)) }
            cleanup("write-and-export-registered-report") { exportReport(report) }
        }
        fatal?.let { throw it }
    }

    private fun phase(name: String, block: (JSONObject) -> Unit) {
        currentStage = name
        val started = SystemClock.elapsedRealtime()
        val record = JSONObject().put("status", "RUNNING").put("startedElapsedMs", started)
        phases.put(name, record)
        try { block(record); record.put("status", "PASS") }
        catch (error: Throwable) {
            failures += "$name: ${error.message}"
            record.put("status", "FAIL").put("failure", failure(error))
        } finally { record.put("elapsedMs", SystemClock.elapsedRealtime() - started) }
    }
    private fun eventually(timeoutMs: Long, predicate: () -> Boolean): Boolean {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        do { if (predicate()) return true; Thread.sleep(50) } while (SystemClock.elapsedRealtime() < deadline)
        return predicate()
    }
    private fun await(predicate: () -> Boolean) {
        check(eventually(20_000, predicate)) { "Condition timed out at $currentStage after 20000 ms" }
    }
    private fun <T> onMain(block: () -> T): T {
        check(Looper.myLooper() != Looper.getMainLooper())
        val active = AtomicBoolean(true)
        val result = AtomicReference<Result<T>>()
        val done = CountDownLatch(1)
        Handler(Looper.getMainLooper()).post {
            if (!active.get()) return@post
            result.set(runCatching(block)); done.countDown()
        }
        val completed = done.await(5, TimeUnit.SECONDS); active.set(false)
        check(completed) { "Main-thread observation timed out" }
        return requireNotNull(result.get()).getOrThrow()
    }
    private class NoSideEffectHost : ConversationNativeActions {
        var calls = 0
        private fun forbidden(): Nothing { calls++; error("Stale action reached a native side effect") }
        override suspend fun confirm(title: String, message: String): Boolean = forbidden()
        override fun copy(text: String) { forbidden() }
        override suspend fun download(name: String, mime: String, bytes: ByteArray): String? = forbidden()
        override fun navigate(route: String) { forbidden() }
        override fun openLink(url: String) { forbidden() }
    }
    private fun failure(error: Throwable) = JSONObject().put("type", error.javaClass.name).put("message", error.message?.take(2_048))
        .put("stack", error.stackTraceToString().take(8_000))
    private fun exportReport(report: JSONObject) {
        val bytes = report.toString(2).toByteArray()
        check(bytes.size <= 256 * 1024) { "Bounded evidence report exceeded 256 KiB" }
        val directory = File(instrumentation.targetContext.cacheDir, "auth-observer-evidence/${System.currentTimeMillis()}")
        check(directory.mkdirs())
        val file = File(directory, "result.json")
        file.writeBytes(bytes)
        // Exactly this registered report; no scan or export of account/cache directories.
        instrumentation.sendStatus(2, Bundle().apply {
            putString("qa_file_name", "auth-observer/${directory.name}/result.json")
            putInt("qa_file_chunk", 0); putInt("qa_file_chunks", 1)
            putString("qa_file_base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        })
    }
}

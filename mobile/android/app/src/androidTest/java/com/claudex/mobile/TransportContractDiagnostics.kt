package com.claudex.mobile

import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import com.claudex.core.Conversation
import com.claudex.core.EventCursor
import com.claudex.core.Turn
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.ContinuationInterceptor

/** Bounded, read-only diagnostics shared by Compose-rule and ordinary-dispatch controls. */
internal object TransportContractDiagnostics {
    fun failure(t: Throwable) = JSONObject().put("type", t.javaClass.name).put("message", t.message?.take(2048))
        .put("stack", t.stackTraceToString().take(12_000)).put("stackTruncated", t.stackTraceToString().length > 12_000)

    fun repository(vm: AppViewModel?, repo: RemoteRepository?): JSONObject {
        if (vm == null) return JSONObject().put("available", false)
        return JSONObject().put("available", true).put("sampleElapsedMs", SystemClock.elapsedRealtime())
            .put("signedIn", vm.signedIn.value).put("busy", vm.busy.value).put("error", vm.error.value?.take(1024))
            .put("connectionClass", vm.connection.value.javaClass.name).put("draft", vm.draft.value.take(256))
            .put("conversationActions", JSONArray(vm.conversationActions.value.take(4)))
            .put("featureRevision", repo?.featureUpdates?.value)
            .put("lastSequence", runCatching { (field(requireNotNull(repo), "cursor") as EventCursor).lastSequence }.getOrNull())
            .put("conversation", vm.snapshot.value.conversations.singleOrNull { it.id == LoopbackTransportFixture.CHAT }?.let(::conversation) ?: JSONObject.NULL)
    }

    private fun conversation(c: Conversation) = JSONObject().put("id", c.id).put("mode", c.mode.wire).put("slim", c.slim)
        .put("providerId", c.providerId).put("model", c.model).put("activeBranchId", c.activeBranchId).put("branchVisit", c.branchVisit)
        .put("turnCount", c.turns.size).put("turns", JSONArray(c.turns.take(3).map(::turn)))
        .put("savedBranchCount", c.savedBranches.size).put("savedBranches", JSONArray(c.savedBranches.take(3).map { b ->
            JSONObject().put("id", b.id).put("visited", b.visited).put("turnCount", b.turns.size).put("turns", JSONArray(b.turns.take(3).map(::turn)))
        }))
    private fun turn(t: Turn) = JSONObject().put("id", t.id).put("status", t.status.name).put("prompt", t.prompt.take(256))
        .put("responseGroupId", t.responseGroupId).put("promptGroupId", t.promptGroupId).put("promptVersionId", t.promptVersionId)
        .put("itemCount", t.items.size).put("items", JSONArray(t.items.take(4).map { i ->
            JSONObject().put("id", i.id).put("type", i.type).put("text", i.text.take(2048)).put("textTruncated", i.text.length > 2048)
        }))
    private fun presentation(p: ConversationPresentation?) = p?.let { JSONObject().put("sending", it.sending).put("conversation", conversation(it.conversation)) } ?: JSONObject.NULL

    /** No ActivityScenario/Compose-idle wait: main-thread scheduling and JS callback share 5s bound. */
    fun ui(activity: MainActivity?): JSONObject {
        check(Looper.myLooper() != Looper.getMainLooper())
        if (activity == null) return JSONObject().put("available", false)
        val result = AtomicReference(JSONObject().put("available", false))
        val active = AtomicBoolean(true)
        val done = CountDownLatch(1)
        val started = SystemClock.elapsedRealtime()
        Handler(Looper.getMainLooper()).post {
            if (!active.get()) return@post
            try {
                val views = descendants(activity.window.decorView).filterIsInstance<WebView>()
                val native = JSONObject().put("available", true).put("webViewCount", views.size)
                    .put("activityFinishing", activity.isFinishing).put("activityDestroyed", activity.isDestroyed)
                    .put("nativeReadThread", Thread.currentThread().name).put("nativeReadOnMain", Looper.myLooper() == Looper.getMainLooper())
                result.set(native)
                if (views.size != 1) { done.countDown(); return@post }
                val view = views.single()
                val bounds = Rect()
                native.put("webViewIdentity", System.identityHashCode(view)).put("url", view.url).put("nativeWidth", view.width).put("nativeHeight", view.height)
                    .put("nativeVisible", view.isShown && view.getGlobalVisibleRect(bounds)).put("nativeBounds", bounds.toShortString())
                val captures = view.webViewClient.javaClass.declaredFields.filter { ConversationWebController::class.java.isAssignableFrom(it.type) }
                native.put("controllerCount", captures.size)
                if (captures.size == 1) {
                    val controller = captures.single().apply { isAccessible = true }.get(view.webViewClient)
                    val state = JSONObject().put("identity", System.identityHashCode(controller))
                        .put("leaseId", (field(controller, "lease") as ConversationLease).id)
                    listOf("ready", "broken", "disposed", "revision", "appliedRevision", "lastSent", "flushScheduled").forEach { name ->
                        state.put(name, runCatching { field(controller, name) }.getOrElse { it.javaClass.simpleName })
                    }
                    val scope = field(controller, "scope") as CoroutineScope
                    val job = scope.coroutineContext[Job]
                    state.put("scopeInterceptor", scope.coroutineContext[ContinuationInterceptor]?.javaClass?.name)
                        .put("scopeJobActive", job?.isActive).put("scopeJobCancelled", job?.isCancelled)
                        .put("scopeJobCompleted", job?.isCompleted)
                        .put("pending", presentation(field(controller, "pending") as? ConversationPresentation))
                        .put("applied", presentation(field(controller, "applied") as? ConversationPresentation))
                    val flight = field(controller, "inFlight") as? Pair<*, *>
                    state.put("inFlightRevision", flight?.first ?: JSONObject.NULL)
                        .put("inFlight", presentation(flight?.second as? ConversationPresentation))
                        .put("requestJobCount", (field(controller, "jobs") as Map<*, *>).size)
                    native.put("controller", state)
                }
                if (view.url != ConversationBridgePolicy.ENTRY) { native.put("domSkipped", "not exact packaged entry"); done.countDown(); return@post }
                view.evaluateJavascript("""
                    (()=>JSON.stringify({url:location.href,readyState:document.readyState,
                      bodyText:(document.body?.innerText||'').slice(0,4096),
                      bodyPresent:!!document.body,rootHeight:document.getElementById('root')?.getBoundingClientRect().height||0,
                      latestTurns:[...document.querySelectorAll('.turn[data-latest="true"]')].slice(0,3).map(t=>({
                        text:t.innerText.slice(0,4096),markdown:[...t.querySelectorAll('.markdown')].slice(0,4).map(m=>({
                          text:m.textContent.slice(0,2048),rect:{left:m.getBoundingClientRect().left,top:m.getBoundingClientRect().top,
                          right:m.getBoundingClientRect().right,bottom:m.getBoundingClientRect().bottom},
                          display:getComputedStyle(m).display,visibility:getComputedStyle(m).visibility,opacity:getComputedStyle(m).opacity}))})),
                      sharedApiPresent:typeof window.ClaudexConversation==='object'}))()
                """.trimIndent()) { encoded ->
                    if (active.get()) {
                        try { native.put("dom", JSONObject(JSONArray("[$encoded]").getString(0))) }
                        catch (failure: Throwable) { native.put("domError", TransportContractDiagnostics.failure(failure)) }
                        native.put("probeCallbackThread", Thread.currentThread().name)
                            .put("probeCallbackOnMain", Looper.myLooper() == Looper.getMainLooper())
                            .put("threadObservationScope", "This read-only evaluateJavascript callback; private result() invocation thread is not traced")
                    }
                    done.countDown()
                }
            } catch (failure: Throwable) { result.get().put("probeFailure", TransportContractDiagnostics.failure(failure)); done.countDown() }
        }
        val completed = done.await(5, TimeUnit.SECONDS)
        active.set(false)
        return result.get().put("completed", completed).put("timeoutMs", 5_000).put("startedElapsedMs", started)
            .put("returnedElapsedMs", SystemClock.elapsedRealtime()).put("synchronization", "No Compose idle wait; read-only main-thread/JS observation")
    }
    private fun descendants(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until minOf(view.childCount, 128)).flatMap { descendants(view.getChildAt(it)) }.take(128) else emptyList()
    private fun field(target: Any, name: String): Any? = target.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(target)
}

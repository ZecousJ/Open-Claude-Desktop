package com.claudex.mobile

import com.claudex.core.*
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.*

class NativeApiTest {
    class MemoryVault(var value: Session? = null): CredentialStore { override fun save(session: Session) { value = session }; override fun load() = value; override fun clear() { value = null } }
    private fun tokens(access: String = "new-access", refresh: String = "new-refresh") = """{"code":0,"data":{"access_token":"$access","refresh_token":"$refresh","expires_in":3600,"user":{"email":"test@example.com"}}}"""
    private fun oldSession(expired: Boolean = true) = Session("old-access", "old-refresh", if (expired) 0 else System.currentTimeMillis() + 3_600_000, "old@example.com")
    private fun client(handler: (Request) -> Pair<Int, String>) = OkHttpClient.Builder().addInterceptor { chain -> val (status, body) = handler(chain.request()); Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("test").body(body.toResponseBody("application/json".toMediaType())).build() }.build()
    @Test fun refreshIsSingleFlightAndRotatesSecureRecord() = runBlocking {
        val refreshes = AtomicInteger(); val vault = MemoryVault(oldSession())
        val api = NativeApi("https://example.test", vault, client { request -> if (request.url.encodedPath.endsWith("refresh")) { refreshes.incrementAndGet(); Thread.sleep(60); 200 to tokens() } else { assertEquals("Bearer new-access", request.header("Authorization")); 200 to "{\"ok\":true}" } })
        coroutineScope { (1..12).map { async { api.request("/api/v1/test", authorized = true) } }.awaitAll() }
        assertEquals(1, refreshes.get()); assertEquals("new-refresh", vault.value?.refreshToken)
    }
    @Test fun logoutDuringRefreshRejectsStaleResponseAndDoesNotRestoreVault() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val vault = MemoryVault(oldSession())
        val api = NativeApi("https://example.test", vault, client { entered.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); 200 to tokens() })
        val pending = async(Dispatchers.Default) { runCatching { api.request("/api/v1/test", authorized = true) } }
        assertTrue(entered.await(3, TimeUnit.SECONDS)); api.clear(); release.countDown()
        assertTrue(pending.await().isFailure); assertNull(api.session); assertNull(vault.value)
    }
    @Test fun earlierLoginCannotOverwriteLaterAccount() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val count = AtomicInteger(); val vault = MemoryVault()
        val api = NativeApi("https://example.test", vault, client { if (count.incrementAndGet() == 1) { entered.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); 200 to tokens("first", "first-refresh") } else 200 to tokens("second", "second-refresh") })
        val first = async(Dispatchers.Default) { runCatching { api.login("first@example.com", "temporary") } }
        assertTrue(entered.await(3, TimeUnit.SECONDS)); api.login("second@example.com", "temporary"); release.countDown()
        assertTrue(first.await().isFailure); assertEquals("second", vault.value?.accessToken)
    }
    @Test fun refreshMissingRotatedTokenFailsClosed() = runBlocking { val vault = MemoryVault(oldSession()); val api = NativeApi("https://example.test", vault, client { 200 to tokens(refresh = "") }); assertFailsWith<ApiException> { api.request("/api/v1/test", authorized = true) }; assertNull(vault.value); assertNull(api.session) }
    @Test fun explicit401RefreshesThenRetriesOnlyOnce() = runBlocking {
        val calls = AtomicInteger(); val vault = MemoryVault(oldSession(false)); val api = NativeApi("https://example.test", vault, client { request -> if (request.url.encodedPath.endsWith("refresh")) 200 to tokens() else if (calls.incrementAndGet() == 1) 401 to "{\"message\":\"expired\"}" else 200 to "{\"ok\":true}" })
        api.request("/api/v1/test", authorized = true); assertEquals(2, calls.get()); assertEquals("new-refresh", vault.value?.refreshToken)
    }
    @Test fun rpcNon2xxPreservesStructuredCodeAndMessage() = runBlocking { val api = NativeApi("https://example.test", MemoryVault(oldSession(false)), client { 503 to """{"ok":false,"error":{"code":"CLAUDEX_WEB_CAPACITY","message":"Runner busy"}}""" }); val e = assertFailsWith<ApiException> { api.request("/api/v1/test", authorized = true) }; assertEquals("CLAUDEX_WEB_CAPACITY", e.code); assertEquals(UserText.get(R.string.claudex_msg_service_busy), e.message) }
    @Test fun nativeCallsDoNotSpoofBrowserOriginOrClientHeaders() = runBlocking { val api = NativeApi("https://example.test", MemoryVault(oldSession(false)), client { request -> assertNull(request.header("Origin")); assertNull(request.header("X-Claudex-Client")); assertNull(request.header("X-Claudex-Web")); assertNotNull(request.header("X-Claudex-Web-Tab")); 200 to "{\"ok\":true}" }); api.request("/api/v1/test", authorized = true); Unit }
    @Test fun transportTimeoutDoesNotReplayMutation() = runBlocking { val calls = AtomicInteger(); val client = OkHttpClient.Builder().addInterceptor { calls.incrementAndGet(); throw IOException("timeout after send") }.build(); val api = NativeApi("https://example.test", MemoryVault(oldSession(false)), client); assertFailsWith<IOException> { api.request("/api/v1/claudex/web/rpc/send", JSONObject(), true) }; assertEquals(1, calls.get()) }
    @Test fun missingMobileTicketRouteIsTerminalAndSnapshotRemainsReadable() = runBlocking {
        val api = NativeApi("https://example.test", MemoryVault(oldSession(false)), client { request -> when { request.url.encodedPath.endsWith("snapshot") -> 200 to """{"ok":true,"value":{"conversations":[],"projects":[],"settings":{},"engine":{"state":"ready"}}}"""; request.url.encodedPath.endsWith("modelCatalog") -> 200 to "{\"ok\":true,\"value\":null}"; else -> 404 to "{\"message\":\"not found\"}" } })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default); val repo = RemoteRepository(api, scope); repo.start(); assertIs<com.claudex.core.Connection.Error>(repo.connection.value); assertEquals("ready", repo.snapshot.value.engine); scope.cancel()
    }
    @Test fun requiredHelloPresenceFieldsAndStrictSequence() {
        val hello = EventMessages.hello("tab", 5); assertEquals(5L, hello.getLong("lastSeq")); assertEquals(1, hello.getInt("v"))
        val presence = EventMessages.presence(true, true); assertTrue(presence.getBoolean("visible")); assertTrue(presence.getBoolean("focused"))
        assertEquals(4L, EventMessages.sequence(JSONObject().put("seq", 4)))
        listOf(-1, 1.5, "4").forEach { value -> assertFails { EventMessages.sequence(JSONObject().put("seq", value)) } }
    }
    @Test fun realTurnItemShapeAndProjectUnknownFieldsArePreserved() {
        val turn = WireCodec.turn(JSONObject("""{"id":"t","prompt":"Hello","attachments":[],"items":[{"id":"i","type":"agentMessage","text":"World"}],"status":"completed","createdAt":0}""")); assertEquals("Hello", turn.prompt); assertEquals("World", turn.items.first().text)
        val project = WireCodec.project(JSONObject("""{"id":"p","name":"P","description":"D","instructions":"I","createdAt":0,"environment":{"kind":"ssh","id":"remote"},"cwd":"/work"}""")); val roundTrip = WireCodec.project(project.copy(name = "New")); assertEquals("/work", roundTrip.getString("cwd")); assertEquals("ssh", roundTrip.getJSONObject("environment").getString("kind"))
    }
    @Test fun queuedAuthorizedMutationNeverBorrowsNewAccountToken() = runBlocking {
        for (refreshStatus in listOf(200, 401)) {
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val mutationCalls = AtomicInteger(); val vault = MemoryVault(oldSession())
            val api = NativeApi("https://example.test", vault, client { request -> when {
                request.url.encodedPath.endsWith("/auth/refresh") -> { entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); refreshStatus to if (refreshStatus == 200) tokens("old-rotated", "old-refresh-rotated") else "{\"message\":\"expired\"}" }
                request.url.encodedPath.endsWith("/auth/login") -> 200 to tokens("account-b", "account-b-refresh")
                else -> { mutationCalls.incrementAndGet(); 200 to "{\"ok\":true}" }
            } })
            try {
                val refresh = async(Dispatchers.Default) { runCatching { api.request("/api/v1/first", authorized = true) } }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val queued = async(start = CoroutineStart.UNDISPATCHED) { runCatching { api.request("/api/v1/claudex/web/rpc/resetMemory", JSONObject().put("args", org.json.JSONArray(listOf(JSONObject().put("kind", "global")))), true) } }
                api.login("b@example.test", "temporary"); release.countDown()
                assertTrue(refresh.await().isFailure); assertTrue(queued.await().isFailure)
                assertEquals(0, mutationCalls.get()); assertEquals("account-b", api.session?.accessToken); assertEquals("account-b-refresh", vault.value?.refreshToken)
            } finally { release.countDown(); api.client.dispatcher.executorService.shutdownNow() }
        }
    }
    @Test fun delayedOldAccount401DoesNotReplayOrClearNewSession() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val calls = AtomicInteger()
        val api = NativeApi("https://example.test", MemoryVault(oldSession(false)), client { request ->
            if (request.url.encodedPath.endsWith("/auth/login")) 200 to tokens("account-b", "account-b-refresh")
            else { calls.incrementAndGet(); assertEquals("Bearer old-access", request.header("Authorization")); entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); 401 to "{\"message\":\"expired\"}" }
        })
        try {
            val pending = async(Dispatchers.Default) { runCatching { api.request("/api/v1/claudex/web/rpc/deleteSchedule", JSONObject(), true) } }
            assertTrue(entered.await(5, TimeUnit.SECONDS)); api.login("b@example.test", "temporary"); release.countDown()
            assertTrue(pending.await().isFailure); assertEquals(1, calls.get()); assertEquals("account-b", api.session?.accessToken)
        } finally { release.countDown(); api.client.dispatcher.executorService.shutdownNow() }
    }
    @Test fun multiRequestWorkflowKeepsInitiatingAccountAcrossChunkBoundary() = runBlocking {
        for (nextPath in listOf("/api/v1/claudex/web/uploads/old-upload/chunks/0", "/api/v1/claudex/web/rpc/addAttachmentData", "/api/v1/claudex/web/rpc/send")) {
        val calls = mutableListOf<Pair<String, String?>>()
        val api = NativeApi("https://example.test", MemoryVault(oldSession(false)), client { request ->
            calls += request.url.encodedPath to request.header("Authorization")
            if (request.url.encodedPath.endsWith("/auth/login")) 200 to tokens("account-b", "account-b-refresh") else 200 to "{\"ok\":true}"
        })
        try {
            assertFailsWith<ApiException> {
                api.withCurrentSession {
                    api.request("/api/v1/claudex/web/uploads", JSONObject(), true)
                    api.login("b@example.test", "temporary")
                    api.request(nextPath, authorized = true, method = if (nextPath.contains("chunks")) "PUT" else "POST", raw = byteArrayOf(1, 2, 3))
                }
            }
            assertEquals(2, calls.size); assertEquals("Bearer old-access", calls.first().second); assertEquals("account-b", api.session?.accessToken)
        } finally { api.client.dispatcher.executorService.shutdownNow() }
        }
    }
    @Test fun multiRequestWorkflowAllowsSameAccountTokenRotation() = runBlocking {
        val calls = AtomicInteger()
        val api = NativeApi("https://example.test", MemoryVault(oldSession()), client { request ->
            if (request.url.encodedPath.endsWith("/auth/refresh")) 200 to tokens() else { assertEquals("Bearer new-access", request.header("Authorization")); calls.incrementAndGet(); 200 to "{\"ok\":true}" }
        })
        try { api.withCurrentSession { api.request("/api/v1/one", authorized = true); api.request("/api/v1/two", authorized = true) }; assertEquals(2, calls.get()) }
        finally { api.client.dispatcher.executorService.shutdownNow() }
    }
}

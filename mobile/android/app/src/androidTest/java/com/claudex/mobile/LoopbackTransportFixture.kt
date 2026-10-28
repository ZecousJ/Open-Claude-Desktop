package com.claudex.mobile

import com.claudex.core.CredentialStore
import com.claudex.core.Session
import okhttp3.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/** AndroidTest-only, in-memory client-contract server. It is not a deployed Claudex backend. */
internal class LoopbackTransportFixture(private val rejectFirstRetry: Boolean = false) : Closeable {
    companion object {
        const val HOST = "android-transport-fixture.invalid"
        const val CHAT = "fixture-transport-chat"
        const val TITLE = "Fixture Transport Chat"
        const val PROVIDER = "fixture-provider"
        const val MODEL = "fixture-model"
        const val PROMPT = "Client transport fixture prompt"
        const val FIRST_TURN = "fixture-send-turn"
        const val RETRY_TURN = "fixture-retry-turn"
        const val DELTA_ONE = "Loopback"
        const val DELTA_TWO = "Loopback stream"
        const val FIRST_FINAL = "Loopback stream complete"
        const val RETRY_DELTA = "Loopback retry"
        const val RETRY_FINAL = "Loopback retry complete"
        const val RETRY_FAILURE = "Fixture retry rejected before execution"
        const val REPLAY_POISON = "Unexpected replay overwrite"
        const val EMAIL = "fixture@example.invalid"
        const val PASSWORD = "fixture-only-password"
        private const val ACCESS = "synthetic-loopback-access"
        private const val TICKET = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val RPC = "/api/v1/claudex/web/rpc/"
        private const val EVENTS = "/api/v1/claudex/web/events"
        private const val TICKET_PATH = "/api/v1/claudex/mobile/events-ticket"
        private const val LOGIN = "/api/v1/auth/login"
        private const val TIME = 1_791_000_000_000L
        private val paths = setOf(LOGIN, TICKET_PATH, EVENTS, RPC + "snapshot", RPC + "modelCatalog", RPC + "send", RPC + "retryResponse")
    }

    private val lock = Any()
    private val failures = mutableListOf<String>()
    private val calls = mutableListOf<JSONObject>()
    private val outbound = mutableListOf<JSONObject>()
    private val inbound = mutableListOf<JSONObject>()
    private val connections = mutableListOf<JSONObject>()
    private val counts = mutableMapOf<String, Int>()
    private var tab: String? = null
    private var socket: WebSocket? = null
    private var helloSeen = false
    private var presenceSeen = false
    private var closing = false
    private var sequence = 0L
    private var conversation = emptyConversation()
    private val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
    private val certificate = HeldCertificate.Builder().commonName(HOST).addSubjectAlternativeName(HOST)
        .duration(1, TimeUnit.HOURS).build()
    private val serverCertificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
    // Deliberately no platform roots, insecure trust manager, or permissive hostname verifier.
    private val clientCertificates = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    private val server = MockWebServer()
    val origin: String
    val client: OkHttpClient
    val vault = object : CredentialStore {
        private var value: Session? = null
        override fun load(): Session? = synchronized(lock) { value }
        override fun save(session: Session) = synchronized(lock) {
            check(session.accessToken == ACCESS && session.accountLabel == EMAIL)
            value = session
        }
        override fun clear() = synchronized(lock) { value = null }
    }

    init {
        check(loopback.isLoopbackAddress)
        server.bodyLimit = 16 * 1024
        server.protocols = listOf(Protocol.HTTP_1_1)
        server.useHttps(serverCertificates.sslSocketFactory(), false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = synchronized(lock) {
                try { handle(request) } catch (failure: Exception) {
                    failures += "Rejected request: ${failure.message}"
                    MockResponse().setResponseCode(403).setHeader("Content-Type", "application/json")
                        .setBody(JSONObject().put("ok", false).put("error", JSONObject().put("code", "FIXTURE_DENIED").put("message", "Fixture contract mismatch")).toString())
                }
            }
        }
        server.start(loopback, 0)
        origin = "https://$HOST:${server.port}"
        client = OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> {
                    if (hostname != HOST) { recordFailure("DNS denied non-fixture hostname"); throw UnknownHostException("Only fixture DNS is allowed") }
                    return listOf(loopback)
                }
            })
            .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager)
            .protocols(listOf(Protocol.HTTP_1_1))
            .followRedirects(false).followSslRedirects(false)
            // Keep OkHttp's normal retryOnConnectionFailure default; exact mutation count is asserted.
            .connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .eventListener(object : EventListener() {
                override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
                    val allowed = inetSocketAddress.address?.isLoopbackAddress == true &&
                        inetSocketAddress.port == server.port && proxy == Proxy.NO_PROXY
                    synchronized(lock) {
                        connections += JSONObject().put("address", inetSocketAddress.address?.hostAddress)
                            .put("port", inetSocketAddress.port).put("loopback", allowed)
                    }
                    if (!allowed) { recordFailure("Non-loopback socket route denied"); throw IOException("Only loopback socket routes are allowed") }
                }
            })
            .addInterceptor { chain ->
                val request = chain.request()
                val u = request.url
                if (!u.isHttps || u.host != HOST || u.port != server.port || u.username.isNotEmpty() || u.password.isNotEmpty() ||
                    u.query != null || u.fragment != null || u.encodedPath !in paths ||
                    request.method != if (u.encodedPath == EVENTS) "GET" else "POST") {
                    recordFailure("Outbound allowlist rejected request")
                    throw IOException("Fixture destination or request is not allowlisted")
                }
                // Only the exact loopback-bound TLS server may receive an allowed request.
                chain.proceed(request)
            }.build()
    }

    private fun handle(request: RecordedRequest): MockResponse {
        val path = requireNotNull(request.path)
        require(path in paths && request.getHeader("Host") == "$HOST:${server.port}")
        require(request.handshake != null) { "Every request must use TLS" }
        require(request.method == if (path == EVENTS) "GET" else "POST")
        require(request.bodySize <= 16 * 1024)
        require(calls.size < 24) { "Request budget exceeded" }
        val n = (counts[path] ?: 0) + 1
        counts[path] = n
        val allowedCount = when (path) {
            RPC + "snapshot", RPC + "modelCatalog" -> 2
            RPC + "retryResponse" -> if (rejectFirstRetry) 2 else 1
            else -> 1
        }
        require(n <= allowedCount) { "Repeated or unexpected request for $path" }
        val body = if (path == EVENTS) JSONObject() else JSONObject(request.body.clone().readUtf8())
        val isAuthorized = path != LOGIN && path != EVENTS
        require(request.getHeader("Authorization") == if (isAuthorized) "Bearer $ACCESS" else null)
        require(request.getHeader("Cookie") == null)
        if (path != EVENTS) {
            val sentTab = requireNotNull(request.getHeader("X-Claudex-Web-Tab"))
            require(sentTab.matches(Regex("[0-9a-f-]{36}")))
            if (tab == null) tab = sentTab else require(tab == sentTab)
        }
        val record = JSONObject().put("index", calls.size).put("method", request.method).put("path", path)
            .put("tls", request.handshake!!.tlsVersion.javaName).put("authMatchesSyntheticPolicy", true)
            .put("idempotencyKey", request.getHeader("Idempotency-Key") ?: JSONObject.NULL)
            .put("xIdempotencyKey", request.getHeader("X-Idempotency-Key") ?: JSONObject.NULL)
        // Credentials are never recorded, even though this fixture uses only synthetic values.
        if (path.startsWith(RPC)) record.put("body", JSONObject(body.toString()))
        calls += record
        return when (path) {
            LOGIN -> {
                require(keys(body) == setOf("email", "password") && body.getString("email") == EMAIL && body.getString("password") == PASSWORD)
                json(JSONObject().put("data", JSONObject().put("access_token", ACCESS).put("refresh_token", "")
                    .put("expires_in", 3600).put("user", JSONObject().put("email", EMAIL))))
            }
            TICKET_PATH -> {
                require(keys(body) == setOf("tabId") && body.getString("tabId") == tab)
                json(JSONObject().put("data", JSONObject().put("ticket", TICKET)))
            }
            EVENTS -> {
                require(request.getHeader("Sec-WebSocket-Protocol") == "claudex.v1, ticket.$TICKET")
                require(request.getHeader("X-Claudex-Web-Tab") == null)
                MockResponse().withWebSocketUpgrade(listener).setHeader("Sec-WebSocket-Protocol", "claudex.v1")
            }
            RPC + "snapshot" -> { requireEmptyArgs(body); rpc(snapshot()) }
            RPC + "modelCatalog" -> { requireEmptyArgs(body); rpc(catalog()) }
            RPC + "send" -> {
                val args = args(body); require(args.length() == 1)
                val p = args.getJSONObject(0)
                require(keys(p) == setOf("text", "mode", "providerId", "model", "attachments", "conversationId"))
                require(p.getString("text") == PROMPT && p.getString("mode") == "chat" && p.getString("providerId") == PROVIDER &&
                    p.getString("model") == MODEL && p.getString("conversationId") == CHAT && p.getJSONArray("attachments").length() == 0)
                require(helloSeen && presenceSeen && conversation.getJSONArray("turns").length() == 0)
                conversation.put("turns", JSONArray().put(turn(FIRST_TURN, "", "inProgress")))
                rpc(copy(conversation))
            }
            RPC + "retryResponse" -> {
                val args = args(body)
                require(args.toString() == JSONArray(listOf(CHAT, FIRST_TURN, PROVIDER, MODEL)).toString())
                val original = conversation.getJSONArray("turns").getJSONObject(0)
                require(original.getString("status") == "completed" && original.getJSONArray("items").getJSONObject(0).getString("text") == FIRST_FINAL)
                if (rejectFirstRetry && counts[RPC + "retryResponse"] == 1) {
                    calls.last().put("responseStatus", 422).put("rejectedBeforeMutation", true)
                    return MockResponse().setResponseCode(422).setHeader("Content-Type", "application/json")
                        .setBody(JSONObject().put("ok", false).put("error", JSONObject()
                            .put("code", "FIXTURE_RETRY_REJECTED").put("message", RETRY_FAILURE)).toString())
                }
                conversation.put("savedBranches", JSONArray().put(JSONObject().put("id", "fixture-first-branch").put("visited", 1).put("providerId", PROVIDER).put("model", MODEL).put("turns", JSONArray().put(copy(original)))))
                conversation.put("turns", JSONArray().put(turn(RETRY_TURN, "", "inProgress"))).put("activeBranchId", "fixture-retry-branch").put("branchVisit", 2)
                rpc(copy(conversation))
            }
            else -> error("Endpoint was not allowlisted")
        }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(lock) { socket = webSocket }
        override fun onMessage(webSocket: WebSocket, text: String) { synchronized(lock) {
            try {
                require(text.length <= 4096 && inbound.size < 16)
                val frame = JSONObject(text)
                when (frame.getString("t")) {
                    "hello" -> {
                        require(!helloSeen && keys(frame) == setOf("t", "v", "tabId") && frame.getInt("v") == 1 && frame.getString("tabId") == tab)
                        helloSeen = true
                        sendFrame(JSONObject().put("t", "ready").put("v", 1).put("seq", 0).put("resumed", false))
                    }
                    "presence" -> {
                        require(helloSeen && !presenceSeen && keys(frame) == setOf("t", "visible", "focused") && frame.getBoolean("visible") && frame.getBoolean("focused"))
                        presenceSeen = true
                    }
                    "ping" -> { require(keys(frame) == setOf("t")); sendFrame(JSONObject().put("t", "pong")) }
                    else -> error("Unallowlisted client WebSocket frame")
                }
                inbound += frame
            } catch (failure: Exception) { failures += "Rejected client WebSocket frame: ${failure.message}"; webSocket.close(4400, "fixture contract mismatch") }
        }
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            synchronized(lock) { if (!closing) failures += "WebSocket failure: ${t.javaClass.simpleName}" }
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            synchronized(lock) { if (!closing) failures += "Unexpected WebSocket close: $code" }
            webSocket.close(code, reason)
        }
    }

    /** Server stimulus only. Production state can change solely through its real HTTP/WSS parsing. */
    fun advance(turnId: String, text: String, completed: Boolean) = synchronized(lock) {
        val expected = when (sequence) {
            0L -> Triple(FIRST_TURN, DELTA_ONE, false)
            1L -> Triple(FIRST_TURN, DELTA_TWO, false)
            3L -> Triple(FIRST_TURN, FIRST_FINAL, true)
            4L -> Triple(RETRY_TURN, RETRY_DELTA, false)
            5L -> Triple(RETRY_TURN, RETRY_FINAL, true)
            else -> error("Unexpected fixture stage $sequence")
        }
        require(Triple(turnId, text, completed) == expected)
        val turns = conversation.getJSONArray("turns")
        require(turns.length() == 1 && turns.getJSONObject(0).getString("id") == turnId)
        val updated = turn(turnId, text, if (completed) "completed" else "inProgress")
        conversation.put("turns", JSONArray().put(updated))
        sendEvent(++sequence, JSONObject().put("type", "conversation-turn").put("conversationId", CHAT).put("turn", copy(updated)))
    }

    fun replayOldSequenceThenBarrier() = synchronized(lock) {
        require(sequence == 2L)
        // Deliberately stale whole-turn replacement must be ignored by the real EventCursor.
        sendEvent(1, JSONObject().put("type", "conversation-turn").put("conversationId", CHAT).put("turn", turn(FIRST_TURN, REPLAY_POISON, "inProgress")))
        // Real production featureUpdates supplies a receive-order barrier after the stale frame.
        sendEvent(++sequence, JSONObject().put("type", "service-changed"))
    }

    fun count(method: String): Int = synchronized(lock) { counts[RPC + method] ?: 0 }
    fun ready(): Boolean = synchronized(lock) { helloSeen && presenceSeen }
    fun assertHealthy() = synchronized(lock) { check(failures.isEmpty()) { failures.joinToString("; ") } }
    fun assertComplete() = synchronized(lock) {
        assertHealthy()
        check(sequence == 6L && conversation.getJSONArray("turns").getJSONObject(0).getString("status") == "completed")
        check(counts == mapOf(LOGIN to 1, RPC + "snapshot" to 2, RPC + "modelCatalog" to 2, TICKET_PATH to 1, EVENTS to 1, RPC + "send" to 1, RPC + "retryResponse" to (if (rejectFirstRetry) 2 else 1))) { "Unexpected request counts: $counts" }
        check(connections.isNotEmpty() && connections.all { it.getBoolean("loopback") })
    }
    fun evidence(): JSONObject = synchronized(lock) {
        JSONObject().put("scope", "Synthetic in-memory client-contract fixture; no deployed backend, persistence, model, account, quota, real authentication, picker or general idempotency certification")
            .put("origin", origin).put("certificateSubject", certificate.certificate.subjectX500Principal.name)
            .put("hostnameVerification", "OkHttp default; trust restricted to one ephemeral test certificate")
            .put("requests", JSONArray(calls.map(::copy))).put("socketRoutes", JSONArray(connections.map(::copy)))
            .put("clientFrames", JSONArray(inbound.map(::copy))).put("serverFrames", JSONArray(outbound.map(::copy)))
            .put("serverContractConversation", copy(conversation)).put("violations", JSONArray(failures))
            .put("sendCount", count("send")).put("explicitRetryCount", count("retryResponse"))
            .put("rejectFirstRetry", rejectFirstRetry)
            .put("idempotencyScope", if (rejectFirstRetry) "One send; first explicitly confirmed retry receives HTTP422 before mutation; second explicitly confirmed same-target retry succeeds. No server idempotency certification." else "Exactly one observed send and one user-confirmed retry; no server idempotency key contract exists in this client")
    }
    private fun sendEvent(seq: Long, event: JSONObject) = sendFrame(JSONObject().put("t", "event").put("seq", seq).put("event", event))
    private fun sendFrame(frame: JSONObject) {
        check(outbound.size < 24 && requireNotNull(socket).send(frame.toString()))
        outbound += copy(frame)
    }
    private fun recordFailure(message: String) = synchronized(lock) { failures += message }
    private fun keys(j: JSONObject): Set<String> = j.keys().asSequence().toSet()
    private fun copy(j: JSONObject) = JSONObject(j.toString())
    private fun args(j: JSONObject): JSONArray { require(keys(j) == setOf("args")); return j.getJSONArray("args") }
    private fun requireEmptyArgs(j: JSONObject) { require(args(j).length() == 0) }
    private fun json(value: JSONObject) = MockResponse().setHeader("Content-Type", "application/json; charset=utf-8").setBody(value.toString())
    private fun rpc(value: JSONObject) = json(JSONObject().put("ok", true).put("value", value))
    private fun turn(id: String, text: String, status: String) = JSONObject().put("id", id).put("prompt", PROMPT)
        .put("attachments", JSONArray()).put("status", status).put("createdAt", TIME + if (id == RETRY_TURN) 2 else 1)
        .put("responseGroupId", "fixture-response-group").put("promptGroupId", "fixture-prompt-group").put("promptVersionId", "fixture-prompt-version")
        .put("items", JSONArray().put(JSONObject().put("id", "$id-reply").put("type", "agentMessage").put("text", text)))
    private fun emptyConversation() = JSONObject().put("id", CHAT).put("title", TITLE).put("mode", "chat")
        .put("providerId", PROVIDER).put("model", MODEL).put("createdAt", TIME).put("updatedAt", TIME)
        .put("turns", JSONArray()).put("savedBranches", JSONArray()).put("slim", false).put("activeBranchId", "fixture-first-branch").put("branchVisit", 1)
    private fun catalog() = JSONObject().put("defaultModel", MODEL).put("items", JSONArray().put(JSONObject().put("id", MODEL).put("displayName", "Fixture Model").put("efforts", JSONArray())))
    private fun snapshot() = JSONObject().put("conversations", JSONArray().put(copy(conversation))).put("projects", JSONArray())
        .put("settings", JSONObject().put("activeProviderId", PROVIDER).put("providers", JSONArray().put(JSONObject().put("id", PROVIDER).put("model", MODEL).put("models", JSONArray().put(MODEL)))))
        .put("engine", JSONObject().put("state", "stopped"))

    fun expectClose() = synchronized(lock) { closing = true }

    override fun close() {
        // MockWebServer exposes a server-side RealWebSocket: cancel() is client-only and
        // dereferences a nonexistent Call. Graceful close plus server.shutdown owns its sockets.
        val serverSocket = synchronized(lock) { closing = true; val saved = socket; socket = null; vault.clear(); saved }
        var firstFailure: Throwable? = null
        fun cleanup(block: () -> Unit) {
            try { block() } catch (failure: Throwable) {
                val first = firstFailure
                if (first == null) firstFailure = failure else first.addSuppressed(failure)
            }
        }
        cleanup { serverSocket?.close(1000, "fixture finished") }
        cleanup { client.dispatcher.cancelAll() }
        cleanup { server.shutdown() }
        cleanup { client.connectionPool.evictAll() }
        cleanup { client.dispatcher.executorService.shutdown() }
        firstFailure?.let { throw it }
    }
}

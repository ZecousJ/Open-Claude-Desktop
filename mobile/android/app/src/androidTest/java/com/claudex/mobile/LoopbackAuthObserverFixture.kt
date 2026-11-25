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

/** Test-only, bounded real HTTPS/WSS contract; never a deployed backend or account. */
internal class LoopbackAuthObserverFixture : Closeable {
    companion object {
        const val HOST = "android-auth-observer-fixture.invalid"
        // Keep the existing guarded native driver's exact synthetic-login allowlist.
        const val EMAIL = LoopbackTransportFixture.EMAIL
        const val PASSWORD = LoopbackTransportFixture.PASSWORD
        const val CHAT = "auth-observer-chat"
        const val TITLE = "Auth Observer Fixture"
        const val REPLY = "Synthetic saved reply for stale-session guard"
        const val DRAFT = "Synthetic unsent draft before server sign-out"
        const val INSTRUCTIONS_A = "Synthetic initial instructions A"
        const val INSTRUCTIONS_B = "Synthetic instructions-only update B"
        private const val ACCESS = "synthetic-auth-observer-access"
        private const val REFRESH = "synthetic-auth-observer-refresh"
        private const val TICKET = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        private const val LOGIN = "/api/v1/auth/login"
        private const val SNAPSHOT = "/api/v1/claudex/web/rpc/snapshot"
        private const val CATALOG = "/api/v1/claudex/web/rpc/modelCatalog"
        private const val TICKET_PATH = "/api/v1/claudex/mobile/events-ticket"
        private const val EVENTS = "/api/v1/claudex/web/events"
        private const val PROVIDER = "auth-observer-provider"
        private const val MODEL = "auth-observer-model"
        private const val TIME = 1_791_000_000_000L
        private val exactCounts = mapOf(LOGIN to 1, SNAPSHOT to 2, CATALOG to 2, TICKET_PATH to 1, EVENTS to 1)
    }

    private val lock = Any()
    private val failures = mutableListOf<String>()
    private val requests = mutableListOf<JSONObject>()
    private val socketRoutes = mutableListOf<JSONObject>()
    private val outbound = mutableListOf<JSONObject>()
    private val inbound = mutableListOf<JSONObject>()
    private val counts = mutableMapOf<String, Int>()
    private var tab: String? = null
    private var socket: WebSocket? = null
    private var helloSeen = false
    private var presenceSeen = false
    private var closing = false
    private var stage = 0
    private var session: Session? = null
    private var saves = 0
    private var clears = 0
    private var instructions = INSTRUCTIONS_A
    private val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
    private val certificate = HeldCertificate.Builder().commonName(HOST).addSubjectAlternativeName(HOST)
        .duration(1, TimeUnit.HOURS).build()
    private val serverCertificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
    private val clientCertificates = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    private val server = MockWebServer()
    val origin: String
    val client: OkHttpClient
    val vault = object : CredentialStore {
        override fun load(): Session? = synchronized(lock) { session }
        override fun save(value: Session) = synchronized(lock) {
            check(value.accessToken == ACCESS && value.accountLabel == EMAIL && value.refreshToken == REFRESH)
            saves++
            // Mirrors production's requirement for a nonblank refresh value; no persistence claim.
            session = value.takeIf { it.refreshToken.isNotBlank() }
        }
        override fun clear() = synchronized(lock) { clears++; session = null }
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
                        .setBody("{\"ok\":false,\"error\":{\"code\":\"FIXTURE_DENIED\",\"message\":\"Fixture contract mismatch\"}}")
                }
            }
        }
        server.start(loopback, 0)
        origin = "https://$HOST:${server.port}"
        client = OkHttpClient.Builder().proxy(Proxy.NO_PROXY)
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> {
                    if (hostname != HOST) { reject("Non-fixture DNS"); throw UnknownHostException("Fixture DNS only") }
                    return listOf(loopback)
                }
            })
            .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager)
            .protocols(listOf(Protocol.HTTP_1_1)).followRedirects(false).followSslRedirects(false)
            .connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .eventListener(object : EventListener() {
                override fun connectStart(call: Call, address: InetSocketAddress, proxy: Proxy) {
                    val allowed = address.address?.isLoopbackAddress == true && address.port == server.port && proxy == Proxy.NO_PROXY
                    synchronized(lock) {
                        check(socketRoutes.size < 8)
                        socketRoutes += JSONObject().put("address", address.address?.hostAddress).put("port", address.port).put("loopback", allowed)
                    }
                    if (!allowed) { reject("Non-loopback socket route"); throw IOException("Fixture socket only") }
                }
            })
            .addInterceptor { chain ->
                val request = chain.request(); val url = request.url
                if (!url.isHttps || url.host != HOST || url.port != server.port || url.username.isNotEmpty() || url.password.isNotEmpty() ||
                    url.query != null || url.fragment != null || url.encodedPath !in exactCounts ||
                    request.method != if (url.encodedPath == EVENTS) "GET" else "POST") {
                    reject("Outbound route/method denied"); throw IOException("Fixture allowlist only")
                }
                chain.proceed(request)
            }.build()
    }

    private fun handle(request: RecordedRequest): MockResponse {
        val path = requireNotNull(request.path)
        require(path in exactCounts && request.getHeader("Host") == "$HOST:${server.port}")
        require(request.handshake != null && request.bodySize <= 16 * 1024 && requests.size < 7)
        require(request.method == if (path == EVENTS) "GET" else "POST")
        val count = (counts[path] ?: 0) + 1; counts[path] = count
        require(count <= exactCounts.getValue(path)) { "Unexpected repeated request" }
        val authorized = path !in setOf(LOGIN, EVENTS)
        require(request.getHeader("Authorization") == if (authorized) "Bearer $ACCESS" else null)
        require(request.getHeader("Cookie") == null)
        if (path != EVENTS) {
            val sent = requireNotNull(request.getHeader("X-Claudex-Web-Tab"))
            require(sent.matches(Regex("[0-9a-f-]{36}")))
            if (tab == null) tab = sent else require(tab == sent)
        }
        val body = if (path == EVENTS) JSONObject() else JSONObject(request.body.clone().readUtf8())
        // No request body/headers or credential values are written to evidence.
        requests += JSONObject().put("path", path).put("method", request.method)
            .put("tls", request.handshake!!.tlsVersion.javaName).put("syntheticAuthPolicyMatched", true)
        return when (path) {
            LOGIN -> {
                require(keys(body) == setOf("email", "password") && body.getString("email") == EMAIL && body.getString("password") == PASSWORD)
                json(JSONObject().put("data", JSONObject().put("access_token", ACCESS).put("refresh_token", REFRESH)
                    .put("expires_in", 3600).put("user", JSONObject().put("email", EMAIL))))
            }
            SNAPSHOT -> { emptyArgs(body); rpc(snapshot()) }
            CATALOG -> {
                emptyArgs(body)
                rpc(JSONObject().put("defaultModel", MODEL).put("items", JSONArray().put(JSONObject().put("id", MODEL)
                    .put("displayName", "Synthetic Fixture Model").put("efforts", JSONArray()))))
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
            else -> error("Unreachable fixture route")
        }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(lock) { socket = webSocket }
        override fun onMessage(webSocket: WebSocket, text: String) { synchronized(lock) {
            try {
                require(text.length <= 4096 && inbound.size < 12)
                val frame = JSONObject(text)
                when (frame.getString("t")) {
                    "hello" -> {
                        require(!helloSeen && keys(frame) == setOf("t", "v", "tabId") && frame.getInt("v") == 1 && frame.getString("tabId") == tab)
                        helloSeen = true
                        send(JSONObject().put("t", "ready").put("v", 1).put("seq", 0).put("resumed", false))
                    }
                    "presence" -> {
                        require(helloSeen && !presenceSeen && keys(frame) == setOf("t", "visible", "focused") && frame.getBoolean("visible") && frame.getBoolean("focused"))
                        presenceSeen = true
                    }
                    "ping" -> {
                        require(keys(frame) == setOf("t"))
                        // An already in-flight heartbeat can cross the intentional sign-out close.
                        // Keep validating/recording it without writing to a closing server socket.
                        if (!closing) send(JSONObject().put("t", "pong"))
                    }
                    else -> error("Unallowlisted client frame")
                }
                inbound += frame
            } catch (failure: Exception) { failures += "Rejected client frame: ${failure.message}"; webSocket.close(4400, "fixture mismatch") }
        } }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            synchronized(lock) { if (!closing) failures += "Unexpected socket failure: ${t.javaClass.simpleName}" }
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            synchronized(lock) { if (!closing) failures += "Unexpected socket close: $code" }
            webSocket.close(code, reason)
        }
    }

    /** Exact whole snapshot replacement: only settings.instructions differs. */
    fun instructionsOnlyThenBarrier() = synchronized(lock) {
        check(stage == 0 && ready())
        val before = snapshot(); instructions = INSTRUCTIONS_B; val after = snapshot()
        val normalized = copy(after).apply { getJSONObject("settings").put("instructions", INSTRUCTIONS_A) }
        check(before.toString() == normalized.toString()) { "Regression stimulus changed another field" }
        send(JSONObject().put("t", "snapshot").put("seq", 1).put("snapshot", after))
        send(event(2, "service-changed"))
        stage = 1
    }

    /** Real production WSS ingress -> repository expireSession -> NativeApi -> VM collector. */
    fun invalidateFromServer() = synchronized(lock) {
        check(stage == 1 && ready())
        closing = true // Client will close/cancel as a consequence of real session invalidation.
        send(event(3, "signed-out")); stage = 2
    }

    fun ready(): Boolean = synchronized(lock) { helloSeen && presenceSeen && counts == exactCounts }
    fun requestCount(): Int = synchronized(lock) { requests.size }
    fun connectionCount(): Int = synchronized(lock) { socketRoutes.size }
    fun assertHealthy() = synchronized(lock) { check(failures.isEmpty()) { failures.joinToString("; ") } }
    fun assertComplete() = synchronized(lock) {
        assertHealthy()
        check(stage == 2 && counts == exactCounts && saves == 1 && clears >= 1 && session == null)
        check(socketRoutes.isNotEmpty() && socketRoutes.all { it.getBoolean("loopback") })
    }
    fun evidence(): JSONObject = synchronized(lock) {
        JSONObject().put("scope", "Synthetic client auth-observer contract only")
            .put("requests", JSONArray(requests.map(::copy))).put("socketRoutes", JSONArray(socketRoutes.map(::copy)))
            .put("outboundFrames", JSONArray(outbound.map(::copy))).put("inboundFrames", JSONArray(inbound.map(::copy)))
            .put("violations", JSONArray(failures)).put("stage", stage).put("vaultSaves", saves).put("vaultClears", clears)
            .put("syntheticSessionPresent", session != null).put("refreshTokenNonblankInLogin", true)
            .put("refreshExercised", false).put("persistenceExercised", false).put("reloginExercised", false)
            .put("instructionsOnlyStimulus", true).put("hostnameVerification", "Default; only ephemeral fixture certificate trusted")
    }
    private fun snapshot(): JSONObject {
        val item = JSONObject().put("id", "auth-observer-item").put("type", "agentMessage").put("text", REPLY)
        val turn = JSONObject().put("id", "auth-observer-turn").put("prompt", "Synthetic stored prompt")
            .put("createdAt", TIME).put("status", "completed").put("attachments", JSONArray()).put("items", JSONArray().put(item))
        val conversation = JSONObject().put("id", CHAT).put("title", TITLE).put("mode", "chat").put("providerId", PROVIDER).put("model", MODEL)
            .put("createdAt", TIME).put("updatedAt", TIME).put("slim", false).put("savedBranches", JSONArray()).put("turns", JSONArray().put(turn))
        val provider = JSONObject().put("id", PROVIDER).put("model", MODEL).put("models", JSONArray().put(MODEL))
        return JSONObject().put("conversations", JSONArray().put(conversation)).put("projects", JSONArray())
            .put("settings", JSONObject().put("instructions", instructions).put("activeProviderId", PROVIDER).put("providers", JSONArray().put(provider)))
            .put("engine", JSONObject().put("state", "stopped"))
    }
    private fun event(seq: Long, type: String) = JSONObject().put("t", "event").put("seq", seq).put("event", JSONObject().put("type", type))
    private fun send(frame: JSONObject) { check(outbound.size < 16 && requireNotNull(socket).send(frame.toString())); outbound += copy(frame) }
    private fun reject(reason: String) = synchronized(lock) { failures += reason }
    private fun keys(value: JSONObject): Set<String> = value.keys().asSequence().toSet()
    private fun copy(value: JSONObject) = JSONObject(value.toString())
    private fun emptyArgs(value: JSONObject) { require(keys(value) == setOf("args") && value.getJSONArray("args").length() == 0) }
    private fun json(value: JSONObject) = MockResponse().setHeader("Content-Type", "application/json; charset=utf-8").setBody(value.toString())
    private fun rpc(value: JSONObject) = json(JSONObject().put("ok", true).put("value", value))
    fun expectClose() = synchronized(lock) { closing = true }
    override fun close() {
        val previous = synchronized(lock) { closing = true; val saved = socket; socket = null; session = null; saved }
        var failure: Throwable? = null
        fun cleanup(block: () -> Unit) { try { block() } catch (error: Throwable) { val first = failure; if (first == null) failure = error else first.addSuppressed(error) } }
        cleanup { previous?.close(1000, "fixture finished") }
        cleanup { client.dispatcher.cancelAll() }
        cleanup { server.shutdown() }
        cleanup { client.connectionPool.evictAll() }
        cleanup { client.dispatcher.executorService.shutdown() }
        failure?.let { throw it }
    }
}
